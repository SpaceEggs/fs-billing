/** 北京时间固定 UTC+8，无夏令时。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** 把 "2026-10-01 00:00[:00]" 北京时间解析为时刻。 */
export function beijingTime(text: string): Date {
  const m = LOCAL.exec(text);
  if (!m) throw new Error(`无法解析北京时间：${text}`);
  const [, y, mo, d, h, mi, s = '00'] = m as unknown as string[];
  const utc = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s);
  const at = new Date(utc - BEIJING_OFFSET_MS);
  if (beijingDateTime(at) !== `${y}-${mo}-${d} ${h}:${mi}:${s}`) {
    throw new Error(`无效的北京时间：${text}`);
  }
  return at;
}

function beijingDateTime(at: Date): string {
  return new Date(at.getTime() + BEIJING_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

/** 话单归属日（北京时间，按接通时间；跨午夜归入接通当天）。 */
export function beijingDay(answeredAt: Date): string {
  return beijingDateTime(answeredAt).slice(0, 10);
}

/** 话单归属月（北京时间）。 */
export function beijingMonth(answeredAt: Date): string {
  return beijingDateTime(answeredAt).slice(0, 7);
}
