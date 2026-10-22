import { beijingTime } from '@fs-billing/rating';
import {
  ensureCdrPartitions,
  withSystem,
  generateStatement,
} from '@fs-billing/db';
import type { ApiConnections } from './support.js';

export {
  statementCall,
  statementCdr,
  statementLedger,
  statementTenant,
} from '../../../packages/db/test/statements.js';

/** 账单测试的话单落在 2026 年 6 至 10 月，当前月另按真实时钟建分区。 */
export async function ensureStatementPartitions(connections: ApiConnections) {
  await ensureCdrPartitions(connections.owner.db, {
    moment: beijingTime('2026-06-01 00:00:00'),
    monthsAhead: 4,
  });
  await ensureCdrPartitions(connections.owner.db, { moment: new Date() });
}

/** 租户创建时间（北京时间）：决定第一个应有的账单月份。 */
export async function backdateTenant(
  connections: ApiConnections,
  tenantId: string,
  createdAt: string,
) {
  await connections.owner.pool.query(
    'update public.tenants set created_at = $2 where id = $1',
    [tenantId, beijingTime(createdAt)],
  );
}

/** 与每日任务相同的生成路径（系统身份，repeatable read）。 */
export async function generateMonth(
  connections: ApiConnections,
  tenantId: string,
  month: string,
) {
  return withSystem(
    connections.app.db,
    (tx) => generateStatement(tx, tenantId, month),
    { isolationLevel: 'repeatable read' },
  );
}

/** 当前北京月 YYYY-MM。 */
export function currentBeijingMonth(now = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}
