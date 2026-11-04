import { z } from 'zod';

/**
 * 服务器 A 的时钟心跳（阶段 10 验收 8）：`fs-clock-heartbeat.sh` 每 30 秒 POST 一次，
 * Worker 用数据库时钟（`clock_timestamp()`）计算两台机器的偏差。阈值是用户决定 3：
 * 警告 1 秒、严重 5 秒；它们远小于取消未来费率版本的 60 秒余量，又大于正常 NTP 抖动。
 */
export const CLOCK_WARNING_MS = 1_000;
export const CLOCK_CRITICAL_MS = 5_000;
/** 心跳超过 5 分钟没到就开 `fs_heartbeat` 告警（服务器 A 失联或 Worker 不可达的一侧信号）。 */
export const CLOCK_HEARTBEAT_MISSING_MS = 5 * 60 * 1_000;

export const clockRequestSchema = z.object({
  /** 服务器 A 发出请求时的本机时间，带毫秒与 UTC 偏移（脚本写 `...Z`）。 */
  sentAt: z.iso.datetime({ offset: true }),
  /** 发送方估计的往返时间（毫秒）。Worker 用 RTT/2 修正 `sentAt`。 */
  rttMs: z.number().finite().nonnegative().max(60_000),
  /** `chronyc tracking` 的 System time（秒，正数表示本机比 NTP 快）。只写进告警描述。 */
  chronyOffsetSeconds: z.number().finite().min(-86_400).max(86_400),
  /** `chronyc tracking` 的 Leap status 是否为 Normal。只写进告警描述。 */
  chronySynchronized: z.boolean(),
});
export type ClockRequest = z.infer<typeof clockRequestSchema>;

/** `/clock` 只回一个固定形状，不返回数据库时间、租户或任何业务数据。 */
export const clockResponseSchema = z.strictObject({ ok: z.literal(true) });
export type ClockResponse = z.infer<typeof clockResponseSchema>;
