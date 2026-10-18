import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureCdrPartitions } from '@fs-billing/db';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  requestHeaders,
  type Fixture,
} from '../test/support.js';

const connections = apiConnections();
const { api } = fixtureApi(connections);
let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture(connections);
  await ensureCdrPartitions(connections.owner.db, { moment: new Date() });
});

describe('admin CDR export endpoint', () => {
  it('streams unverified status and commits one acceptance audit with normalized filters', async () => {
    const answeredAt = new Date();
    const startedAt = new Date(answeredAt.getTime() - 60_000);
    await connections.owner.pool.query(
      `insert into public.cdrs
        (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
         billing_number, duration_seconds, billed_minutes, matched_prefix, country,
         rate, charge, hangup_cause, unverified)
       values ($1,$2,$3,$4,$5,'1001','+86 138-0013 8001','8613800138001',
         60,1,'86','中国',123456789012345678901234567890.1234,
         0.123456789012345678901234,'NORMAL_CLEARING',true)`,
      [
        fixture.a.tenantId,
        randomUUID(),
        startedAt,
        answeredAt,
        new Date(answeredAt.getTime() + 60_000),
      ],
    );
    const day = new Date(answeredAt.getTime() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const session = await login(api, fixture.admin);
    const response = await api.inject({
      method: 'POST',
      url: `/api/admin/tenants/${fixture.a.tenantId}/cdrs/export`,
      headers: requestHeaders(session.cookie),
      payload: {
        from: `${day.slice(0, 7)}-01`,
        to: day,
        callee: '+86 138-0013 8001',
        unverifiedOnly: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('验证状态');
    expect(response.body).toContain('未经验证');
    expect(response.body).toContain("'+86 138-0013 8001");
    expect(response.body).toContain('123456789012345678901234567890.1234');
    expect(response.body).toContain('0.123456789012345678901234');

    const audit = await connections.owner.pool.query<{
      details: {
        content: { rowCount: number; filters: Record<string, unknown> };
      };
    }>(
      `select details from public.operation_logs
       where tenant_id = $1 and action = 'cdr_export' order by created_at desc limit 1`,
      [fixture.a.tenantId],
    );
    expect(audit.rows[0]?.details.content).toMatchObject({
      rowCount: 1,
      filters: {
        from: `${day.slice(0, 7)}-01`,
        to: day,
        status: 'answered',
        callee: '8613800138001',
        unverifiedOnly: true,
      },
    });
  });
});
