import { sql } from 'drizzle-orm';
import type { Tx } from '../client.js';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])(?:-01)?$/;

/** 'YYYY-MM' 或 'YYYY-MM-01' → 'YYYY-MM-01'。其他格式抛出错误。 */
export function parseStatementMonth(value: string): string {
  const match = MONTH.exec(value);
  if (!match) throw new Error(`账单月份格式应为 YYYY-MM：${value}`);
  return `${match[1]!}-${match[2]!}-01`;
}

/** 'YYYY-MM-01' → 'YYYY-MM'。 */
export function monthKey(month: string): string {
  return parseStatementMonth(month).slice(0, 7);
}

/** 月份加减（整数个月），'YYYY-MM-01' → 'YYYY-MM-01'。 */
export function addMonths(month: string, months: number): string {
  const first = parseStatementMonth(month);
  const index = Number(first.slice(0, 4)) * 12 + Number(first.slice(5, 7)) - 1;
  const next = index + months;
  const year = Math.floor(next / 12);
  const monthNumber = (next % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}-01`;
}

/** 北京月 [lo, hi)，由 SQL 换算（北京时间固定 UTC+8）。 */
export function monthRange(month: string) {
  return {
    lo: sql`(${month}::date)::timestamp at time zone 'Asia/Shanghai'`,
    hi: sql`((${month}::date + interval '1 month'))::timestamp at time zone 'Asia/Shanghai'`,
  };
}

/** 数据库时钟所在的北京月（YYYY-MM-01）。传入 asOf 时取该时刻所在的北京月。 */
export async function currentStatementMonth(
  tx: Tx,
  asOf?: Date,
): Promise<string> {
  const { rows } = await tx.execute<{ month: string }>(sql`
    select to_char(
      date_trunc('month', coalesce(${asOf ?? null}::timestamptz, statement_timestamp()) at time zone 'Asia/Shanghai'),
      'YYYY-MM-DD') as month`);
  return rows[0]!.month;
}

/** 当前事务必须是快照隔离（repeatable read 或更高）：头部与明细要读自同一时刻的账本。 */
export async function assertSnapshotTransaction(tx: Tx): Promise<void> {
  const { rows } = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  const level = rows[0]!.level;
  if (level !== 'repeatable read' && level !== 'serializable') {
    throw new Error(
      `账单生成需要 repeatable read 事务（withSystem/withAdmin 的 isolationLevel），当前是 ${level}`,
    );
  }
}
