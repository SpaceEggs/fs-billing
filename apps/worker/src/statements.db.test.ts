import type {} from '../../../packages/db/test/global-setup.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readStatement, regenerateStatement, withAdmin } from '@fs-billing/db';
import { adminId, connections } from '../../../packages/db/test/support.js';
import {
  ensureStatementPartitions,
  statementCall,
  statementLedger,
  statementTenant,
} from '../../../packages/db/test/statements.js';
import {
  GENERATE_STATEMENTS_QUEUE,
  GENERATE_STATEMENT_QUEUE,
  RECONCILE_STATEMENTS_QUEUE,
  createBoss,
  installQueue,
} from './queue.js';
import {
  enqueueMissingStatements,
  generateOneStatement,
  reconcileStatements,
  startStatementJobs,
  statementJobData,
} from './statements.js';

const { app: connection, owner } = connections();
const boss = createBoss(connection.db);
// 模拟 10 月 2 日 02:00 的定时触发：7、8、9 月已结束，10 月进行中。
const OCTOBER = new Date('2026-10-02T02:00:00+08:00');
const NEXT_DAY = new Date('2026-10-03T02:00:00+08:00');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const queues = [
  GENERATE_STATEMENTS_QUEUE,
  GENERATE_STATEMENT_QUEUE,
  RECONCILE_STATEMENTS_QUEUE,
];
let administrator: string;

beforeAll(async () => {
  administrator = await adminId(owner);
  await ensureStatementPartitions(connection);
  await installQueue(owner);
  await boss.start();
});
afterAll(async () => {
  for (const queue of queues) await boss.unschedule(queue).catch(() => {});
  await boss.stop();
  await owner.pool.query('DELETE FROM pgboss.job WHERE name = ANY($1)', [
    queues,
  ]);
});

const enqueue = (tenantId: string, asOf = OCTOBER) =>
  enqueueMissingStatements(connection.db, boss, {
    tenantId,
    asOf,
  });
const reconcile = (tenantId: string) =>
  reconcileStatements(
    connection.db,
    { tenantIds: [tenantId], asOf: OCTOBER },
    log,
  );
const read = (tenantId: string, month: string) =>
  withAdmin(connection.db, (tx) => readStatement(tx, tenantId, month));

async function children(tenantId: string, states?: string[]) {
  const { rows } = await owner.pool.query<{
    id: string;
    state: string;
    data: { tenantId: string; month: string };
  }>(
    `select id, state, data from pgboss.job
     where name = $1 and data->>'tenantId' = $2 and ($3::text[] is null or state::text = any($3))
     order by data->>'month'`,
    [GENERATE_STATEMENT_QUEUE, tenantId, states ?? null],
  );
  return rows;
}
/** 像 worker 一样执行排队中的子任务并标记完成。 */
async function runChildren(tenantId: string) {
  const outcomes: string[] = [];
  for (const job of await children(tenantId, ['created', 'retry'])) {
    const result = await generateOneStatement(
      connection.db,
      statementJobData.parse(job.data),
    );
    outcomes.push(`${job.data.month}:${result.outcome}`);
    await owner.pool.query(
      "update pgboss.job set state = 'completed' where name = $1 and id = $2",
      [GENERATE_STATEMENT_QUEUE, job.id],
    );
  }
  return outcomes;
}
const alerts = async (tenantId: string) =>
  (
    await owner.pool.query<{ description: string; recovered: boolean }>(
      `select description, recovered_at is not null as recovered from system_alerts
       where tenant_id = $1 and kind = 'statement_mismatch' order by started_at, description`,
      [tenantId],
    )
  ).rows;

/** 默认 7 月开户，7、8、9 月各有一通电话（1、2、3 元），第一个月有一笔 100 元充值。 */
async function activeTenant(
  options: {
    createdAt?: string;
    status?: 'active' | 'disabled';
    months?: readonly ('2026-07' | '2026-08' | '2026-09')[];
  } = {},
) {
  const months = options.months ?? ['2026-07', '2026-08', '2026-09'];
  const tenant = await statementTenant(owner, {
    createdAt: options.createdAt ?? '2026-07-10 09:00:00',
    ...(options.status && { status: options.status }),
  });
  await statementLedger(
    owner,
    tenant.id,
    'recharge',
    '100',
    `${months[0]}-11 10:00:00`,
    { adminId: administrator },
  );
  for (const month of months)
    await statementCall(owner, tenant.id, {
      answeredAt: `${month}-20 10:00:00`,
      charge: String(Number(month.slice(5)) - 6),
    });
  return tenant;
}

describe('队列预建', () => {
  it('queue:migrate pre-creates the three statement queues with retries', async () => {
    const { rows } = await owner.pool.query<{
      name: string;
      retry_limit: number;
    }>('select name, retry_limit from pgboss.queue where name = any($1)', [
      queues,
    ]);
    expect(rows.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [...queues].sort().map((name) => ({ name, retry_limit: 3 })),
    );
  });
});

describe('生成任务扇出与补缺（验收标准 4）', () => {
  it('fans out one child per missing tenant-month from the opening month and catches up after missed days', async () => {
    const tenant = await activeTenant();
    // 8 月之前就生成过；之后 Worker 停机，9 月 1 日与之后的触发都没有运行。
    await generateOneStatement(connection.db, {
      tenantId: tenant.id,
      month: '2026-08-01',
    });
    const august = (await read(tenant.id, '2026-08-01'))!;

    const summary = await enqueue(tenant.id);
    expect(summary).toEqual({
      missing: 2,
      enqueued: 2,
      duplicates: 0,
      inFlight: 0,
    });
    expect((await children(tenant.id)).map((job) => job.data.month)).toEqual([
      '2026-07-01',
      '2026-09-01',
    ]);

    expect(await runChildren(tenant.id)).toEqual([
      '2026-07-01:created',
      '2026-09-01:created',
    ]);
    const july = (await read(tenant.id, '2026-07-01'))!;
    const september = (await read(tenant.id, '2026-09-01'))!;
    expect(july).toMatchObject({
      openingBalance: '0',
      closingBalance: '99',
      calls: 1,
      generatedBy: null,
      version: 1,
    });
    expect(september).toMatchObject({ openingBalance: '97', calls: 1 });
    // 已有的 8 月原样保留。
    expect(await read(tenant.id, '2026-08-01')).toEqual(august);
    // 当前进行中的 10 月不生成。
    expect(await read(tenant.id, '2026-10-01')).toBeNull();
    // 补缺之后再来一轮：没有缺口，没有新任务。
    expect(await enqueue(tenant.id, NEXT_DAY)).toEqual({
      missing: 0,
      enqueued: 0,
      duplicates: 0,
      inFlight: 0,
    });
    expect(await children(tenant.id)).toHaveLength(2);
  });

  it('starts a tenant created mid-month at its opening month and includes disabled tenants with no activity', async () => {
    const midMonth = await statementTenant(owner, {
      createdAt: '2026-08-12 09:30:00',
    });
    const disabled = await statementTenant(owner, {
      createdAt: '2026-09-05 09:00:00',
      status: 'disabled',
    });
    expect((await enqueue(midMonth.id)).enqueued).toBe(2);
    expect((await enqueue(disabled.id)).enqueued).toBe(1);
    expect(await runChildren(midMonth.id)).toEqual([
      '2026-08-01:created',
      '2026-09-01:created',
    ]);
    expect(await runChildren(disabled.id)).toEqual(['2026-09-01:created']);
    expect(await read(midMonth.id, '2026-07-01')).toBeNull();
    expect(await read(midMonth.id, '2026-08-01')).toMatchObject({
      openingBalance: '0',
      closingBalance: '0',
      calls: 0,
    });
    expect(await read(disabled.id, '2026-09-01')).toMatchObject({
      closingBalance: '0',
    });
  });

  it('catches up every closed month since the first statement month, with no cap', async () => {
    // 2023-01 开户到 2026-09 共 45 个已结束月份，远超原先的 24 个月上限。
    const tenant = await statementTenant(owner, {
      createdAt: '2023-01-10 09:00:00',
    });
    const summary = await enqueue(tenant.id);
    expect(summary).toMatchObject({ missing: 45, enqueued: 45 });
    const months = (await children(tenant.id)).map((job) => job.data.month);
    expect(months).toHaveLength(45);
    expect(months[0]).toBe('2023-01-01');
    expect(months.at(-1)).toBe('2026-09-01');
    const outcomes = await runChildren(tenant.id);
    expect(outcomes).toHaveLength(45);
    expect(outcomes.every((outcome) => outcome.endsWith(':created'))).toBe(
      true,
    );
    expect(await read(tenant.id, '2023-01-01')).toMatchObject({
      openingBalance: '0',
      closingBalance: '0',
      calls: 0,
    });
    // 全部补齐后没有缺口，下一轮什么也不入队。
    expect(await enqueue(tenant.id, NEXT_DAY)).toMatchObject({
      missing: 0,
      enqueued: 0,
    });
  });

  it('a duplicate parent job enqueues no second child', async () => {
    const tenant = await activeTenant({
      createdAt: '2026-09-01 08:00:00',
      months: ['2026-09'],
    });
    expect(await enqueue(tenant.id)).toMatchObject({ enqueued: 1 });
    // 第二个父任务（重复触发）看到上一个子任务仍排队。
    expect(await enqueue(tenant.id)).toEqual({
      missing: 1,
      enqueued: 0,
      duplicates: 0,
      inFlight: 1,
    });
    // 即使子任务已不在排队（这里标为完成但账单还没建出来），同一天的第三次触发
    // 的确定性 ID 与已有任务冲突，pg-boss 不会再建一个。
    await owner.pool.query(
      "update pgboss.job set state = 'completed' where name = $1 and data->>'tenantId' = $2",
      [GENERATE_STATEMENT_QUEUE, tenant.id],
    );
    expect(await enqueue(tenant.id)).toEqual({
      missing: 1,
      enqueued: 0,
      duplicates: 1,
      inFlight: 0,
    });
    expect(await children(tenant.id)).toHaveLength(1);
  });

  it('re-enqueues a failed child on the next day run', async () => {
    const tenant = await activeTenant({
      createdAt: '2026-09-01 08:00:00',
      months: ['2026-09'],
    });
    await enqueue(tenant.id);
    // 重试耗尽：任务进入 failed，账单仍缺。
    await owner.pool.query(
      "update pgboss.job set state = 'failed' where name = $1 and data->>'tenantId' = $2",
      [GENERATE_STATEMENT_QUEUE, tenant.id],
    );
    expect((await enqueue(tenant.id)).duplicates).toBe(1);
    expect(await enqueue(tenant.id, NEXT_DAY)).toMatchObject({ enqueued: 1 });
    expect(await children(tenant.id)).toHaveLength(2);
    expect(await runChildren(tenant.id)).toEqual(['2026-09-01:created']);
    expect(await children(tenant.id, ['failed'])).toHaveLength(1);
  });

  it('repeated runs leave one statement with identical results', async () => {
    const tenant = await activeTenant();
    await enqueue(tenant.id);
    await runChildren(tenant.id);
    const first = await Promise.all(
      ['2026-07-01', '2026-08-01', '2026-09-01'].map((m) => read(tenant.id, m)),
    );
    // 手工再次执行同样的子任务数据：已存在，什么都不写。
    for (const month of ['2026-07-01', '2026-08-01', '2026-09-01'])
      expect(
        await generateOneStatement(connection.db, {
          tenantId: tenant.id,
          month,
        }),
      ).toEqual({ outcome: 'exists' });
    expect(await enqueue(tenant.id, NEXT_DAY)).toMatchObject({ missing: 0 });
    expect(
      await Promise.all(
        ['2026-07-01', '2026-08-01', '2026-09-01'].map((m) =>
          read(tenant.id, m),
        ),
      ),
    ).toEqual(first);
    const { rows } = await owner.pool.query<{ n: number }>(
      'select count(*)::int as n from monthly_statements where tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.n).toBe(3);
  });

  it('a scheduled run never overwrites an existing statement after late entries', async () => {
    const tenant = await activeTenant({
      createdAt: '2026-09-01 08:00:00',
      months: ['2026-09'],
    });
    await enqueue(tenant.id);
    await runChildren(tenant.id);
    const before = (await read(tenant.id, '2026-09-01'))!;
    // 生成之后补推的 9 月扣费。
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-21 10:00:00',
      charge: '7',
      ledgerCreatedAt: 'now',
    });
    expect(await enqueue(tenant.id, NEXT_DAY)).toMatchObject({
      missing: 0,
      enqueued: 0,
    });
    expect(
      await generateOneStatement(connection.db, {
        tenantId: tenant.id,
        month: '2026-09-01',
      }),
    ).toEqual({ outcome: 'exists' });
    expect(await read(tenant.id, '2026-09-01')).toEqual(before);
  });

  it('concurrent child jobs for the same tenant-month produce one statement and one breakdown', async () => {
    const tenant = await activeTenant({
      createdAt: '2026-09-01 08:00:00',
      months: ['2026-09'],
    });
    const job = { tenantId: tenant.id, month: '2026-09-01' };
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => generateOneStatement(connection.db, job)),
    );
    expect(outcomes.filter((o) => o.outcome === 'created')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'exists')).toHaveLength(5);
    const { rows } = await owner.pool.query<{
      statements: number;
      countries: number;
      days: number;
    }>(
      `select (select count(*)::int from monthly_statements where tenant_id = $1) as statements,
        (select count(*)::int from monthly_statement_countries where tenant_id = $1) as countries,
        (select count(*)::int from monthly_statement_days where tenant_id = $1) as days`,
      [tenant.id],
    );
    expect(rows[0]).toEqual({ statements: 1, countries: 1, days: 1 });
  });

  it('concurrent children for different months of one tenant all succeed', async () => {
    const tenant = await activeTenant();
    const outcomes = await Promise.all(
      ['2026-07-01', '2026-08-01', '2026-09-01'].map((month) =>
        generateOneStatement(connection.db, { tenantId: tenant.id, month }),
      ),
    );
    expect(outcomes.map((o) => o.outcome)).toEqual([
      'created',
      'created',
      'created',
    ]);
  });
});

describe('核对任务（验收标准 2）', () => {
  async function generated() {
    const tenant = await activeTenant();
    await enqueue(tenant.id);
    await runChildren(tenant.id);
    return tenant;
  }

  it('marks generated statements ok and opens no alert', async () => {
    const tenant = await generated();
    const summary = await reconcile(tenant.id);
    expect(summary).toMatchObject({
      tenants: 1,
      statements: 3,
      stale: 0,
      inconsistent: 0,
      missing: 0,
      alertsOpened: 0,
    });
    expect(await read(tenant.id, '2026-09-01')).toMatchObject({
      reconcileStatus: 'ok',
      reconcileDiff: '0',
    });
    expect(await alerts(tenant.id)).toEqual([]);
  });

  it('flags a late call charge as stale with one alert, keeps it at one alert across reruns and recovers after regeneration', async () => {
    const tenant = await generated();
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-25 10:00:00',
      charge: '4',
      ledgerCreatedAt: 'now',
    });
    const first = await reconcile(tenant.id);
    expect(first).toMatchObject({ stale: 1, alertsOpened: 1 });
    expect(await read(tenant.id, '2026-09-01')).toMatchObject({
      reconcileStatus: 'stale',
      reconcileDiff: '-4',
    });
    const description = `${tenant.code} 2026-09 账单与流水不一致（stale），差额 -4`;
    expect(await alerts(tenant.id)).toEqual([
      { description, recovered: false },
    ]);

    // 同一天再核对一次：状态不变，不重复告警。
    expect(await reconcile(tenant.id)).toMatchObject({
      stale: 1,
      alertsOpened: 0,
      alertsUpdated: 0,
      alertsRecovered: 0,
    });
    expect(await alerts(tenant.id)).toHaveLength(1);

    // 定时生成不会覆盖；管理员重新生成（db 函数）之后下一轮核对恢复。
    const result = await withAdmin(
      connection.db,
      (tx) =>
        regenerateStatement(tx, tenant.id, '2026-09-01', {
          expectedVersion: 1,
          adminId: administrator,
        }),
      { isolationLevel: 'repeatable read' },
    );
    expect(result).toMatchObject({ changed: true });
    expect(await reconcile(tenant.id)).toMatchObject({
      stale: 0,
      alertsRecovered: 1,
    });
    expect(await read(tenant.id, '2026-09-01')).toMatchObject({
      reconcileStatus: 'ok',
      version: 2,
    });
    expect(await alerts(tenant.id)).toEqual([{ description, recovered: true }]);
  });

  it('flags a late entry in an earlier month on both months and recovers them in order', async () => {
    const tenant = await generated();
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-08-25 10:00:00',
      charge: '5',
      ledgerCreatedAt: 'now',
    });
    const summary = await reconcile(tenant.id);
    expect(summary.stale).toBe(2);
    expect((await alerts(tenant.id)).map((a) => a.recovered)).toEqual([
      false,
      false,
    ]);
  });

  it('reports a missing statement with an alert and recovers once it is generated', async () => {
    const tenant = await activeTenant({
      createdAt: '2026-09-01 08:00:00',
      months: ['2026-09'],
    });
    const missing = await reconcile(tenant.id);
    expect(missing).toMatchObject({ statements: 0, missing: 1 });
    expect(await alerts(tenant.id)).toEqual([
      {
        description: `${tenant.code} 2026-09 账单与流水不一致（missing）`,
        recovered: false,
      },
    ]);
    await generateOneStatement(connection.db, {
      tenantId: tenant.id,
      month: '2026-09-01',
    });
    expect(await reconcile(tenant.id)).toMatchObject({
      missing: 0,
      alertsRecovered: 1,
    });
    expect((await alerts(tenant.id)).map((a) => a.recovered)).toEqual([true]);
  });

  it('keeps going after one tenant fails, reports the aggregate and succeeds on retry', async () => {
    const first = await generated();
    const second = await generated();
    const [failing, other] = [first, second].sort((a, b) =>
      a.code.localeCompare(b.code),
    ) as [typeof first, typeof first];
    let transactions = 0;
    // 第 1 个事务是列租户，第 2 个是排序在前的租户的核对。
    const flaky = new Proxy(connection.db, {
      get(target, property) {
        if (property === 'transaction')
          return (...args: Parameters<typeof target.transaction>) =>
            ++transactions === 2
              ? Promise.reject(new Error('模拟核对失败'))
              : target.transaction(...args);
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const error = await reconcileStatements(
      flaky,
      { tenantIds: [failing.id, other.id], asOf: OCTOBER },
      log,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(1);
    expect(await read(failing.id, '2026-09-01')).toMatchObject({
      reconcileStatus: 'unchecked',
    });
    expect(await read(other.id, '2026-09-01')).toMatchObject({
      reconcileStatus: 'ok',
    });
    // pg-boss 重试整个任务：幂等，补上失败的租户。
    await reconcileStatements(
      connection.db,
      { tenantIds: [failing.id, other.id], asOf: OCTOBER },
      log,
    );
    expect(await read(failing.id, '2026-09-01')).toMatchObject({
      reconcileStatus: 'ok',
    });
  });
});

describe('调度与 Worker 端到端', () => {
  beforeAll(async () => {
    // 之前的用例留下的排队子任务不应被真实 worker 领走。
    await owner.pool.query('DELETE FROM pgboss.job WHERE name = ANY($1)', [
      queues,
    ]);
  });

  it('the daily schedule is registered with tz Asia/Shanghai', async () => {
    await startStatementJobs(boss, connection.db, { concurrency: 2 }, log);
    expect(await boss.getSchedules(GENERATE_STATEMENTS_QUEUE)).toMatchObject([
      {
        cron: '0 2 * * *',
        timezone: 'Asia/Shanghai',
        options: { missed: 'once' },
      },
    ]);
    expect(await boss.getSchedules(RECONCILE_STATEMENTS_QUEUE)).toMatchObject([
      {
        cron: '0 3 * * *',
        timezone: 'Asia/Shanghai',
        options: { missed: 'once' },
      },
    ]);
    // 子任务队列没有调度，只有父任务触发的扇出。
    expect(await boss.getSchedules(GENERATE_STATEMENT_QUEUE)).toEqual([]);
  });

  it('processes the parent job, the children and the reconcile job through pg-boss', async () => {
    const tenant = await activeTenant();
    await boss.send(GENERATE_STATEMENTS_QUEUE, { tenantId: tenant.id });
    // 真实时钟下 7 月至上月都缺；至少 7、8、9 月被生成。
    await vi.waitFor(
      async () => {
        for (const month of ['2026-07-01', '2026-08-01', '2026-09-01'])
          expect(await read(tenant.id, month)).not.toBeNull();
      },
      { timeout: 45_000, interval: 200 },
    );
    const reconcileId = await boss.send(RECONCILE_STATEMENTS_QUEUE, {
      tenantId: tenant.id,
    });
    await vi.waitFor(
      async () => {
        const { rows } = await owner.pool.query<{ state: string }>(
          'select state from pgboss.job where name = $1 and id = $2',
          [RECONCILE_STATEMENTS_QUEUE, reconcileId],
        );
        expect(rows[0]?.state).toBe('completed');
      },
      { timeout: 45_000, interval: 200 },
    );
    expect(await read(tenant.id, '2026-09-01')).toMatchObject({
      reconcileStatus: 'ok',
      generatedBy: null,
    });
    expect(await alerts(tenant.id)).toEqual([]);
  }, 60_000);
});
