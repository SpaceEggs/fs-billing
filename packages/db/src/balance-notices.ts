import { eq, sql } from 'drizzle-orm';
import type { Tx } from './client.js';
import { balanceNoticeState } from './schema.js';

/**
 * 余额提醒与停机通知（阶段 9 设计「余额提醒与停机通知」）。
 *
 * 判定不在应用代码里：`tenant_balances` 上的触发器（迁移 0023 `tenant_balances_notice`）在每次余额变化的同一事务里
 * 读阈值、透支额度和状态行，越线时更新 `balance_notice_state` 并把邮件写进 `email_outbox`。所以 Worker 扣费、
 * 充值、赠送、调账、分配补扣费、`rebuild_tenant_balances` 都被覆盖，与流水同提交同回滚，同一租户的判定由租户锁串行。
 *
 * 规则（`b` 余额，`T` 租户阈值，`O` 透支额度，`a = b + O` 可用额度）：
 *   - 低余额线：`T > 0 且 b < T`。`T = 0` 表示不提醒（决定 24）；恰好等于 `T` 不触发。
 *   - 停机线：`a <= 0`（决定 30）；授权的「余额不足」（可用额度不足所拨号码一分钟的费用）比它宽，窗口里不发停机通知。
 *   - 通知 = 从线上到线下的那一次（`*_active` 由假变真）；回到线上只重新上膛，不发邮件。
 *   - 同一次变化同时越过两条线只发停机通知，低余额视为已触发（决定 28）。
 *   - 收件人只是租户通知邮箱，不抄送管理员（决定 25）；没有收件人入队为 `skipped / no_recipients`，
 *     租户停用为 `skipped / tenant_disabled`，状态都照常前进、重新启用后不补发（决定 26、27）。
 *   - 阈值或透支额度被改，静默按当前余额同步状态，不补发（决定 29），见 {@link syncBalanceNoticeState}。
 *
 * 发件箱幂等键：`balance_low:<租户>:<序号>` / `balance_suspended:<租户>:<序号>`，序号取自状态行。
 */

/** 发件箱幂等键（触发器与测试共用同一种写法）。 */
export function balanceNoticeDedupeKey(
  template: 'balance_low' | 'balance_suspended',
  tenantId: string,
  seq: number,
): string {
  return `${template}:${tenantId}:${seq}`;
}

/**
 * 按当前余额、阈值、透支额度重新计算两个标志，**不发邮件**、序号不动（决定 29）。
 * 保存租户设置（阈值或透支额度变化）和创建租户时在同一事务里调用；调用方已持租户锁。
 * 需要管理员或系统身份（函数是 SECURITY DEFINER）。
 */
export async function syncBalanceNoticeState(
  tx: Tx,
  tenantId: string,
): Promise<void> {
  await tx.execute(sql`select sync_balance_notice_state(${tenantId}::uuid)`);
}

export type BalanceNoticeState = typeof balanceNoticeState.$inferSelect;

export async function readBalanceNoticeState(
  tx: Tx,
  tenantId: string,
): Promise<BalanceNoticeState | undefined> {
  const [row] = await tx
    .select()
    .from(balanceNoticeState)
    .where(eq(balanceNoticeState.tenantId, tenantId));
  return row;
}
