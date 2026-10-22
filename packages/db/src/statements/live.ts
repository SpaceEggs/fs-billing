import { sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { NotFoundError } from '../errors.js';
import { computeStatement } from './compute.js';
import { currentStatementMonth, parseStatementMonth } from './months.js';
import { statementExists } from './store.js';
import type { LiveStatement } from './types.js';

/**
 * 没有账单行的月份实时取数，不落库、不写任何表（只读事务即可）：
 * - 当前北京月：`in_progress`，统计 [月初, asOf)，期初用余额锚点（缓存余额减去月初起的流水），
 *   通话扣费与首页「本月消费」同源；
 * - 已结束但还没有账单行的月份（每月 1 日 00:00 到生成之前，或任务失败）：`pending`，期初用月初前流水合计。
 * 月份已有账单行返回 null（读存下的账单）。租户不存在抛 NotFoundError；晚于当前北京月抛错（接口层先校验成 400）。
 * `asOf` 默认数据库时钟，测试可传入固定时刻。
 */
export async function readLiveStatement(
  tx: Tx,
  tenantId: string,
  monthInput: string,
  options: { asOf?: Date } = {},
): Promise<LiveStatement | null> {
  const month = parseStatementMonth(monthInput);
  const { rows: tenantRows } = await tx.execute(
    sql`select 1 from tenants where id = ${tenantId}::uuid`,
  );
  if (tenantRows.length === 0) throw new NotFoundError('租户不存在');
  const asOf = options.asOf ?? (await databaseInstant(tx));
  const current = await currentStatementMonth(tx, asOf);
  if (month > current) throw new Error(`${month.slice(0, 7)} 晚于当前北京月`);
  if (await statementExists(tx, tenantId, month)) return null;
  const inProgress = month === current;
  const statement = await computeStatement(tx, tenantId, month, {
    ...(inProgress && { asOf }),
    opening: inProgress ? 'balance' : 'ledger',
  });
  return {
    month,
    state: inProgress ? 'in_progress' : 'pending',
    asOf,
    statement,
  };
}

export async function databaseInstant(tx: Tx): Promise<Date> {
  const { rows } = await tx.execute<{ at: string }>(
    sql`select to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`,
  );
  return new Date(rows[0]!.at);
}
