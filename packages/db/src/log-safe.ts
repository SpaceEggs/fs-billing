/**
 * 日志里的数据库错误脱敏（阶段 9 PR 5，决定 37 的补充）。
 *
 * drizzle-orm 把失败的查询包成 `DrizzleQueryError`：`message` 和 `stack` 里带 `\nparams: …`（绑定的实参），
 * 对象上还有自有属性 `query`、`params`；PostgreSQL 错误的 `detail`、`where` 会带键值或行内容。话单入库绑定的是
 * 原始 CDR 正文与被叫号码，所以这些错误一旦原样写进日志，就把完整号码写进了 journal。
 *
 * 输入是 pino 标准错误序列化的输出（普通对象，`cause` 链已展开）；就地去掉这些字段并截断 message/stack，
 * 返回同一个对象。纯函数，不依赖 pino，Worker 与 API 的日志器共用。
 */
const DROPPED_KEYS = ['params', 'query', 'detail', 'where'] as const;
const PARAMS_TAIL = /\nparams:[\s\S]*$/;
const MAX_DEPTH = 16;

export function scrubErrorForLog<T>(serialized: T): T {
  scrub(serialized, 0);
  return serialized;
}

function scrub(value: unknown, depth: number): void {
  if (typeof value !== 'object' || value === null || depth > MAX_DEPTH) return;
  const record = value as Record<string, unknown>;
  for (const key of DROPPED_KEYS) delete record[key];
  for (const key of ['message', 'stack'] as const) {
    const text = record[key];
    if (typeof text === 'string') record[key] = text.replace(PARAMS_TAIL, '');
  }
  scrub(record.cause, depth + 1);
}

/** 只取结构化的 PostgreSQL 错误字段（代码、约束、表），不含 message / detail。沿 `cause` 链找第一个带字符串 `code` 的错误。 */
export function postgresErrorFields(
  error: unknown,
): { code: string; constraint?: string; table?: string } | undefined {
  for (
    let current = error, depth = 0;
    current instanceof Error && depth <= MAX_DEPTH;
    current = current.cause, depth++
  ) {
    if ('code' in current && typeof current.code === 'string') {
      const text = (key: string) => {
        const field = (current as unknown as Record<string, unknown>)[key];
        return typeof field === 'string' ? field : undefined;
      };
      const constraint = text('constraint');
      const table = text('table');
      return {
        code: current.code,
        ...(constraint ? { constraint } : {}),
        ...(table ? { table } : {}),
      };
    }
  }
  return undefined;
}
