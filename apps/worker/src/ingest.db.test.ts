import type {} from '../../../packages/db/test/global-setup.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CdrMonthDeletedError,
  createRateVersion,
  ensureCdrPartitions,
  withSystem,
} from '@fs-billing/db';
import { beijingTime, rate } from '@fs-billing/rating';
import type { ChargeJob } from '@fs-billing/shared';
import {
  connections,
  createTenant,
} from '../../../packages/db/test/support.js';
import { chargeCdr } from './charge.js';
import { ingestCdr } from './ingest.js';
import type { ChargeQueue } from './queue.js';

const { app: connection, owner } = connections();
const template = z
  .looseObject({ variables: z.record(z.string(), z.unknown()) })
  .parse(
    JSON.parse(
      await readFile(
        new URL(
          '../../../freeswitch/examples/sample-cdr.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );

/** 记录入队的扣费任务，不依赖 pg-boss。 */
function recordingQueue() {
  const jobs: ChargeJob[] = [];
  const queue: ChargeQueue = {
    enqueue: (_tx, job) => {
      jobs.push(job);
      return Promise.resolve();
    },
  };
  return { jobs, queue };
}

function body(
  tenant: string,
  uuid: string,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    ...template,
    variables: {
      ...template.variables,
      uuid,
      billing_tenant: tenant,
      ...overrides,
    },
  });
}

/** 北京时间 answeredAt 接通、通话 61 秒的时间字段。 */
function timing(answeredAt: string) {
  const answer = Math.floor(beijingTime(answeredAt).getTime() / 1000);
  return {
    start_epoch: String(answer - 5),
    answer_epoch: String(answer),
    end_epoch: String(answer + 61),
    duration: '66',
    billsec: '61',
  };
}

async function tenantWithRates() {
  const tenant = await createTenant(connection, 'CNY');
  await withSystem(connection.db, (tx) =>
    createRateVersion(
      tx,
      tenant.id,
      [
        {
          iso: '',
          description: '',
          prefix: '447',
          country: '英国手机',
          perMinute: rate('CNY', '0.0480'),
        },
      ],
      { effectiveFrom: new Date('2026-06-01T00:00:00Z') },
    ),
  );
  return tenant;
}

async function deleteMonth(tenantId: string, month: string) {
  await owner.pool.query(
    `insert into monthly_statements (tenant_id, month, opening_balance, recharge, gift, adjustment,
                                     call_charges, closing_balance, call_minutes, details_deleted)
     values ($1, $2, 0, 0, 0, 0, 0, 0, 0, true)`,
    [tenantId, month],
  );
}

const state = async (uuid: string) =>
  (
    await owner.pool.query<{
      cdrs: number;
      unassigned: number;
      charges: number;
      alerts: number;
    }>(
      `select (select count(*)::int from cdrs where call_uuid = $1) as cdrs,
              (select count(*)::int from unassigned_cdrs where call_uuid = $1) as unassigned,
              (select count(*)::int from ledger_entries where idempotency_key = $2) as charges,
              (select count(*)::int from system_alerts where description like $3) as alerts`,
      [uuid, `call:${uuid}`, `${uuid}:%`],
    )
  ).rows[0]!;

beforeAll(async () => {
  await ensureCdrPartitions(connection.db, {
    moment: beijingTime('2026-06-01 00:00:00'),
    monthsAhead: 4,
  });
});

describe('话单所属月份的话单已删除（阶段 8 决定 38）', () => {
  it('parks a call answered in a details-deleted month without charging it and opens a cdr_failed alert', async () => {
    const tenant = await tenantWithRates();
    await deleteMonth(tenant.id, '2026-10-01');
    const uuid = randomUUID();
    const { jobs, queue } = recordingQueue();
    // 样本话单是 2026-10-12 10:00:09 接通，属于 10 月。
    const result = await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuid, { billing_unverified: 'false' }),
    );
    expect(result.status).toBe('unassigned');
    expect(jobs).toEqual([]);
    expect(await state(uuid)).toEqual({
      cdrs: 0,
      unassigned: 1,
      charges: 0,
      alerts: 1,
    });
    expect(
      (
        await owner.pool.query(
          `select tenant_tag, reason, billing_number, status, hangup_cause,
                  (select tenant_id is null from call_uuids where call_uuid = $1) as unclaimed
           from unassigned_cdrs where call_uuid = $1`,
          [uuid],
        )
      ).rows,
    ).toEqual([
      {
        tenant_tag: tenant.code.toUpperCase(),
        reason: '所属月份话单已删除',
        billing_number: '447700900123',
        status: 'pending',
        hangup_cause: 'NORMAL_CLEARING',
        unclaimed: true,
      },
    ]);
    expect(
      (
        await owner.pool.query(
          `select kind, description, affected_calls from system_alerts where description like $1`,
          [`${uuid}:%`],
        )
      ).rows,
    ).toEqual([
      {
        kind: 'cdr_failed',
        description: `${uuid}: 所属月份话单已删除`,
        affected_calls: 1,
      },
    ]);
    // 重推同一通话：已登记，判重复，不再停放、不再告警。
    const again = await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuid, { billing_unverified: 'false' }),
    );
    expect(again.status).toBe('duplicate');
    expect(await state(uuid)).toEqual({
      cdrs: 0,
      unassigned: 1,
      charges: 0,
      alerts: 1,
    });
  });

  it('still queues and charges a call of the same tenant answered in another month', async () => {
    const tenant = await tenantWithRates();
    await deleteMonth(tenant.id, '2026-10-01');
    const uuid = randomUUID();
    const { jobs, queue } = recordingQueue();
    const result = await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuid, {
        billing_unverified: 'false',
        ...timing('2026-09-10 10:00:00'),
      }),
    );
    expect(result.status).toBe('queued');
    expect(jobs).toEqual([{ tenantId: tenant.id, callUuid: uuid }]);
    await chargeCdr(connection.db, jobs[0]);
    expect(await state(uuid)).toEqual({
      cdrs: 1,
      unassigned: 0,
      charges: 1,
      alerts: 0,
    });
    expect(
      (
        await owner.pool.query(
          'select amount::text from ledger_entries where idempotency_key = $1',
          [`call:${uuid}`],
        )
      ).rows,
    ).toEqual([{ amount: '-0.096' }]);
  });

  it('parks an unanswered call by its start month too', async () => {
    const tenant = await tenantWithRates();
    await deleteMonth(tenant.id, '2026-10-01');
    const uuid = randomUUID();
    const { jobs, queue } = recordingQueue();
    const start = Math.floor(
      beijingTime('2026-10-20 10:00:00').getTime() / 1000,
    );
    const result = await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuid, {
        billing_unverified: 'false',
        start_epoch: String(start),
        end_epoch: String(start + 20),
        duration: '20',
        billsec: '0',
        answer_epoch: '0',
      }),
    );
    expect(result.status).toBe('unassigned');
    expect(jobs).toEqual([]);
    expect(await state(uuid)).toMatchObject({ cdrs: 0, unassigned: 1 });
  });

  it('refuses to charge a queued call whose month was deleted before the charge job ran', async () => {
    const tenant = await tenantWithRates();
    const uuid = randomUUID();
    const { jobs, queue } = recordingQueue();
    await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuid, { billing_unverified: 'false' }),
    );
    expect(jobs).toHaveLength(1);
    // 入库之后、扣费之前，月份被标为已删除（正常流程里删除会因未扣费的话单被拒绝，这里直接置标志）。
    await deleteMonth(tenant.id, '2026-10-01');
    await expect(chargeCdr(connection.db, jobs[0])).rejects.toBeInstanceOf(
      CdrMonthDeletedError,
    );
    expect(await state(uuid)).toMatchObject({ cdrs: 1, charges: 0 });
  });
});
