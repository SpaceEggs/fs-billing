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

it('exports ISO, country and description separately, neutralizes formulas, and labels unanswered only in country', async () => {
  const tenantId = fixture.a.tenantId;
  const at = new Date();
  await connections.owner.pool.query(
    `insert into public.cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee, billing_number, duration_seconds, billed_minutes, matched_prefix, iso, country, description, rate, charge, hangup_cause) values
    ($1,gen_random_uuid(),$2,$2,$2,'1001','447700900123','447700900123',0,0,'447','GB','英国','=1+1',0.045,0,'NORMAL_CLEARING'),
    ($1,gen_random_uuid(),$2,null,$2,'1001','447700900123','447700900123',0,0,null,null,null,null,null,0,'NO_ANSWER')`,
    [tenantId, at],
  );
  const day = new Date(at.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  for (const [user, path] of [
    [fixture.a, '/api/portal/cdrs/export'],
    [fixture.admin, `/api/admin/tenants/${tenantId}/cdrs/export`],
  ] as const) {
    const session = await login(api, user);
    const response = await api.inject({
      method: 'POST',
      url: path,
      headers: requestHeaders(session.cookie),
      payload: { from: day, to: day, status: 'all' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body.split('\r\n')[0]).toContain('被叫号码,ISO,国家,说明,');
    expect(response.body).not.toContain('国家/备注');
    expect(response.body).toContain(",GB,英国,'=1+1,");
    expect(response.body).toContain(',447700900123,,未接通,,');
  }
});
