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
import { countStatements, recordingBoss } from '../test/pgboss-support.js';

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
// 每个实例的池各数各的「监控认领」语句条数：证明 supervise 时两个实例都真的参与了争抢（必须在池第一次使用之前挂上）。
const claimsA = countStatements(queueA.pool, /SET monitor_claim_on/i);
const claimsB = countStatements(queueB.pool, /SET monitor_claim_on/i);
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
// 不带 mail 设置：处理函数仍是真实的（告警恢复、入发件箱），只是不分发——发件箱的分发由下面的专门用例控制，
// 不会有第三个分发器在同一时刻抢邮件。
const tickOptions = (): NotifyTickOptions => ({
  mail: undefined,
  quietMinutes: 10,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});
/** 每个实例的 notify-tick 处理函数处理过的任务 id。 */
const handledA: string[] = [];
const handledB: string[] = [];

let testStart = 0;
let firstBoundary = 0;
const databaseNowMs = async () =>
  Number(
    (
      await owner.pool.query<{ ms: string }>(
        'select extract(epoch from clock_timestamp()) * 1000 as ms',
      )
    ).rows[0]!.ms,
  );

beforeAll(async () => {
  await ensureCdrPartitions(app.db, {
    moment: new Date(Date.now() - 3600000),
  });
  await installQueue(owner);
  // 其他测试文件留下的调度、任务、告警和待发邮件不属于本文件；本文件自己注册要用的。
  await owner.pool.query('delete from pgboss.schedule');
  await owner.pool.query('delete from pgboss.job where name = any($1)', [
    [NOTIFY_QUEUE, ARCHIVE_QUEUE, '__pgboss__send-it'],
  ]);
  await owner.pool.query('delete from system_alerts');
  await owner.pool.query(
    "update email_outbox set status = 'skipped', skip_reason = 'test cleanup', sent_at = null, locked_until = null where status in ('pending', 'sending', 'failed')",
  );
  // 离分钟边界太近时先让它过去：启动补扫的任务和「第一个边界」的任务不能混在一起。
  const toBoundary = MINUTE - (Date.now() % MINUTE);
  if (toBoundary < 5000)
    await new Promise((resolve) => setTimeout(resolve, toBoundary + 500));
  testStart = await databaseNowMs();
  await Promise.all(bosses.map((boss) => boss.start()));
  await startNotifyJobs(
    recordingBoss(bossA, handledA),
    businessA.db,
    tickOptions(),
  );
  await startNotifyJobs(
    recordingBoss(bossB, handledB),
    businessB.db,
    tickOptions(),
  );
  // 注册完成之后的第一个分钟边界：此前的触发（启动时的补扫）不算。
  firstBoundary = Math.ceil((await databaseNowMs()) / MINUTE) * MINUTE;
}, 60_000);
afterAll(async () => {
  await owner.pool.query('delete from pgboss.schedule where name = $1', [
    NOTIFY_QUEUE,
  ]);
  await Promise.all(bosses.map((boss) => boss.stop()));
  await owner.pool.query('delete from pgboss.job where name = any($1)', [
    [NOTIFY_QUEUE, '__pgboss__send-it'],
  ]);
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
    // 两个实例都参与是确定的，不是碰运气：两边的工作者都在发送之前启动，每次只取 1 个任务、每个任务处理 200 毫秒，
    // 40 个任务要两边合起来约 4 秒才处理完，而每个实例每 0.5 秒就轮询一次。
    const handler = (instance: string) => async (jobs: { data: unknown }[]) => {
      for (const job of jobs) {
        const data = z.object({ callUuid: z.string() }).parse(job.data);
        runs.set(data.callUuid, [...(runs.get(data.callUuid) ?? []), instance]);
        await chargeCdr(app.db, job.data);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };
    await Promise.all([
      bossA.work(
        CHARGE_QUEUE,
        { batchSize: 1, pollingIntervalSeconds: 0.5 },
        handler('A'),
      ),
      bossB.work(
        CHARGE_QUEUE,
        { batchSize: 1, pollingIntervalSeconds: 0.5 },
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
    const who = [...runs.values()].flat();
    expect(who).toContain('A');
    expect(who).toContain('B');
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
    const claimsBefore = [claimsA(), claimsB()];
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
      // 三轮里两个实例都发出了认领语句（一个拿到，另一个被拒），不是只有一个实例在做事。
      expect(claimsA() - claimsBefore[0]!).toBeGreaterThanOrEqual(3);
      expect(claimsB() - claimsBefore[1]!).toBeGreaterThanOrEqual(3);
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
    const recipient = (index: number) => `${mark}-${index}@example.test`;
    // 到期时间放在过去：next_attempt_at 默认取数据库的 now()，而认领用的是 Node 的时钟，
    // 两个时钟（尤其是 Docker Desktop 的虚拟机）相差几秒就会让刚入队的邮件「还没到期」。
    const at = new Date(Date.now() - 60_000);
    const queued = await withSystem(app.db, async (tx) => {
      const rows = [];
      for (let index = 0; index < emails; index++)
        rows.push(
          await enqueueEmail(tx, {
            dedupeKey: `${mark}:${index}`,
            template: 'test',
            params: { sentAt: at.toISOString() },
            recipients: [recipient(index)],
            at,
          }),
        );
      return rows;
    });
    // 每个分发器一次最多 8 封：12 封分在两个分发器手里（一个 8，另一个至少 4），所以两边都参与是确定的；
    // 任何重复认领都会让认领数之和超过 12、让 Mailpit 收到多于 12 封。
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
    const state = async () =>
      (
        await owner.pool.query<Record<string, unknown>>(
          `select status, attempts, last_error, next_attempt_at, locked_until, now() as db_now
             from email_outbox where dedupe_key like $1 order by dedupe_key`,
          [`${mark}:%`],
        )
      ).rows;
    try {
      expect(one.claimed).toBeGreaterThan(0);
      expect(two.claimed).toBeGreaterThan(0);
      expect(one.claimed + two.claimed).toBe(emails);
      expect(one.retried + one.failed + two.retried + two.failed).toBe(0);
      expect(one.sent + two.sent).toBe(emails);
    } catch (error) {
      // 偶发失败时留下现场：每封的状态、次数、最后的错误，以及两个分发器的返回。
      throw new Error(
        `发件箱分发异常：${JSON.stringify({ one, two, state: await state() })}`,
        { cause: error },
      );
    }
    const { rows } = await owner.pool.query(
      `select count(*)::int as n, count(distinct attempts)::int as attempt_values, min(attempts) as attempts
         from email_outbox where dedupe_key like $1 and status = 'sent'`,
      [`${mark}:%`],
    );
    expect(rows).toEqual([{ n: emails, attempt_values: 1, attempts: 1 }]);
    expect(queued).toHaveLength(emails);
    // Mailpit 只数本用例的收件人：每个收件人恰好一封。
    const mine = (await mailpitMessages())
      .flatMap((message) => message.To.map((to) => to.Address))
      .filter((address) => address.startsWith(mark));
    expect(mine.sort()).toEqual(
      Array.from({ length: emails }, (_, index) => recipient(index)).sort(),
    );
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
    const tickJobs = async (since: number) =>
      (
        await owner.pool.query<{
          id: string;
          state: string;
          created_ms: string;
        }>(
          `select id, state, extract(epoch from created_on) * 1000 as created_ms from pgboss.job
            where name = $1 and created_on >= to_timestamp($2 / 1000.0) order by created_on`,
          [NOTIFY_QUEUE, since],
        )
      ).rows;
    await expect
      .poll(async () => (await tickJobs(firstBoundary)).length, {
        timeout: 150_000,
        interval: 1000,
      })
      .toBeGreaterThanOrEqual(1);
    // 之后才核对 id：表里没有 created / active / retry 的任务了。
    await expect
      .poll(
        async () =>
          (await tickJobs(testStart)).filter((job) =>
            ['created', 'active', 'retry'].includes(job.state),
          ).length,
        { timeout: 30_000, interval: 500 },
      )
      .toBe(0);
    const all = await tickJobs(testStart);
    const atBoundary = await tickJobs(firstBoundary);
    expect(all.every((job) => job.state === 'completed')).toBe(true);
    // 两个实例都注册了调度，每个分钟仍只有一个任务。
    const perMinute = new Map<number, number>();
    for (const job of atBoundary) {
      const minute = Math.floor(Number(job.created_ms) / MINUTE);
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
    }
    expect([...perMinute.values()].every((count) => count === 1)).toBe(true);
    // 恰好执行一次：两个实例处理过的 id 合起来 = 已完成任务的 id，每个 id 只出现一次（不论落在哪个实例）。
    const handled = [...handledA, ...handledB];
    expect([...handled].sort()).toEqual(all.map((job) => job.id).sort());
    expect(new Set(handled).size).toBe(handled.length);
    const { rows: schedules } = await owner.pool.query(
      'select count(*)::int as n from pgboss.schedule where name = $1',
      [NOTIFY_QUEUE],
    );
    expect(schedules).toEqual([{ n: 1 }]);
    expect(errors).toEqual([]);
  }, 240_000);
});
