import type { FastifyBaseLogger } from 'fastify';
import {
  AlertKeys,
  databaseNow,
  raiseAlert,
  recoverAlert,
  recoverClockSkewAfterQuiet,
  withSystem,
  type Db,
} from '@fs-billing/db';
import {
  CLOCK_CRITICAL_MS,
  CLOCK_HEARTBEAT_MISSING_MS,
  CLOCK_WARNING_MS,
  type ClockRequest,
} from '@fs-billing/shared';

type Logger = Pick<FastifyBaseLogger, 'error'>;

export interface ClockHeartbeatMonitor {
  /** `/clock` 成功处理后记下数据库时间（不是应用进程时间）。 */
  record(at: Date): void;
  /** 心跳超过 5 分钟没到就开 `fs_heartbeat`；已开时由 `raiseAlert` 合并。 */
  check(): Promise<boolean>;
}

/**
 * 心跳只在内存里记时间，不建新表（阶段 10 设计「心跳不落新表」）。Worker 重启后以重启时刻
 * 作为「最近一次心跳」的起点：A 一直正常时第一次心跳马上覆盖它，不会因为内存清空而误报；
 * 已开的 `fs_heartbeat` 告警留在数据库里，下一次 `/clock` 到达时由 `applyClockHeartbeat` 恢复。
 */
export function createClockMonitor(options: {
  readonly db: Db;
  readonly logger: Logger;
  readonly now?: (() => Date) | undefined;
}): ClockHeartbeatMonitor {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock();
  let lastHeartbeatAt: Date | undefined;
  return {
    record(at) {
      lastHeartbeatAt = at;
    },
    async check() {
      const now = clock();
      const latest = lastHeartbeatAt ?? startedAt;
      if (now.getTime() - latest.getTime() <= CLOCK_HEARTBEAT_MISSING_MS)
        return false;
      await withSystem(options.db, (tx) =>
        raiseAlert(tx, {
          kind: 'fs_heartbeat',
          subjectKey: AlertKeys.fsHeartbeat,
          description: lastHeartbeatAt
            ? `服务器 A 的时钟心跳超过 5 分钟未到达（最近一次 ${lastHeartbeatAt.toISOString()}）`
            : '服务器 A 的时钟心跳超过 5 分钟未到达（Worker 启动后还没有收到过）',
          at: now,
        }),
      );
      return true;
    },
  };
}

/** 每个分钟检查一次；与心跳的 30 秒周期错开，最多晚一分钟发现。 */
export function startClockMonitor(
  monitor: ClockHeartbeatMonitor,
  logger: Logger,
  intervalMs = 60_000,
): () => void {
  const timer = setInterval(() => {
    void monitor.check().catch((error: unknown) => {
      logger.error({ err: error }, '时钟心跳检查失败');
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

const seconds = (milliseconds: number) => (milliseconds / 1_000).toFixed(3);

/**
 * 处理一次心跳：用数据库时钟算偏差、按决定 3 的阈值开/恢复 `clock_skew`（警告）与
 * `clock_skew_critical`（严重），并恢复 `fs_heartbeat`。返回用于更新内存心跳的数据库时间。
 *
 * 两种偏差告警各自独立：|skew| ≥ 1 秒开警告，≥ 5 秒同时开严重（从无告警直接越过 5 秒会开两条，
 * 各发一封开始通知）；否则按各自的阈值走静默窗口恢复。`skew = 数据库收到时间 − sentAt − RTT/2`，
 * 正数表示服务器 A 比数据库慢。`last_seen_at` 只在超过各自阈值时推进，所以
 * `recoverClockSkewAfterQuiet` 能判断「回到该阈值内已持续一个静默窗口」。
 */
export async function applyClockHeartbeat(
  db: Db,
  payload: ClockRequest,
  options: {
    readonly quietMinutes: number;
    readonly monitor?: ClockHeartbeatMonitor | undefined;
  },
): Promise<Date> {
  const at = await withSystem(db, async (tx) => {
    const receivedAt = await databaseNow(tx);
    const skewMs =
      receivedAt.getTime() - Date.parse(payload.sentAt) - payload.rttMs / 2;
    const absolute = Math.abs(skewMs);
    const direction = skewMs >= 0 ? '慢' : '快';
    // 严重级别由 kind 表示，描述里不再重复「警告」「严重」。
    const description =
      `服务器 A 比数据库${direction} ${seconds(absolute)} 秒` +
      `（RTT ${payload.rttMs.toFixed(1)} ms；A 自身 chrony ` +
      `${payload.chronySynchronized ? '已同步' : '未同步'}，` +
      `偏移 ${payload.chronyOffsetSeconds.toFixed(3)} 秒）`;
    if (absolute >= CLOCK_WARNING_MS) {
      await raiseAlert(tx, {
        kind: 'clock_skew',
        subjectKey: AlertKeys.clockSkew,
        description,
        at: receivedAt,
      });
    } else {
      await recoverClockSkewAfterQuiet(tx, {
        kind: 'clock_skew',
        subjectKey: AlertKeys.clockSkew,
        quietMinutes: options.quietMinutes,
        at: receivedAt,
      });
    }
    if (absolute >= CLOCK_CRITICAL_MS) {
      await raiseAlert(tx, {
        kind: 'clock_skew_critical',
        subjectKey: AlertKeys.clockSkew,
        description,
        at: receivedAt,
      });
    } else {
      await recoverClockSkewAfterQuiet(tx, {
        kind: 'clock_skew_critical',
        subjectKey: AlertKeys.clockSkew,
        quietMinutes: options.quietMinutes,
        at: receivedAt,
      });
    }
    await recoverAlert(tx, {
      kind: 'fs_heartbeat',
      subjectKey: AlertKeys.fsHeartbeat,
      at: receivedAt,
    });
    return receivedAt;
  });
  options.monitor?.record(at);
  return at;
}
