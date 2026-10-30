import type {} from '../../../packages/db/test/global-setup.js';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { connect } from '@fs-billing/db';
import { connections } from '../../../packages/db/test/support.js';
import {
  NOTIFY_CRON,
  NOTIFY_TIMEZONE,
  startNotifyJobs,
  type NotifyTickOptions,
} from './notify.js';
import { NOTIFY_QUEUE, createBoss, installQueue } from './queue.js';
import { recordingBoss } from '../test/pgboss-support.js';

/**
 * 真实每分钟 cron 触发（阶段 9 验收 8）。
 *
 * 与其余测试不同：这里**不调用 `boss.send`**，也不注入假时钟，等真实时钟越过分钟边界，由 pg-boss 的
 * 定时器（`createBoss` 的配置，与 main.ts 相同）自己把 `notify-tick` 入队、由 `startNotifyJobs` 注册的真实处理函数执行。
 * 约 0.5–1.5 分钟墙钟（取决于启动时刻距下一个分钟边界多远），所以它自带超时；等待用带上限的轮询，不靠 sleep 猜时间。
 * 只等**一个**分钟边界以控制 CI 时间；「下一个分钟仍会触发」由 pg-boss 的调度本身保证，多实例测试的最后一个用例
 * 在另一个真实分钟边界上再证明一次。
 *
 * 时间点：pg-boss 每 30 秒（`cronMonitorIntervalSeconds`）做一次调度检查，「到期」窗口是 60 秒，转发任务再由
 * 5 秒轮询的内部队列取出，所以一个分钟边界之后最迟约 35 秒任务出现。断言取窗口 60 秒：晚于窗口的触发已经不是
 * 「每分钟」。
 *
 * 「恰好执行一次」靠任务 id，不靠计时：处理函数运行前记下每个任务的 id，最后核对「被处理的 id 集合 = 已完成任务的
 * id 集合，且每个 id 只出现一次」，并且只在表里没有 created / active / retry 的任务之后才核对。
 */

const { owner } = connections();
const queueConnection = connect(inject('appUrl'), {
  max: 3,
  connectionTimeoutMillis: 5000,
});
const businessConnection = connect(inject('appUrl'), {
  max: 3,
  connectionTimeoutMillis: 5000,
});
const boss: PgBoss = createBoss(queueConnection.db);
const errors: unknown[] = [];
boss.on('error', (error) => errors.push(error));

const MINUTE = 60_000;
/** 一个分钟边界之后，触发必须落在到期窗口内（pg-boss 的 OCCURRENCE_WINDOW_SECONDS）。 */
const FIRE_WINDOW_MS = MINUTE;
const WAIT_FOR_FIRE_MS = 150_000;

interface TickJob {
  id: string;
  state: string;
  createdMs: number;
  startedMs: number | null;
}

async function tickJobs(sinceMs: number): Promise<TickJob[]> {
  const { rows } = await owner.pool.query<{
    id: string;
    state: string;
    created_ms: string;
    started_ms: string | null;
  }>(
    `select id, state, extract(epoch from created_on) * 1000 as created_ms,
            extract(epoch from started_on) * 1000 as started_ms
       from pgboss.job
      where name = $1 and created_on >= to_timestamp($2 / 1000.0)
      order by created_on`,
    [NOTIFY_QUEUE, sinceMs],
  );
  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    createdMs: Number(row.created_ms),
    startedMs: row.started_ms === null ? null : Number(row.started_ms),
  }));
}

async function databaseNowMs(): Promise<number> {
  const { rows } = await owner.pool.query<{ ms: string }>(
    'select extract(epoch from clock_timestamp()) * 1000 as ms',
  );
  return Number(rows[0]!.ms);
}

describe('real cron', () => {
  const handled: string[] = [];
  let testStart = 0;
  let firstBoundary = 0;
  // 不带 mail 设置：处理函数仍是真实的（告警恢复、入发件箱），只是不分发，所以不会碰 Mailpit 和发件箱里别的邮件。
  const options: NotifyTickOptions = {
    mail: undefined,
    quietMinutes: 10,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  beforeAll(async () => {
    await installQueue(owner);
    // 其他测试文件留下的调度、任务、告警和待发邮件不属于本文件。
    await owner.pool.query('delete from pgboss.schedule');
    await owner.pool.query('delete from pgboss.job where name = any($1)', [
      [NOTIFY_QUEUE, '__pgboss__send-it'],
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
    await boss.start();
    await startNotifyJobs(
      recordingBoss(boss, handled),
      businessConnection.db,
      options,
    );
    // 注册完成之后的第一个分钟边界：此前的触发（启动时的补扫）不算。
    firstBoundary = Math.ceil((await databaseNowMs()) / MINUTE) * MINUTE;
  }, 60_000);
  afterAll(async () => {
    await boss.unschedule(NOTIFY_QUEUE).catch(() => undefined);
    await boss.stop();
    await owner.pool.query('delete from pgboss.schedule where name = $1', [
      NOTIFY_QUEUE,
    ]);
    await owner.pool.query('delete from pgboss.job where name = any($1)', [
      [NOTIFY_QUEUE, '__pgboss__send-it'],
    ]);
    await queueConnection.pool.end();
    await businessConnection.pool.end();
  });

  it('fires the registered notify-tick schedule on the real minute boundary without boss.send', async () => {
    expect(await boss.getSchedules(NOTIFY_QUEUE)).toMatchObject([
      { cron: NOTIFY_CRON, timezone: NOTIFY_TIMEZONE },
    ]);
    // 等到边界之后的任务出现，再等到没有任何排队 / 执行中 / 待重试的任务（之后才核对 id）。
    await expect
      .poll(async () => (await tickJobs(firstBoundary)).length, {
        timeout: WAIT_FOR_FIRE_MS,
        interval: 1000,
      })
      .toBeGreaterThanOrEqual(1);
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
    expect(atBoundary.length).toBeGreaterThanOrEqual(1);
    expect(all.every((job) => job.state === 'completed')).toBe(true);
    // 由调度创建：落在分钟边界之后的到期窗口内，且发生在注册之后的真实时间里。
    const [first] = atBoundary;
    expect(first!.createdMs - firstBoundary).toBeGreaterThanOrEqual(0);
    expect(first!.createdMs - firstBoundary).toBeLessThan(FIRE_WINDOW_MS);
    expect(first!.startedMs).not.toBeNull();
    // 每个分钟至多一个任务（单实例也不重复触发）。
    const perMinute = new Map<number, number>();
    for (const job of atBoundary) {
      const minute = Math.floor(job.createdMs / MINUTE);
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
    }
    expect([...perMinute.values()].every((count) => count === 1)).toBe(true);
    // 恰好执行一次：被处理的 id 集合 = 已完成任务的 id 集合，每个 id 只出现一次。
    expect([...handled].sort()).toEqual(all.map((job) => job.id).sort());
    expect(new Set(handled).size).toBe(handled.length);
    // 内部转发任务带调度标识（队列名 + 一分钟槽）。
    const forwarded = await owner.pool.query<{ singleton_key: string }>(
      `select singleton_key from pgboss.job
        where name = '__pgboss__send-it' and singleton_key like $1`,
      [`${NOTIFY_QUEUE.replaceAll('_', '\\_')}\\_\\_%`],
    );
    expect(forwarded.rows.length).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
  }, 240_000);
});
