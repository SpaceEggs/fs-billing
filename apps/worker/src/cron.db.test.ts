import type {} from '../../../packages/db/test/global-setup.js';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { connect } from '@fs-billing/db';
import { connections } from '../../../packages/db/test/support.js';
import { createMailTransport } from './mail.js';
import {
  NOTIFY_CRON,
  NOTIFY_TIMEZONE,
  startNotifyJobs,
  type NotifyTickOptions,
} from './notify.js';
import { NOTIFY_QUEUE, createBoss, installQueue } from './queue.js';
import { mailpitSettings } from '../test/mail-support.js';

/**
 * 真实每分钟 cron 触发（阶段 9 验收 8）。
 *
 * 与其余测试不同：这里**不调用 `boss.send`**，也不注入假时钟，等真实时钟越过分钟边界，由 pg-boss 的
 * 定时器（`createBoss` 的配置，与 main.ts 相同）自己把 `notify-tick` 入队、由 `startNotifyJobs` 注册的真实处理函数执行。
 * 约 1–3 分钟墙钟，所以它是仅有的几个自带超时的测试；等待用轮询，上限固定，不靠 sleep 猜时间。
 *
 * 时间点：pg-boss 每 30 秒（`cronMonitorIntervalSeconds`）做一次调度检查，「到期」窗口是 60 秒，转发任务再由
 * 5 秒轮询的内部队列取出，所以一个分钟边界之后最迟约 35 秒任务出现。断言取窗口 60 秒：晚于窗口的触发已经不是
 * 「每分钟」。
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
  let handlerRuns = 0;
  let firstBoundary = 0;
  const options: NotifyTickOptions = {
    // 带上 mail 设置，处理函数每次运行恰好建一次传输：用它数「处理函数被调用了几次」。
    mail: mailpitSettings(),
    createTransport: (settings) => {
      // 启动时补扫出的任务（早于第一个边界）不算。
      if (Date.now() >= firstBoundary) handlerRuns++;
      return createMailTransport(settings);
    },
    quietMinutes: 10,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  beforeAll(async () => {
    await installQueue(owner);
    await owner.pool.query('delete from pgboss.job where name = $1', [
      NOTIFY_QUEUE,
    ]);
    // 离分钟边界太近时先让它过去：启动补扫的任务和「第一个边界」的任务不能混在一起。
    const toBoundary = MINUTE - (Date.now() % MINUTE);
    if (toBoundary < 5000)
      await new Promise((resolve) => setTimeout(resolve, toBoundary + 500));
    await boss.start();
    await startNotifyJobs(boss, businessConnection.db, options);
    // 注册完成之后的第一个分钟边界：之前的触发（启动时的补扫）不算。
    firstBoundary = Math.ceil((await databaseNowMs()) / MINUTE) * MINUTE;
  }, 60_000);
  afterAll(async () => {
    await boss.unschedule(NOTIFY_QUEUE).catch(() => undefined);
    await boss.stop();
    await queueConnection.pool.end();
    await businessConnection.pool.end();
  });

  it('fires the registered notify-tick schedule on the real minute boundary without boss.send', async () => {
    expect(await boss.getSchedules(NOTIFY_QUEUE)).toMatchObject([
      { cron: NOTIFY_CRON, timezone: NOTIFY_TIMEZONE },
    ]);
    await expect
      .poll(async () => (await tickJobs(firstBoundary)).length, {
        timeout: WAIT_FOR_FIRE_MS,
        interval: 1000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(async () => (await tickJobs(firstBoundary))[0]?.state, {
        timeout: 30_000,
        interval: 500,
      })
      .toBe('completed');
    const [job, ...rest] = await tickJobs(firstBoundary);
    // 由调度创建：落在分钟边界之后的到期窗口内，且发生在注册之后的真实时间里。
    expect(job!.createdMs - firstBoundary).toBeGreaterThanOrEqual(0);
    expect(job!.createdMs - firstBoundary).toBeLessThan(FIRE_WINDOW_MS);
    expect(job!.startedMs).not.toBeNull();
    // 这一分钟只有一个任务，处理函数只运行一次。
    expect(
      rest.filter((item) => item.createdMs < firstBoundary + MINUTE),
    ).toHaveLength(0);
    expect(handlerRuns).toBe(1);
    // 内部转发任务带调度标识（队列名 + 一分钟槽）。
    const forwarded = await owner.pool.query<{ singleton_key: string }>(
      `select singleton_key from pgboss.job
        where name = '__pgboss__send-it' and singleton_key like $1`,
      [`${NOTIFY_QUEUE.replaceAll('_', '\\_')}\\_\\_%`],
    );
    expect(forwarded.rows.length).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('keeps firing every minute: the next minute produces exactly one more job', async () => {
    const second = firstBoundary + MINUTE;
    await expect
      .poll(
        async () =>
          (await tickJobs(second)).filter((job) => job.state === 'completed')
            .length,
        { timeout: WAIT_FOR_FIRE_MS, interval: 1000 },
      )
      .toBe(1);
    const jobs = await tickJobs(firstBoundary);
    const perMinute = new Map<number, number>();
    for (const job of jobs) {
      const minute = Math.floor(job.createdMs / MINUTE);
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
    }
    // 每个出现过任务的分钟恰好一个；没有重复触发。
    expect([...perMinute.values()].every((count) => count === 1)).toBe(true);
    expect(perMinute.size).toBeGreaterThanOrEqual(2);
    const latest = jobs.at(-1)!;
    expect(latest.createdMs - second).toBeGreaterThanOrEqual(0);
    expect(latest.createdMs - second).toBeLessThan(FIRE_WINDOW_MS);
    expect(handlerRuns).toBe(jobs.length);
    expect(errors).toEqual([]);
  }, 240_000);
});
