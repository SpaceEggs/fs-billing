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

const KEEP_HEAD = 4;
const KEEP_TAIL = 2;

/**
 * 号码掩码（阶段 9 决定 37）：保留 `+` 前缀，其余保留前 4 位和后 2 位，中间以 `*` 代替，括号里附总长度（不含 `+`）。
 * 长度 ≤ 6 的整体替换为 `*` 加长度，不泄露任何一位。Worker 的计费号码日志与 API 的请求 URL 共用这一条规则。
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

/** 参数名一律按号码处理（话单搜索的被叫、主叫、拨号），不看取值。 */
const NUMBER_PARAMS = new Set([
  'callee',
  'caller',
  'dialed',
  'dialednumber',
  'number',
  'phone',
]);
/** 取值像号码：可选 `+`，数字可夹空格、短横线、点、括号，至少 7 位数字。 */
// 只有一个量词：不会在长而不匹配的取值上回溯（URL 是外部输入）；「至少 7 位数字」由调用处另查。
const NUMBER_LIKE = /^\+?[\d\s\-.()]+$/;
const MIN_NUMBER_DIGITS = 7;
/** 日期与时间（`2026-10-01`、`2026-10-01T00:00:00Z`）有 8 位以上数字，但不是号码。 */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/;

function decodeParam(text: string): string {
  try {
    return decodeURIComponent(text.replaceAll('+', ' '));
  } catch {
    return text;
  }
}

function maskParamValue(name: string, value: string): string {
  const decoded = decodeParam(value);
  // `+` 在查询串里本来表示空格；号码前缀的 `+` 要靠 `%2B` 才到得了这里，所以按原文判断是否以 %2B 或 + 开头。
  const plus = /^(%2B|\+)/i.test(value) ? '+' : '';
  const digits = decoded.replace(/[^\d]/g, '');
  const looksLikeNumber =
    NUMBER_LIKE.test(decoded.trim()) &&
    !DATE_LIKE.test(decoded.trim()) &&
    digits.length >= MIN_NUMBER_DIGITS;
  if (!NUMBER_PARAMS.has(name.toLowerCase()) && !looksLikeNumber) return value;
  return digits.length === 0 ? '*' : maskNumber(`${plus}${digits}`);
}

/**
 * 请求 URL 的日志脱敏（阶段 9 PR 8）：话单搜索的 `callee` 等查询参数会带客户号码，而 API 日志进 journal。
 * 参数名是号码类（`callee`、`caller` …），或取值像号码（至少 7 位数字），整个值按 {@link maskNumber} 掩码；
 * 其余参数、路径和参数顺序不变。无法解析时原样返回（没有 `?` 的 URL 直接返回）。
 */
export function redactUrlForLog(url: string): string {
  const at = url.indexOf('?');
  if (at < 0) return url;
  const hash = url.indexOf('#', at);
  const query = url.slice(at + 1, hash < 0 ? undefined : hash);
  const tail = hash < 0 ? '' : url.slice(hash);
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const name = decodeParam(pair.slice(0, eq));
      return `${pair.slice(0, eq)}=${maskParamValue(name, pair.slice(eq + 1))}`;
    })
    .join('&');
  return `${url.slice(0, at + 1)}${redacted}${tail}`;
}
