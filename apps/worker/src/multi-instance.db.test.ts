import type {} from '../../../packages/db/test/global-setup.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import {
  connect,
  createRateVersion,
  ensureCdrPartitions,
  enqueueEmail,
  withSystem,
} from '@fs-billing/db';
import { cdrResponseSchema } from '@fs-billing/shared';
import { rate } from '@fs-billing/rating';
import {
  connections,
  createTenant,
  deferred,
} from '../../../packages/db/test/support.js';
import { createWorker } from './app.js';
import { chargeCdr } from './charge.js';
import { createMailTransport, dispatchOutbox } from './mail.js';
import { startNotifyJobs, type NotifyTickOptions } from './notify.js';
import {
  ARCHIVE_QUEUE,
  CHARGE_QUEUE,
  NOTIFY_QUEUE,
  RECONCILE_QUEUE,
  chargeQueue,
  createBoss,
  installQueue,
} from './queue.js';
import {
  clearMailpit,
  mailpitMessages,
  mailpitSettings,
} from '../test/mail-support.js';

/**
 * 多实例安全（阶段 9 验收 9）。
 *
 * 补丁让 pg-boss 不再取 `pg_advisory_*` 锁（应用角色没有这个权限）。这里起**两个** `PgBoss` 实例，
 * 各自独立的连接池、配置同 `main.ts`（`createBoss`），指向同一个库、同一批队列和调度，证明去掉 advisory 锁之后
 * 跨实例的排他仍然成立：定时触发、取任务、`supervise` 的超时处理、发件箱认领、`exclusive` 队列。
 * 任何一项失败，退路见设计「pg-boss 关闭 advisory 锁与多实例」。
 */

const { app, owner } = connections();
const poolOptions = { max: 4, connectionTimeoutMillis: 5000 };
const queueA = connect(inject('appUrl'), poolOptions);
const queueB = connect(inject('appUrl'), poolOptions);
const businessA = connect(inject('appUrl'), poolOptions);
const businessB = connect(inject('appUrl'), poolOptions);
const bossA: PgBoss = createBoss(queueA.db);
const bossB: PgBoss = createBoss(queueB.db);
const bosses = [bossA, bossB];
const errors: unknown[] = [];
for (const boss of bosses) boss.on('error', (error) => errors.push(error));

const security = {
  secret: 'test-worker-key-123456',
  allowedIps: ['127.0.0.1'],
};
const template = z
  .object({ variables: z.record(z.string(), z.unknown()) })
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

const MINUTE = 60_000;
const tickRuns = [0, 0];
const tickOptions = (index: number): NotifyTickOptions => ({
  // 带上 mail 设置，处理函数每次运行恰好建一次传输：用它数每个实例的处理函数调用次数。
  mail: mailpitSettings(),
  createTransport: (settings) => {
    // 启动时补扫出的任务（早于第一个边界）不算。
    if (Date.now() >= firstBoundary) tickRuns[index]!++;
    return createMailTransport(settings);
  },
  quietMinutes: 10,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

let firstBoundary = 0;

beforeAll(async () => {
  await ensureCdrPartitions(app.db, {
    moment: new Date(Date.now() - 3600000),
  });
  await installQueue(owner);
  // 其他测试文件留下的调度和任务不属于本文件；本文件自己注册要用的。
  await owner.pool.query('delete from pgboss.schedule');
  await owner.pool.query('delete from pgboss.job where name = any($1)', [
    [NOTIFY_QUEUE, ARCHIVE_QUEUE],
  ]);
  // 离分钟边界太近时先让它过去：启动补扫的任务和「第一个边界」的任务不能混在一起。
  const toBoundary = MINUTE - (Date.now() % MINUTE);
  if (toBoundary < 5000)
    await new Promise((resolve) => setTimeout(resolve, toBoundary + 500));
  await Promise.all(bosses.map((boss) => boss.start()));
  await startNotifyJobs(bossA, businessA.db, tickOptions(0));
  await startNotifyJobs(bossB, businessB.db, tickOptions(1));
  const { rows } = await owner.pool.query<{ ms: string }>(
    'select extract(epoch from clock_timestamp()) * 1000 as ms',
  );
  // 注册完成之后的第一个分钟边界：此前的触发（启动时的补扫）不算。
  firstBoundary = Math.ceil(Number(rows[0]!.ms) / MINUTE) * MINUTE;
}, 60_000);
afterAll(async () => {
  await owner.pool.query('delete from pgboss.schedule where name = $1', [
    NOTIFY_QUEUE,
  ]);
  await Promise.all(bosses.map((boss) => boss.stop()));
  await Promise.all(
    [queueA, queueB, businessA, businessB].map(({ pool }) => pool.end()),
  );
});
beforeEach(() => {
  errors.length = 0;
});

describe('两个 PgBoss 实例', () => {
  it('charge jobs run exactly once across both instances and the ledger matches the balance', async () => {
    const tenant = await createTenant(app, 'CNY');
    await withSystem(app.db, (tx) =>
      createRateVersion(
        tx,
        tenant.id,
        [
          {
            iso: '',
            description: '',
            prefix: '447',
            country: '英国',
            perMinute: rate('CNY', '0.0480'),
          },
        ],
        { effectiveFrom: new Date('2026-09-01T00:00:00Z') },
      ),
    );
    // 前面的测试文件留下的、从未被处理的扣费任务不属于本测试，也不该被这两个实例捡走。
    await owner.pool.query('delete from pgboss.job where name = $1', [
      CHARGE_QUEUE,
    ]);
    const runs = new Map<string, string[]>();
    const handler = (instance: string) => async (jobs: { data: unknown }[]) => {
      for (const job of jobs) {
        const data = z.object({ callUuid: z.string() }).parse(job.data);
        runs.set(data.callUuid, [...(runs.get(data.callUuid) ?? []), instance]);
        await chargeCdr(app.db, job.data);
      }
    };
    await Promise.all([
      bossA.work(
        CHARGE_QUEUE,
        { batchSize: 3, pollingIntervalSeconds: 0.5 },
        handler('A'),
      ),
      bossB.work(
        CHARGE_QUEUE,
        { batchSize: 3, pollingIntervalSeconds: 0.5 },
        handler('B'),
      ),
    ]);
    const worker = createWorker({
      db: app.db,
      queue: chargeQueue(bossA),
      security,
    });
    const uuids = Array.from({ length: 40 }, () => randomUUID());
    try {
      const start = Math.floor(Date.now() / 1000) - 3600;
      const responses = await Promise.all(
        uuids.map((uuid) =>
          worker.inject({
            method: 'POST',
            url: '/cdr',
            headers: {
              'content-type': 'application/json',
              'x-billing-key': security.secret,
            },
            payload: JSON.stringify({
              variables: {
                ...template.variables,
                start_epoch: start,
                answer_epoch: start + 9,
                end_epoch: start + 199,
                billing_tenant: tenant.code,
                uuid,
              },
            }),
          }),
        ),
      );
      expect(
        responses.map((r) => cdrResponseSchema.parse(r.json()).status),
      ).toEqual(Array(uuids.length).fill('queued'));
      await expect
        .poll(
          async () =>
            (
              await owner.pool.query<{ n: number }>(
                `select count(*)::int as n from pgboss.job
                  where name = $1 and data->>'callUuid' = any($2::text[]) and state = 'completed'`,
                [CHARGE_QUEUE, uuids],
              )
            ).rows[0]!.n,
          { timeout: 60_000, interval: 500 },
        )
        .toBe(uuids.length);
    } finally {
      await worker.close();
      await Promise.all(
        bosses.map((boss) => boss.offWork(CHARGE_QUEUE, { wait: true })),
      );
    }
    // 每个任务恰好执行一次，没有重试。
    expect([...runs.keys()].sort()).toEqual([...uuids].sort());
    expect([...runs.values()].every((who) => who.length === 1)).toBe(true);
    const { rows: jobs } = await owner.pool.query(
      `select distinct retry_count from pgboss.job where name = $1 and data->>'callUuid' = any($2::text[])`,
      [CHARGE_QUEUE, uuids],
    );
    expect(jobs).toEqual([{ retry_count: 0 }]);
    // 每个通话恰好一笔流水，余额等于流水合计。
    const { rows: ledger } = await owner.pool.query(
      `select count(*)::int as entries, count(distinct idempotency_key)::int as keys,
              coalesce(sum(amount), 0)::text as total
         from ledger_entries where tenant_id = $1 and idempotency_key = any($2::text[])`,
      [tenant.id, uuids.map((uuid) => `call:${uuid}`)],
    );
    expect(ledger).toEqual([
      { entries: uuids.length, keys: uuids.length, total: '-7.680' },
    ]);
    const { rows: balance } = await owner.pool.query(
      'select balance::text from tenant_balances where tenant_id = $1',
      [tenant.id],
    );
    expect(balance).toEqual([{ balance: '-7.680' }]);
    expect(errors).toEqual([]);
  }, 120_000);

  it('concurrent supervise passes time out each expired job once', async () => {
    const tag = randomUUID();
    const ids = (
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          bossA.send(RECONCILE_QUEUE, { tag, index }),
        ),
      )
    ).map((id) => id!);
    try {
      // 超时处理是「删除再按重试/失败重新插入」：两个实例同时做，每个任务仍恰好一行、恰好转一次状态，
      // 没有丢失、没有重复、没有死锁错误。第 1、2 轮还有重试额度，第 3 轮额度用完进入 failed。
      const expire = (retryCount: number) =>
        owner.pool.query(
          `update pgboss.job set state = 'active', started_on = now() - interval '2 hours', retry_count = $3
            where name = $1 and id = any($2::uuid[])`,
          [RECONCILE_QUEUE, ids, retryCount],
        );
      const settle = async () => {
        // 超时处理由队列的「监控认领」决定谁来做（每队列每 60 秒一次，认领带 SKIP LOCKED）；
        // 清掉认领时间，让这一轮两个实例真的争同一个认领。
        await owner.pool.query(
          'update pgboss.queue set monitor_claim_on = null, monitor_on = null where name = $1',
          [RECONCILE_QUEUE],
        );
        await Promise.all([
          bossA.supervise(RECONCILE_QUEUE),
          bossB.supervise(RECONCILE_QUEUE),
        ]);
        return (
          await owner.pool.query<{
            state: string;
            retry_count: number;
            message: string;
            jobs: number;
            ids: number;
          }>(
            `select state, retry_count, output->'value'->>'message' as message, count(*)::int as jobs,
                    count(distinct id)::int as ids
               from pgboss.job where name = $1 and data->>'tag' = $2
              group by 1, 2, 3`,
            [RECONCILE_QUEUE, tag],
          )
        ).rows;
      };
      for (const retryCount of [0, 1]) {
        await expire(retryCount);
        expect(await settle()).toEqual([
          {
            state: 'retry',
            retry_count: retryCount,
            message: 'job timed out',
            jobs: ids.length,
            ids: ids.length,
          },
        ]);
      }
      await expire(3);
      expect(await settle()).toEqual([
        {
          state: 'failed',
          retry_count: 3,
          message: 'job timed out',
          jobs: ids.length,
          ids: ids.length,
        },
      ]);
      expect(errors).toEqual([]);
    } finally {
      await owner.pool.query(
        'delete from pgboss.job where name = $1 and id = any($2::uuid[])',
        [RECONCILE_QUEUE, ids],
      );
    }
  }, 60_000);

  it('two dispatchers deliver every outbox email exactly once', async () => {
    const emails = 12;
    await clearMailpit();
    await owner.pool.query(
      "update email_outbox set status = 'skipped', skip_reason = 'test cleanup', sent_at = null, locked_until = null where status in ('pending', 'sending', 'failed')",
    );
    const mark = `multi-${randomUUID()}`;
    const queued = await withSystem(app.db, async (tx) => {
      const rows = [];
      for (let index = 0; index < emails; index++)
        rows.push(
          await enqueueEmail(tx, {
            dedupeKey: `${mark}:${index}`,
            template: 'test',
            params: { sentAt: new Date().toISOString() },
            recipients: ['ops@example.test'],
          }),
        );
      return rows;
    });
    // 每个分发器一次最多 8 封：两个加起来够发完，但任何重复认领都会让 Mailpit 收到多于 12 封。
    const settings = mailpitSettings({ ratePerTick: 8 });
    const dispatch = async (db: typeof businessA.db) => {
      const transport = createMailTransport(settings);
      try {
        return await dispatchOutbox(db, { transport, settings });
      } finally {
        transport.close();
      }
    };
    const [one, two] = await Promise.all([
      dispatch(businessA.db),
      dispatch(businessB.db),
    ]);
    // 分钟边界上的 notify-tick 也可能同时在发，所以认领数只能是不超过总数的和；关键是不重复。
    expect(one.sent + two.sent).toBeLessThanOrEqual(emails);
    try {
      await expect
        .poll(
          async () =>
            (
              await owner.pool.query<{ n: number }>(
                `select count(*)::int as n from email_outbox where dedupe_key like $1 and status = 'sent'`,
                [`${mark}:%`],
              )
            ).rows[0]!.n,
          { timeout: 20_000, interval: 250 },
        )
        .toBe(emails);
    } catch (error) {
      // 偶发失败时留下现场：每封的状态、次数、最后的错误，以及两个分发器的返回。
      const { rows: state } = await owner.pool.query(
        `select status, attempts, last_error, next_attempt_at, locked_until, now() as db_now
           from email_outbox where dedupe_key like $1 order by dedupe_key`,
        [`${mark}:%`],
      );
      throw new Error(
        `发件箱未全部发出：${JSON.stringify({ one, two, state })}`,
        { cause: error },
      );
    }
    const { rows } = await owner.pool.query(
      `select distinct attempts from email_outbox where dedupe_key like $1`,
      [`${mark}:%`],
    );
    expect(rows).toEqual([{ attempts: 1 }]);
    expect(queued).toHaveLength(emails);
    expect(await mailpitMessages()).toHaveLength(emails);
    expect(errors).toEqual([]);
  }, 60_000);

  it('the exclusive archive queue lets only one task run when both instances trigger it', async () => {
    let runs = 0;
    const release = deferred();
    const handler = async () => {
      runs++;
      await release.promise;
    };
    await Promise.all(
      bosses.map((boss) =>
        boss.work(ARCHIVE_QUEUE, { pollingIntervalSeconds: 0.5 }, handler),
      ),
    );
    try {
      const sent = await Promise.all([
        bossA.send(ARCHIVE_QUEUE),
        bossB.send(ARCHIVE_QUEUE),
        bossA.send(ARCHIVE_QUEUE),
        bossB.send(ARCHIVE_QUEUE),
      ]);
      // exclusive：同一时刻只允许一个任务排队、重试或执行，其余的 send 返回 null。
      expect(sent.filter((id) => id !== null)).toHaveLength(1);
      await expect.poll(() => runs, { timeout: 10_000 }).toBe(1);
      // 执行期间再触发也被挡掉；放行后任务完成，总共只运行过一次。
      expect(await bossB.send(ARCHIVE_QUEUE)).toBeNull();
      release.resolve();
      await expect
        .poll(
          async () =>
            (
              await owner.pool.query<{ state: string }>(
                'select state from pgboss.job where name = $1',
                [ARCHIVE_QUEUE],
              )
            ).rows,
          { timeout: 10_000, interval: 250 },
        )
        .toEqual([{ state: 'completed' }]);
      expect(runs).toBe(1);
    } finally {
      release.resolve();
      await Promise.all(
        bosses.map((boss) => boss.offWork(ARCHIVE_QUEUE, { wait: true })),
      );
      await owner.pool.query('delete from pgboss.job where name = $1', [
        ARCHIVE_QUEUE,
      ]);
    }
    expect(errors).toEqual([]);
  }, 60_000);

  // 放在最后：等真实时钟越过分钟边界，其余检查已经在等待期间做完。
  it('both instances schedule notify-tick but one real minute yields one job run once', async () => {
    await expect
      .poll(
        async () =>
          (
            await owner.pool.query<{ n: number }>(
              `select count(*)::int as n from pgboss.job
                where name = $1 and created_on >= to_timestamp($2 / 1000.0) and state = 'completed'`,
              [NOTIFY_QUEUE, firstBoundary],
            )
          ).rows[0]!.n,
        { timeout: 150_000, interval: 1000 },
      )
      .toBeGreaterThanOrEqual(1);
    const { rows } = await owner.pool.query<{
      minute: string;
      jobs: number;
    }>(
      `select floor(extract(epoch from created_on) / 60)::text as minute, count(*)::int as jobs
         from pgboss.job where name = $1 and created_on >= to_timestamp($2 / 1000.0)
        group by 1 order by 1`,
      [NOTIFY_QUEUE, firstBoundary],
    );
    // 两个实例都注册了调度，每个分钟仍只有一个任务。
    expect(rows.every((row) => row.jobs === 1)).toBe(true);
    // 处理函数在两个实例合起来只运行任务数那么多次。
    expect(tickRuns[0]! + tickRuns[1]!).toBe(rows.length);
    const { rows: schedules } = await owner.pool.query(
      'select count(*)::int as n from pgboss.schedule where name = $1',
      [NOTIFY_QUEUE],
    );
    expect(schedules).toEqual([{ n: 1 }]);
    expect(errors).toEqual([]);
  }, 240_000);
});
