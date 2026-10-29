import type {} from '../../../packages/db/test/global-setup.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CdrMonthDeletedError,
  createRateVersion,
  ensureCdrPartitions,
  ignoreUnassigned,
  recoverQuietAlerts,
  withSystem,
} from '@fs-billing/db';
import { beijingTime, rate } from '@fs-billing/rating';
import {
  CDR_VALIDATION_FAILURE_PREFIX,
  type ChargeJob,
} from '@fs-billing/shared';
import {
  adminId,
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
              (select count(*)::int from system_alerts where position($3 in description) > 0) as alerts`,
      [uuid, `call:${uuid}`, uuid],
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
          `select kind, subject_key, description from system_alerts where position($1 in description) > 0`,
          [uuid],
        )
      ).rows,
    ).toEqual([
      {
        kind: 'cdr_failed',
        subject_key: 'unassigned:所属月份话单已删除',
        description: `话单停放到未归属：所属月份话单已删除，最近一通 ${uuid}`,
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

/** 本文件的校验失败原文都带一个唯一标签，彼此（以及其他测试文件）不会撞上同一份原文。 */
function invalidBody(tag: string, uuid: string | undefined, bad = 'bad') {
  return JSON.stringify({
    variables: {
      ...(uuid === undefined ? {} : { uuid }),
      billing_tenant: tag,
      end_epoch: bad,
    },
  });
}

const tagOf = () =>
  `INV${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;

const invalidRows = async (tag: string) =>
  (
    await owner.pool.query<{
      id: string;
      status: string;
      reason: string;
      push_count: number;
      raw_id: string;
      raw_sha256: string;
      candidate_call_uuid: string | null;
      superseded_by_call_uuid: string | null;
      resolved_by: string | null;
      resolved: boolean;
      last_pushed_after_received: boolean;
    }>(
      `select id, status, reason, push_count, raw_id, raw_sha256, candidate_call_uuid,
              superseded_by_call_uuid, resolved_by, resolved_at is not null as resolved,
              last_pushed_at >= raw_received_at as last_pushed_after_received
       from unassigned_cdrs where call_uuid is null and tenant_tag = $1 order by raw_received_at, id`,
      [tag],
    )
  ).rows;

async function clearAlertsAndPending() {
  await owner.pool.query('delete from system_alerts');
  await owner.pool.query(
    "delete from unassigned_cdrs where status = 'pending'",
  );
}

/** 无效输入告警（按结构化原因合并）：校验失败的原因相同则只有一条，不论多少份不同原文。 */
const invalidAlerts = async (recovered = false) =>
  (
    await owner.pool.query<{
      kind: string;
      subject_key: string;
      description: string;
      occurrences: number;
      affected_calls: number;
    }>(
      `select kind, subject_key, description, occurrences, affected_calls from system_alerts
       where subject_key like 'invalid-cdr:%' and (recovered_at is not null) = $1
       order by started_at, id`,
      [recovered],
    )
  ).rows;

describe('话单校验失败（阶段 3 评审遗留，阶段 8 PR 2）', () => {
  // 告警按原因合并，各用例的失败原因相同；每个用例从没有告警、没有待处理行开始（恢复要看同原因的待处理行是否清零）。
  beforeEach(clearAlertsAndPending);

  it('stores a short structured reason for a failed validation', async () => {
    const tag = tagOf();
    const secret = 'SECRET-INPUT-VALUE';
    const { queue } = recordingQueue();
    const result = await ingestCdr(
      connection.db,
      queue,
      JSON.stringify({
        variables: {
          uuid: 'broken',
          billing_tenant: tag,
          billsec: secret,
          start_epoch: secret,
        },
      }),
    );
    expect(result.status).toBe('unassigned');
    const [row] = await invalidRows(tag);
    expect(row?.reason.startsWith(CDR_VALIDATION_FAILURE_PREFIX)).toBe(true);
    expect(row?.reason.length).toBeLessThanOrEqual(200);
    expect(row?.reason).toMatch(
      /^话单校验失败: variables\.uuid\(invalid_format\)/,
    );
    expect(row?.reason).toContain('variables.billsec(');
    expect(row?.reason).not.toContain(secret);
    expect(row?.reason).not.toContain('Invalid');
    // 告警的键是结构化原因，描述是原因加最近一份原文 id。
    expect(await invalidAlerts()).toEqual([
      {
        kind: 'cdr_failed',
        subject_key: `invalid-cdr:${row?.reason}`,
        description: `${row?.reason}（最近一份原文 ${result.rawId}）`,
        occurrences: 1,
        affected_calls: 1,
      },
    ]);
  });

  it('stores a validation failure of an empty object without the Zod message', async () => {
    const { queue } = recordingQueue();
    const result = await ingestCdr(
      connection.db,
      queue,
      JSON.stringify({ unique: randomUUID() }),
    );
    const { rows } = await owner.pool.query<{ reason: string }>(
      'select reason from unassigned_cdrs where raw_id = $1',
      [result.rawId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('话单校验失败: variables(invalid_type)');
  });

  it('repeated pushes of one invalid body keep one pending row and count the pushes', async () => {
    const tag = tagOf();
    const text = invalidBody(tag, randomUUID());
    const { queue } = recordingQueue();
    const first = await ingestCdr(connection.db, queue, text);
    const second = await ingestCdr(connection.db, queue, text);
    const third = await ingestCdr(connection.db, queue, text);
    expect([first, second, third].map((r) => r.status)).toEqual([
      'unassigned',
      'unassigned',
      'unassigned',
    ]);
    // 三次推送三个原文 id，原文照样各存一份（阶段 2 决定），待处理行只有一条，指向第一次的原文。
    expect(new Set([first.rawId, second.rawId, third.rawId]).size).toBe(3);
    expect(
      (
        await owner.pool.query(
          'select count(*)::int as n from raw_cdrs where id = any($1::uuid[])',
          [[first.rawId, second.rawId, third.rawId]],
        )
      ).rows,
    ).toEqual([{ n: 3 }]);
    expect(await invalidRows(tag)).toMatchObject([
      {
        status: 'pending',
        push_count: 3,
        raw_id: first.rawId,
        last_pushed_after_received: true,
      },
    ]);
    // 只有第一次写告警（决定 42）。
    expect(await invalidAlerts()).toMatchObject([
      { occurrences: 1, affected_calls: 1 },
    ]);
  });

  it('merges only byte-identical bodies', async () => {
    const tag = tagOf();
    const uuid = randomUUID();
    const { queue } = recordingQueue();
    const a = await ingestCdr(
      connection.db,
      queue,
      invalidBody(tag, uuid, 'a'),
    );
    const b = await ingestCdr(
      connection.db,
      queue,
      invalidBody(tag, uuid, 'b'),
    );
    // 末尾多一个换行也是另一份原文。
    const c = await ingestCdr(
      connection.db,
      queue,
      invalidBody(tag, uuid, 'a') + '\n',
    );
    const rows = await invalidRows(tag);
    expect(rows.map((row) => row.push_count)).toEqual([1, 1, 1]);
    expect(new Set(rows.map((row) => row.raw_sha256)).size).toBe(3);
    // 三份不同原文、同一个失败原因：合并成一条告警，affected_calls 是不同原文的份数。
    expect(await invalidAlerts()).toMatchObject([
      { occurrences: 3, affected_calls: 3 },
    ]);
    expect((await invalidAlerts())[0]?.description).toContain(c.rawId);
    expect(a.rawId).not.toBe(b.rawId);
  });

  it('concurrent pushes of one invalid body keep one row', async () => {
    const tag = tagOf();
    const text = invalidBody(tag, randomUUID());
    const { queue } = recordingQueue();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ingestCdr(connection.db, queue, text)),
    );
    expect(await invalidRows(tag)).toMatchObject([
      { status: 'pending', push_count: 8 },
    ]);
    expect(results).toHaveLength(8);
    expect(await invalidAlerts()).toMatchObject([
      { occurrences: 1, affected_calls: 1 },
    ]);
  });

  it('an ignored invalid body does not come back', async () => {
    const tag = tagOf();
    const text = invalidBody(tag, randomUUID());
    const { queue } = recordingQueue();
    const first = await ingestCdr(connection.db, queue, text);
    const [row] = await invalidRows(tag);
    await owner.pool.query(
      `update unassigned_cdrs set status = 'ignored', ignore_reason = '测试呼叫',
              resolved_by = $2, resolved_at = now() where id = $1`,
      [row?.id, await adminId(owner)],
    );
    const again = await ingestCdr(connection.db, queue, text);
    expect(again.status).toBe('unassigned');
    expect(await invalidRows(tag)).toMatchObject([
      { id: row?.id, status: 'ignored', push_count: 2 },
    ]);
    expect(first.rawId).not.toBe(again.rawId);
    expect(await invalidAlerts()).toMatchObject([{ occurrences: 1 }]);
  });

  it('a body whose earlier row was resolved starts a new pending row', async () => {
    const tag = tagOf();
    const uuid = randomUUID();
    const text = invalidBody(tag, uuid);
    const tenant = await tenantWithRates();
    const { queue } = recordingQueue();
    await ingestCdr(connection.db, queue, text);
    await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuid, { billing_unverified: 'false' }),
    );
    expect(await invalidRows(tag)).toMatchObject([{ status: 'superseded' }]);
    // 修正稿入库后，该原因的待处理行清零，告警恢复。
    expect(await invalidAlerts()).toEqual([]);
    expect(await invalidAlerts(true)).toHaveLength(1);
    // 已解决的行不再占用去重索引：同一份坏原文再来，是新的待处理行，并且写告警（新开一条）。
    const again = await ingestCdr(connection.db, queue, text);
    expect(await invalidRows(tag)).toMatchObject([
      { status: 'superseded', push_count: 1 },
      { status: 'pending', push_count: 1 },
    ]);
    const open = await invalidAlerts();
    expect(open).toMatchObject([{ occurrences: 1 }]);
    expect(open[0]?.description).toContain(again.rawId);
  });

  it('a corrected push resolves the earlier invalid row as superseded', async () => {
    const tenant = await tenantWithRates();
    const uuid = randomUUID();
    const { jobs, queue } = recordingQueue();
    const bad = body(tenant.code, uuid, {
      billing_unverified: 'false',
      end_epoch: 'bad',
    });
    await ingestCdr(connection.db, queue, bad);
    expect(await invalidRows(tenant.code)).toMatchObject([
      { status: 'pending', candidate_call_uuid: uuid },
    ]);
    const corrected = await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuid, { billing_unverified: 'false' }),
    );
    expect(corrected.status).toBe('queued');
    expect(jobs).toEqual([{ tenantId: tenant.id, callUuid: uuid }]);
    expect(await invalidRows(tenant.code)).toMatchObject([
      {
        status: 'superseded',
        superseded_by_call_uuid: uuid,
        resolved_by: null,
        resolved: true,
      },
    ]);
  });

  it('a corrected push parked as unassigned also resolves it', async () => {
    const uuid = randomUUID();
    const tag = tagOf();
    const { jobs, queue } = recordingQueue();
    await ingestCdr(
      connection.db,
      queue,
      body(tag, uuid, { billing_unverified: 'false', end_epoch: 'bad' }),
    );
    // 租户不存在：校验通过后停放到未归属，通话已有身份。
    const corrected = await ingestCdr(
      connection.db,
      queue,
      body(tag, uuid, { billing_unverified: 'false' }),
    );
    expect(corrected.status).toBe('unassigned');
    expect(jobs).toEqual([]);
    expect(await invalidRows(tag)).toMatchObject([
      { status: 'superseded', superseded_by_call_uuid: uuid },
    ]);
  });

  it('a duplicate of a registered call also resolves a later invalid row', async () => {
    const tenant = await tenantWithRates();
    const uuid = randomUUID();
    const { queue } = recordingQueue();
    const good = body(tenant.code, uuid, { billing_unverified: 'false' });
    expect((await ingestCdr(connection.db, queue, good)).status).toBe('queued');
    // 通话已登记之后才来的坏原文：下一次有效推送（这里是重复）把它解决。
    await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuid, {
        billing_unverified: 'false',
        end_epoch: 'bad',
      }),
    );
    expect(await invalidRows(tenant.code)).toMatchObject([
      { status: 'pending' },
    ]);
    expect((await ingestCdr(connection.db, queue, good)).status).toBe(
      'duplicate',
    );
    expect(await invalidRows(tenant.code)).toMatchObject([
      { status: 'superseded', superseded_by_call_uuid: uuid },
    ]);
  });

  it('an invalid row without a parsable uuid stays pending', async () => {
    const tag = tagOf();
    const tenant = await tenantWithRates();
    const { queue } = recordingQueue();
    // 没有 uuid 字段、uuid 语法不合法：都不记候选 UUID。
    await ingestCdr(connection.db, queue, invalidBody(tag, undefined));
    await ingestCdr(connection.db, queue, invalidBody(tag, 'not-a-uuid'));
    expect(await invalidRows(tag)).toMatchObject([
      { status: 'pending', candidate_call_uuid: null },
      { status: 'pending', candidate_call_uuid: null },
    ]);
    // 任何通过校验的话单都不会动它们。
    await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, randomUUID(), { billing_unverified: 'false' }),
    );
    expect((await invalidRows(tag)).map((row) => row.status)).toEqual([
      'pending',
      'pending',
    ]);
  });

  it('does not resolve an ignored invalid row or one of another call', async () => {
    const tenant = await tenantWithRates();
    const uuid = randomUUID();
    const { queue } = recordingQueue();
    await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuid, {
        billing_unverified: 'false',
        end_epoch: 'bad',
      }),
    );
    const [row] = await invalidRows(tenant.code);
    await owner.pool.query(
      `update unassigned_cdrs set status = 'ignored', ignore_reason = '测试呼叫',
              resolved_by = $2, resolved_at = now() where id = $1`,
      [row?.id, await adminId(owner)],
    );
    // 另一通话入库不影响；同一通话修正重推也不改写已忽略的行（人工处理优先）。
    await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, randomUUID(), { billing_unverified: 'false' }),
    );
    await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuid, { billing_unverified: 'false' }),
    );
    expect(await invalidRows(tenant.code)).toMatchObject([
      { status: 'ignored', superseded_by_call_uuid: null },
    ]);
  });

  it('keeps the hangup cause and the unverified flag of a parked call', async () => {
    const uuid = randomUUID();
    const tag = tagOf();
    const { jobs, queue } = recordingQueue();
    const result = await ingestCdr(
      connection.db,
      queue,
      body(tag, uuid, {
        hangup_cause: 'USER_BUSY',
        billing_unverified: 'true',
      }),
    );
    expect(result.status).toBe('unassigned');
    expect(jobs).toEqual([]);
    expect(
      (
        await owner.pool.query(
          `select reason, hangup_cause, unverified, billing_number from unassigned_cdrs where call_uuid = $1`,
          [uuid],
        )
      ).rows,
    ).toEqual([
      {
        reason: '租户不存在',
        hangup_cause: 'USER_BUSY',
        unverified: true,
        billing_number: '447700900123',
      },
    ]);
    const otherUuid = randomUUID();
    await ingestCdr(
      connection.db,
      queue,
      body(tag, otherUuid, { billing_unverified: 'false' }),
    );
    expect(
      (
        await owner.pool.query(
          `select hangup_cause, unverified from unassigned_cdrs where call_uuid = $1`,
          [otherUuid],
        )
      ).rows,
    ).toEqual([{ hangup_cause: 'NORMAL_CLEARING', unverified: false }]);
  });
});

/** 全部告警（按键合并后的条数与累计），用来断言写入点的合并行为。 */
const alertsByKey = async (like: string) =>
  (
    await owner.pool.query<{
      kind: string;
      subject_key: string;
      tenant_id: string | null;
      occurrences: number;
      affected_calls: number;
      description: string;
      recovered: boolean;
    }>(
      `select kind, subject_key, tenant_id, occurrences, affected_calls, description,
              recovered_at is not null as recovered
       from system_alerts where subject_key like $1 order by started_at, id`,
      [like],
    )
  ).rows;

describe('告警按键合并（阶段 9 PR 1）', () => {
  beforeEach(clearAlertsAndPending);

  it('broken json pushes keep one invalid-json alert and recover after the quiet window', async () => {
    const { queue } = recordingQueue();
    const results = [];
    for (let i = 0; i < 3; i++)
      results.push(await ingestCdr(connection.db, queue, `{ "broken": ${i}`));
    expect(results.map((r) => r.status)).toEqual([
      'invalid',
      'invalid',
      'invalid',
    ]);
    // 没有待处理行，也没有 UUID：只有一条全局告警，每次推送累加，描述只写最近一次的原文 id。
    expect(
      (
        await owner.pool.query(
          'select count(*)::int as n from unassigned_cdrs where raw_id = any($1::uuid[])',
          [results.map((r) => r.rawId)],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    expect(await alertsByKey('invalid-json')).toEqual([
      {
        kind: 'cdr_failed',
        subject_key: 'invalid-json',
        tenant_id: null,
        occurrences: 3,
        affected_calls: 3,
        description: `话单 JSON 格式错误，最近一次原文 ${results[2]!.rawId}`,
        recovered: false,
      },
    ]);
    // 静默窗口内不恢复；满 ALERT_QUIET_MINUTES 没有新事件才恢复。
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    const quiet = (when: Date) =>
      withSystem(connection.db, (tx) =>
        recoverQuietAlerts(tx, { quietMinutes: 10, at: when }),
      );
    expect(await quiet(at(9))).toBe(0);
    expect(await quiet(at(11))).toBe(1);
    expect((await alertsByKey('invalid-json'))[0]?.recovered).toBe(true);
    // 恢复之后再有损坏的推送，开新的一条。
    await ingestCdr(connection.db, queue, '{ "broken": again');
    expect(await alertsByKey('invalid-json')).toMatchObject([
      { recovered: true, occurrences: 3 },
      { recovered: false, occurrences: 1 },
    ]);
  });

  it('unverified calls keep one global auth_timeout alert', async () => {
    const tenant = await tenantWithRates();
    const { queue } = recordingQueue();
    const uuids = [randomUUID(), randomUUID(), randomUUID()];
    for (const uuid of uuids)
      await ingestCdr(connection.db, queue, body(tenant.code, uuid));
    // 重推同一通话（去重）不再累加。
    await ingestCdr(connection.db, queue, body(tenant.code, uuids[0]!));
    expect(await alertsByKey('fs-authorize')).toMatchObject([
      {
        kind: 'auth_timeout',
        tenant_id: null,
        occurrences: 3,
        affected_calls: 3,
        recovered: false,
      },
    ]);
    expect((await alertsByKey('fs-authorize'))[0]?.description).toContain(
      uuids[2]!,
    );
  });

  it('parked calls merge by reason, and by tag when the tenant does not exist', async () => {
    const tagA = tagOf();
    const tagB = tagOf();
    const tenant = await tenantWithRates();
    const { queue } = recordingQueue();
    const push = (tenantCode: string, extra = {}) =>
      ingestCdr(
        connection.db,
        queue,
        body(tenantCode, randomUUID(), {
          billing_unverified: 'false',
          ...extra,
        }),
      );
    await push(tagA);
    await push(tagA);
    await push(tagB);
    // 无费率：接通早于第一个费率版本。
    await push(tenant.code, timing('2026-01-10 10:00:00'));
    await push(tenant.code, timing('2026-01-11 10:00:00'));
    expect(await alertsByKey('unassigned:%')).toMatchObject([
      {
        subject_key: `unassigned:租户不存在:${tagA}`,
        occurrences: 2,
        affected_calls: 2,
      },
      {
        subject_key: `unassigned:租户不存在:${tagB}`,
        occurrences: 1,
        affected_calls: 1,
      },
      {
        subject_key: 'unassigned:接通时无费率',
        occurrences: 2,
        affected_calls: 2,
      },
    ]);
  });

  it('a corrected push recovers the invalid-input alert only when no pending row of that reason is left', async () => {
    const tenant = await tenantWithRates();
    const { queue } = recordingQueue();
    const uuidA = randomUUID();
    const uuidB = randomUUID();
    const bad = (uuid: string) =>
      body(tenant.code, uuid, {
        billing_unverified: 'false',
        end_epoch: 'bad',
      });
    await ingestCdr(connection.db, queue, bad(uuidA));
    await ingestCdr(connection.db, queue, bad(uuidB));
    expect(await alertsByKey('invalid-cdr:%')).toMatchObject([
      { occurrences: 2, affected_calls: 2, recovered: false },
    ]);
    await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuidA, { billing_unverified: 'false' }),
    );
    // 还剩 uuidB 的待处理行：告警不恢复。
    expect((await alertsByKey('invalid-cdr:%'))[0]?.recovered).toBe(false);
    await ingestCdr(
      connection.db,
      queue,
      body(tenant.code, uuidB, { billing_unverified: 'false' }),
    );
    expect((await alertsByKey('invalid-cdr:%'))[0]?.recovered).toBe(true);
  });

  it('an ignored last pending row recovers it', async () => {
    const tag = tagOf();
    const { queue } = recordingQueue();
    await ingestCdr(connection.db, queue, invalidBody(tag, undefined));
    await ingestCdr(connection.db, queue, invalidBody(tag, undefined, 'b'));
    expect(await alertsByKey('invalid-cdr:%')).toMatchObject([
      { occurrences: 2, recovered: false },
    ]);
    await ignoreUnassigned(connection.db, {
      actor: { id: await adminId(owner), name: '王敏' },
      selection: { group: { tag } },
      reason: '测试呼叫',
    });
    expect(await alertsByKey('invalid-cdr:%')).toMatchObject([
      { recovered: true },
    ]);
  });
});
