import { pino, stdSerializers, type DestinationStream } from 'pino';
import { maskNumber, scrubErrorForLog } from '@fs-billing/db';

/**
 * Worker 日志脱敏（阶段 9 PR 5，决定 37）。
 *
 * 日志写到标准输出，进 systemd journal，不是有访问控制的路径；客户的被叫号码是个人信息，所以日志里只留掩码和
 * 结构性对比字段。完整号码仍在数据库（`unassigned_cdrs`、`raw_cdrs`，受 RLS 与后台权限保护）。
 */

export { maskNumber };

/** 号码的结构：长度（不含 `+`）、是否以 `+` 或 `00` 开头。排查归一化差异靠它，不需要号码本身。 */
export function numberShape(value: string) {
  const plus = value.startsWith('+');
  return {
    length: plus ? value.length - 1 : value.length,
    plus,
    doubleZero: value.startsWith('00'),
  };
}

export interface BillingMismatchInput {
  readonly uuid: string;
  readonly tenant: string;
  /** Lua 送来的原始拨号。 */
  readonly dialedNumber: string;
  /** Lua 送来的被叫（国际号码投影）；旧版本可能没有。 */
  readonly callee?: string | undefined;
  /** Lua 算出的计费号码；旧版本可能没有。 */
  readonly luaBillingNumber?: string | undefined;
  /** Worker 按原拨号算出的计费号码。 */
  readonly billingNumber: string;
}

/**
 * 「授权计费号码不一致」的日志对象：号码全部掩码，另加结构性对比字段。
 *
 * 对比字段比较的是 Lua 送来的值与 **Worker 按原拨号算出的计费号码**（`resolveBillingNumber` 做的正是这两个比较），
 * 不是与原始拨号比：被叫是国际号码投影（`13800138000` → `8613800138000`），和原始拨号本来就不相等。
 */
export function billingMismatchLog(input: BillingMismatchInput) {
  const { callee, luaBillingNumber } = input;
  const calleeEqualsWorker =
    callee === undefined ? null : callee === input.billingNumber;
  const luaEqualsWorker =
    luaBillingNumber === undefined
      ? null
      : luaBillingNumber === input.billingNumber;
  return {
    uuid: input.uuid,
    tenant: input.tenant,
    dialedNumber: maskNumber(input.dialedNumber),
    callee: callee === undefined ? null : maskNumber(callee),
    luaBillingNumber:
      luaBillingNumber === undefined ? null : maskNumber(luaBillingNumber),
    billingNumber: maskNumber(input.billingNumber),
    calleeEqualsWorker,
    luaEqualsWorker,
    shapes: {
      dialedNumber: numberShape(input.dialedNumber),
      callee: callee === undefined ? null : numberShape(callee),
      luaBillingNumber:
        luaBillingNumber === undefined ? null : numberShape(luaBillingNumber),
      billingNumber: numberShape(input.billingNumber),
    },
    // 被叫不一致优先；被叫缺失或一致而 Lua 的计费号码不一致是 only-lua-differs；两者都没有不一致证据时是 unknown。
    reason:
      calleeEqualsWorker === false
        ? 'callee-differs'
        : luaEqualsWorker === false
          ? 'only-lua-differs'
          : 'unknown',
  };
}

/**
 * pino 的 redact 路径：共享密钥与授权头，以及 PostgreSQL 错误的 `detail`
 * （唯一冲突会写成 `Key (…)=(…)`，可能带号码或邮箱）；错误可能被包了一两层 `cause`。
 */
export const WORKER_LOG_REDACT = [
  'req.headers["x-billing-key"]',
  'req.headers.authorization',
  'err.detail',
  'err.cause.detail',
  'err.cause.cause.detail',
];

/**
 * 错误序列化：pino 标准序列化之后，去掉 `params`/`query`/`detail`/`where`（含各层 `cause`），
 * 并截掉 message / stack 里 `\nparams:` 之后的内容（drizzle 的 `DrizzleQueryError` 把绑定实参写在那里）。
 */
export const safeErrorSerializer = (error: unknown) =>
  scrubErrorForLog(stdSerializers.err(error as Error));

export function createWorkerLogger(destination?: DestinationStream) {
  return pino(
    { redact: WORKER_LOG_REDACT, serializers: { err: safeErrorSerializer } },
    destination,
  );
}
