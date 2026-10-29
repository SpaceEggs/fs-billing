import { pino, type DestinationStream } from 'pino';

/**
 * Worker 日志脱敏（阶段 9 PR 5，决定 37）。
 *
 * 日志写到标准输出，进 systemd journal，不是有访问控制的路径；客户的被叫号码是个人信息，所以日志里只留掩码和
 * 结构性对比字段。完整号码仍在数据库（`unassigned_cdrs`、`raw_cdrs`，受 RLS 与后台权限保护）。
 */

const KEEP_HEAD = 4;
const KEEP_TAIL = 2;

/**
 * 号码掩码：保留 `+` 前缀，其余保留前 4 位和后 2 位，中间以 `*` 代替，括号里附总长度（不含 `+`）。
 * 长度 ≤ 6 的整体替换为 `*` 加长度，不泄露任何一位。
 *
 * - `8613800138000` → `8613*******00(13)`
 * - `+447700900123` → `+4477******23(12)`
 * - `12345` → `*(5)`
 */
export function maskNumber(value: string): string {
  const plus = value.startsWith('+') ? '+' : '';
  const body = plus ? value.slice(1) : value;
  if (body.length <= KEEP_HEAD + KEEP_TAIL) return `${plus}*(${body.length})`;
  return `${plus}${body.slice(0, KEEP_HEAD)}${'*'.repeat(
    body.length - KEEP_HEAD - KEEP_TAIL,
  )}${body.slice(-KEEP_TAIL)}(${body.length})`;
}

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

/** 「授权计费号码不一致」的日志对象：号码全部掩码，另加结构性对比字段。 */
export function billingMismatchLog(input: BillingMismatchInput) {
  const { callee, luaBillingNumber } = input;
  const calleeEqualsDialed =
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
    calleeEqualsDialed,
    luaEqualsWorker,
    shapes: {
      dialedNumber: numberShape(input.dialedNumber),
      callee: callee === undefined ? null : numberShape(callee),
      luaBillingNumber:
        luaBillingNumber === undefined ? null : numberShape(luaBillingNumber),
      billingNumber: numberShape(input.billingNumber),
    },
    reason:
      calleeEqualsDialed === false ? 'callee-differs' : 'only-lua-differs',
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

export function createWorkerLogger(destination?: DestinationStream) {
  return pino({ redact: WORKER_LOG_REDACT }, destination);
}
