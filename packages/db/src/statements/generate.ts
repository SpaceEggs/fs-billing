import type { Tx } from '../client.js';
import { computeStatement } from './compute.js';
import { StatementError } from './errors.js';
import {
  assertSnapshotTransaction,
  currentStatementMonth,
  parseStatementMonth,
} from './months.js';
import { insertStatement, readStatement, statementExists } from './store.js';
import type { StoredStatement } from './types.js';

export type GenerateOutcome =
  | { readonly outcome: 'created'; readonly statement: StoredStatement }
  | { readonly outcome: 'exists' };

/**
 * 生成一个租户一个已结束月份的账单。只创建，绝不覆盖已有账单（覆盖只有管理员重新生成一条路径）：
 * 已有账单行（含并发的另一次抢先）返回 `exists`，不写任何明细。重复执行结果相同。
 *
 * 必须在 `repeatable read` 事务里调用（`withSystem(db, fn, { isolationLevel: 'repeatable read' })`）：
 * 头部与明细读自同一个快照，不会被两条语句之间提交的扣费撕裂。不拿租户锁：只读流水与话单、只写账单表。
 * 并发的两次运行里，后到的一次因快照里看不到刚提交的冲突行而收到 40001，由包装器重试后得到 `exists`。
 */
export async function generateStatement(
  tx: Tx,
  tenantId: string,
  monthInput: string,
  options: { generatedBy?: string | null } = {},
): Promise<GenerateOutcome> {
  const month = parseStatementMonth(monthInput);
  await assertSnapshotTransaction(tx);
  if (month >= (await currentStatementMonth(tx)))
    throw new StatementError(
      'STATEMENT_NOT_FINAL',
      `${month.slice(0, 7)} 月份尚未结束，不能生成账单`,
    );
  if (await statementExists(tx, tenantId, month)) return { outcome: 'exists' };
  const computation = await computeStatement(tx, tenantId, month);
  const id = await insertStatement(
    tx,
    tenantId,
    month,
    computation,
    options.generatedBy ?? null,
  );
  if (id === null) return { outcome: 'exists' };
  const statement = await readStatement(tx, tenantId, month);
  if (!statement) throw new Error('刚写入的账单读不到');
  return { outcome: 'created', statement };
}
