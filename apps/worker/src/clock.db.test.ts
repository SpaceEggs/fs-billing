import type {} from '../../../packages/db/test/global-setup.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AlertKeys, recoverQuietAlerts, withSystem } from '@fs-billing/db';
import { connections, pgError } from '../../../packages/db/test/support.js';
import { createWorker } from './app.js';
import { createClockMonitor } from './clock.js';
import type { ChargeQueue } from './queue.js';

const { app: connection, owner } = connections();
const security = {
  secret: 'test-worker-key-123456',
  allowedIps: ['127.0.0.1'],
};
// /clock 不碰队列；给一个不会被调用的空实现，避免测试启动 pg-boss。
const queue: ChargeQueue = { enqueue: () => Promise.resolve() };
const worker = createWorker({
  db: connection.db,
  queue,
  security,
  alertQuietMinutes: 10,
});

interface ClockAlert {
  kind: string;
  subject_key: string;
  description: string;
  recovered_at: Date | null;
  last_seen_at: Date;
  occurrences: number;
}

async function clockAlerts(kind = 'clock_skew'): Promise<ClockAlert[]> {
  const { rows } = await owner.pool.query<ClockAlert>(
    `select kind, subject_key, description, recovered_at, last_seen_at, occurrences
     from system_alerts where kind = $1 order by started_at`,
    [kind],
  );
  return rows;
}

/** 测试里的「数据库现在」，避免用应用进程时钟猜数据库时间。 */
async function databaseMs(): Promise<number> {
  const { rows } = await owner.pool.query<{ ms: string }>(
    `select (extract(epoch from clock_timestamp()) * 1000)::bigint::text as ms`,
  );
  return Number(rows[0]!.ms);
}

/** 生成一次心跳：`skewMs` 是期望的「数据库比 sentAt 快多少」，正数表示 A 慢。 */
async function heartbeat(skewMs: number, extra: object = {}) {
  const now = await databaseMs();
  return {
    sentAt: new Date(now - skewMs).toISOString(),
    rttMs: 0,
    chronyOffsetSeconds: 0,
    chronySynchronized: true,
    ...extra,
  };
}

function postClock(
  payload: object | string,
  options: { key?: string | undefined; remoteAddress?: string } = {},
) {
  return worker.inject({
    method: 'POST',
    url: '/clock',
    headers:
      options.key === undefined
        ? {}
        : { 'content-type': 'application/json', 'x-billing-key': options.key },
    payload,
    ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
  });
}

const logger = { error: () => undefined };

beforeEach(async () => {
  await owner.pool.query(
    "delete from system_alerts where kind in ('clock_skew', 'clock_skew_critical', 'fs_heartbeat')",
  );
});
afterAll(async () => {
  await owner.pool.query(
    "delete from system_alerts where kind in ('clock_skew', 'clock_skew_critical', 'fs_heartbeat')",
  );
});

describe('POST /clock', () => {
  it('阈值内不产生告警', async () => {
    const response = await postClock(await heartbeat(100), {
      key: security.secret,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(await clockAlerts()).toEqual([]);
  });

  it('偏差 2 秒只开警告', async () => {
    expect(
      (await postClock(await heartbeat(2_000), { key: security.secret }))
        .statusCode,
    ).toBe(200);
    const [alert] = await clockAlerts('clock_skew');
    expect(alert).toMatchObject({
      kind: 'clock_skew',
      subject_key: AlertKeys.clockSkew,
      recovered_at: null,
      occurrences: 1,
    });
    expect(alert!.description).toMatch(/^服务器 A 比数据库慢 \d\.\d{3} 秒/);
    expect(await clockAlerts('clock_skew_critical')).toEqual([]);
  });

  it('从无告警直接越过 5 秒时两条都开', async () => {
    await postClock(await heartbeat(-6_000), { key: security.secret });
    const [warning] = await clockAlerts('clock_skew');
    const [critical] = await clockAlerts('clock_skew_critical');
    expect(warning).toMatchObject({
      kind: 'clock_skew',
      subject_key: AlertKeys.clockSkew,
      recovered_at: null,
      occurrences: 1,
    });
    expect(critical).toMatchObject({
      kind: 'clock_skew_critical',
      subject_key: AlertKeys.clockSkew,
      recovered_at: null,
      occurrences: 1,
    });
    expect(critical!.description).toMatch(/^服务器 A 比数据库快 \d\.\d{3} 秒/);
  });

  it('警告升级到严重时开严重告警，警告保持未恢复', async () => {
    await postClock(await heartbeat(2_000), { key: security.secret });
    expect(await clockAlerts('clock_skew_critical')).toEqual([]);

    await postClock(await heartbeat(-7_000), { key: security.secret });
    const [warning] = await clockAlerts('clock_skew');
    const [critical] = await clockAlerts('clock_skew_critical');
    expect(warning).toMatchObject({ recovered_at: null, occurrences: 2 });
    expect(critical).toMatchObject({
      kind: 'clock_skew_critical',
      subject_key: AlertKeys.clockSkew,
      recovered_at: null,
      occurrences: 1,
    });
  });

  it('回到阈值内后要满一个静默窗口才恢复', async () => {
    await postClock(await heartbeat(2_000), { key: security.secret });
    expect(await clockAlerts()).toMatchObject([{ recovered_at: null }]);

    // 刚刚还在阈值外：健康心跳不能立即恢复。
    await postClock(await heartbeat(100), { key: security.secret });
    expect(await clockAlerts()).toMatchObject([{ recovered_at: null }]);

    // 把最近一次越线事件推到 11 分钟前，模拟已经平静了一个窗口。
    await owner.pool.query(
      `update system_alerts set last_seen_at = now() - interval '11 minutes'
       where kind = 'clock_skew'`,
    );
    await postClock(await heartbeat(100), { key: security.secret });
    const [alert] = await clockAlerts();
    expect(alert!.recovered_at).not.toBeNull();
  });

  it('3 秒心跳保持警告未恢复，严重告警满窗口后单独恢复', async () => {
    await postClock(await heartbeat(6_000), { key: security.secret });
    expect(await clockAlerts('clock_skew')).toMatchObject([
      { recovered_at: null },
    ]);
    expect(await clockAlerts('clock_skew_critical')).toMatchObject([
      { recovered_at: null },
    ]);

    // 上一次越过 5 秒已是 11 分钟前；3 秒只推进警告的 last_seen_at，严重告警不再被推进。
    await owner.pool.query(
      `update system_alerts set last_seen_at = now() - interval '11 minutes'
       where kind = 'clock_skew_critical'`,
    );
    await postClock(await heartbeat(3_000), { key: security.secret });

    expect(await clockAlerts('clock_skew')).toMatchObject([
      { recovered_at: null, occurrences: 2 },
    ]);
    const [critical] = await clockAlerts('clock_skew_critical');
    expect(critical!.recovered_at).not.toBeNull();
  });

  it('低于 1 秒满静默窗口后两条都恢复', async () => {
    await postClock(await heartbeat(6_000), { key: security.secret });
    // 两条都回到阈值内已满一个窗口。
    await owner.pool.query(
      `update system_alerts set last_seen_at = now() - interval '11 minutes'
       where kind in ('clock_skew', 'clock_skew_critical')`,
    );
    await postClock(await heartbeat(100), { key: security.secret });
    const [warning] = await clockAlerts('clock_skew');
    const [critical] = await clockAlerts('clock_skew_critical');
    expect(warning!.recovered_at).not.toBeNull();
    expect(critical!.recovered_at).not.toBeNull();
  });

  it('没有心跳时静默扫描不恢复两种偏差告警', async () => {
    await postClock(await heartbeat(6_000), { key: security.secret });
    await owner.pool.query(
      `update system_alerts set last_seen_at = now() - interval '11 minutes'
       where kind in ('clock_skew', 'clock_skew_critical')`,
    );
    await withSystem(connection.db, (tx) =>
      recoverQuietAlerts(tx, { quietMinutes: 10 }),
    );
    expect(await clockAlerts('clock_skew')).toMatchObject([
      { recovered_at: null },
    ]);
    expect(await clockAlerts('clock_skew_critical')).toMatchObject([
      { recovered_at: null },
    ]);
  });

  it('心跳超过 5 分钟没到开 fs_heartbeat，重新到达后恢复', async () => {
    let now = new Date('2026-11-04T00:00:00.000Z');
    const monitor = createClockMonitor({
      db: connection.db,
      logger,
      now: () => now,
    });

    now = new Date(now.getTime() + 4 * 60_000);
    expect(await monitor.check()).toBe(false);
    expect(await clockAlerts('fs_heartbeat')).toEqual([]);

    now = new Date(now.getTime() + 61_000);
    expect(await monitor.check()).toBe(true);
    const [missing] = await clockAlerts('fs_heartbeat');
    expect(missing).toMatchObject({
      kind: 'fs_heartbeat',
      subject_key: AlertKeys.fsHeartbeat,
      recovered_at: null,
      occurrences: 1,
    });
    expect(missing!.description).toContain('超过 5 分钟未到达');

    await postClock(await heartbeat(100), { key: security.secret });
    const [recovered] = await clockAlerts('fs_heartbeat');
    expect(recovered!.recovered_at).not.toBeNull();
  });

  it('Worker 重启不误报心跳，也不丢掉已开心跳告警的恢复', async () => {
    let now = new Date('2026-11-04T00:00:00.000Z');
    const before = createClockMonitor({
      db: connection.db,
      logger,
      now: () => now,
    });
    now = new Date(now.getTime() + 6 * 60_000);
    expect(await before.check()).toBe(true);
    expect(await clockAlerts('fs_heartbeat')).toMatchObject([
      { recovered_at: null },
    ]);

    // 重启：新的监视器从启动时刻起算，不会因为内存清空而立刻误报。
    now = new Date(now.getTime() + 60_000);
    const after = createClockMonitor({
      db: connection.db,
      logger,
      now: () => now,
    });
    now = new Date(now.getTime() + 60_000);
    expect(await after.check()).toBe(false);
    expect(await clockAlerts('fs_heartbeat')).toMatchObject([
      { recovered_at: null },
    ]);

    // 已开的告警仍由下一次 /clock 恢复，不依赖重启前的内存状态。
    await postClock(await heartbeat(100), { key: security.secret });
    const [recovered] = await clockAlerts('fs_heartbeat');
    expect(recovered!.recovered_at).not.toBeNull();
  });

  it('错误密钥与白名单外的地址在解析请求体前拒绝', async () => {
    const body = await heartbeat(100);
    expect((await postClock(body)).statusCode).toBe(401);
    expect((await postClock(body, { key: 'wrong' })).statusCode).toBe(401);
    expect(
      (
        await postClock(body, {
          key: security.secret,
          remoteAddress: '10.1.2.3',
        })
      ).statusCode,
    ).toBe(403);
    expect(await clockAlerts()).toEqual([]);
  });

  it('只回固定形状，不回显租户、数据库时间或偏差', async () => {
    const response = await postClock(
      await heartbeat(2_000, { tenant: 'ABC001', tenantId: 'x' }),
      { key: security.secret },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.body).not.toContain('ABC001');
    expect(response.body).not.toContain('skew');
    expect(await clockAlerts()).toMatchObject([{ recovered_at: null }]);
  });

  it('请求体不符合 schema 时返回 400，不写告警', async () => {
    for (const body of [
      {},
      {
        sentAt: 'not-a-time',
        rttMs: 0,
        chronyOffsetSeconds: 0,
        chronySynchronized: true,
      },
      { ...(await heartbeat(0)), rttMs: -1 },
    ])
      expect((await postClock(body, { key: security.secret })).statusCode).toBe(
        400,
      );
    expect(await clockAlerts()).toEqual([]);
    // 格式错误也已在守卫之后，不泄漏 schema 细节。
    const bad = await postClock({}, { key: security.secret });
    expect(bad.json()).toEqual({ error: '时钟请求格式错误' });
  });

  it('迁移接受 clock_skew_critical，并仍拒绝未知种类', async () => {
    await owner.pool.query(
      `insert into system_alerts (kind, description, subject_key)
       values ('clock_skew_critical', 'x', 'migration-check')`,
    );
    expect(
      await pgError(
        owner.pool.query(
          `insert into system_alerts (kind, description, subject_key)
           values ('clock_skew_unknown', 'x', 'migration-check')`,
        ),
      ),
    ).toMatchObject({ code: '23514', constraint: 'system_alerts_kind_check' });
  });
});
