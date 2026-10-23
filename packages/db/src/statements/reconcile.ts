import { and, eq, isNull, sql } from 'drizzle-orm';
import { decimal } from '@fs-billing/rating';
import type { Tx } from '../client.js';
import { NotFoundError } from '../errors.js';
import { monthlyStatements, systemAlerts, tenants } from '../schema.js';
import { canonical } from './decimal.js';
import {
  listMissingStatements,
  type MissingStatementsOptions,
} from './first-month.js';
import { monthKey } from './months.js';

export type StatementReconcileOutcome = 'ok' | 'stale' | 'inconsistent';

export interface StatementReconcileResult {
  readonly statementId: string;
  /** 该月 1 日。 */
  readonly month: string;
  readonly version: number;
  readonly status: StatementReconcileOutcome;
  /** 流水合计减账单期末；期末吻合而期初不吻合时是期初的差。吻合为 0。 */
  readonly diff: string;
  /** 账单生成之后才写入、occurred_at 在该月末之前的流水笔数。 */
  readonly lateEntries: number;
}

export interface TenantReconcileResult {
  readonly tenantId: string;
  readonly statements: readonly StatementReconcileResult[];
  /** 应有而没有账单行的月份（1 日）。 */
  readonly missing: readonly string[];
  readonly alertsOpened: number;
  readonly alertsUpdated: number;
  readonly alertsRecovered: number;
}

interface StatementLedgerRow extends Record<string, unknown> {
  id: string;
  month: string;
  version: number;
  opening_balance: string;
  closing_balance: string;
  ledger_opening: string;
  ledger_closing: string;
  late_entries: number | null;
}

/**
 * 核对一个租户的全部账单：每张账单的期末必须等于 occurred_at 在月末之前的流水合计，期初等于月初之前的合计。
 * 只读流水（一次按月汇总扫描），写回账单头部的 reconcile_*（守卫触发器允许，话单已删除的月份也照常核对），
 * 并往 system_alerts 写 / 更新 / 恢复 `statement_mismatch`：一个 (租户, 月份) 同时只开一条。
 *
 * 失败用 created_at 只做分类，不做归属：存在 `created_at > generated_at` 且 `occurred_at < 月末` 的流水
 * 说明是账单生成之后补推的（stale，管理员重新生成）；否则是 inconsistent，需要人工调查。
 * 应有而缺失的账单（第一个应有月份到上月之间没有账单行）记为 missing，同样开告警。
 *
 * 建议在 `repeatable read` 事务里调用，使多次读取互相一致。
 */
export async function reconcileTenantStatements(
  tx: Tx,
  tenantId: string,
  options: Pick<MissingStatementsOptions, 'asOf'> = {},
): Promise<TenantReconcileResult> {
  const [tenant] = await tx
    .select({ code: tenants.code })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new NotFoundError('租户不存在');

  const { rows } = await tx.execute<StatementLedgerRow>(sql`
    with monthly as (
      select date_trunc('month', occurred_at at time zone 'Asia/Shanghai')::date as month, sum(amount) as amount
      from ledger_entries where tenant_id = ${tenantId}::uuid group by 1
    )
    select s.id, to_char(s.month, 'YYYY-MM-DD') as month, s.version,
      s.opening_balance::text, s.closing_balance::text,
      coalesce((select sum(m.amount) from monthly m where m.month < s.month), 0)::text as ledger_opening,
      coalesce((select sum(m.amount) from monthly m where m.month <= s.month), 0)::text as ledger_closing,
      null::int as late_entries
    from monthly_statements s where s.tenant_id = ${tenantId}::uuid
    order by s.month`);

  const results: StatementReconcileResult[] = [];
  for (const row of rows) {
    const closingDiff = decimal(row.ledger_closing).minus(row.closing_balance);
    const openingDiff = decimal(row.ledger_opening).minus(row.opening_balance);
    let status: StatementReconcileOutcome = 'ok';
    let late = 0;
    if (!closingDiff.isZero() || !openingDiff.isZero()) {
      late = await lateEntries(tx, row.id);
      status = late > 0 ? 'stale' : 'inconsistent';
    }
    const diff = canonical(
      (closingDiff.isZero() ? openingDiff : closingDiff).toFixed(),
    );
    // 与重新生成并发时，只在版本未变的账单上写核对结果。
    await tx
      .update(monthlyStatements)
      .set({
        reconcileStatus: status,
        reconciledAt: sql`now()`,
        reconcileDiff: diff,
      })
      .where(
        and(
          eq(monthlyStatements.id, row.id),
          eq(monthlyStatements.version, row.version),
        ),
      );
    results.push({
      statementId: row.id,
      month: row.month,
      version: row.version,
      status,
      diff,
      lateEntries: late,
    });
  }

  const missing = (
    await listMissingStatements(tx, {
      tenantId,
      ...(options.asOf && { asOf: options.asOf }),
    })
  ).map((entry) => entry.month);

  const alerts = await syncAlerts(tx, tenantId, tenant.code, results, missing);
  return { tenantId, statements: results, missing, ...alerts };
}

async function lateEntries(tx: Tx, statementId: string): Promise<number> {
  const { rows } = await tx.execute<{ late: number }>(sql`
    select count(*)::int as late
    from monthly_statements s
    join ledger_entries l on l.tenant_id = s.tenant_id
    where s.id = ${statementId}::uuid
      and l.occurred_at < ((s.month + interval '1 month')::timestamp at time zone 'Asia/Shanghai')
      and l.created_at > s.generated_at`);
  return rows[0]!.late;
}

const ALERT_SUFFIX = '账单与流水不一致';

function alertPrefix(code: string, month: string): string {
  return `${code} ${monthKey(month)} `;
}

/**
 * 一个 (租户, 月份) 同时只开一条未恢复的告警，按描述前缀「<租户编码> <YYYY-MM> 」识别。
 * 状态或差额变了就更新这一条的描述，核对通过（或账单补建）后置 recovered_at。
 */
async function syncAlerts(
  tx: Tx,
  tenantId: string,
  code: string,
  results: readonly StatementReconcileResult[],
  missing: readonly string[],
): Promise<{
  alertsOpened: number;
  alertsUpdated: number;
  alertsRecovered: number;
}> {
  const desired = new Map<string, { description: string; affected: number }>();
  for (const result of results) {
    if (result.status === 'ok') continue;
    desired.set(alertPrefix(code, result.month), {
      description: `${alertPrefix(code, result.month)}${ALERT_SUFFIX}（${result.status}），差额 ${result.diff}`,
      affected: result.lateEntries,
    });
  }
  for (const month of missing) {
    desired.set(alertPrefix(code, month), {
      description: `${alertPrefix(code, month)}${ALERT_SUFFIX}（missing）`,
      affected: 0,
    });
  }

  const open = await tx
    .select({ id: systemAlerts.id, description: systemAlerts.description })
    .from(systemAlerts)
    .where(
      and(
        eq(systemAlerts.tenantId, tenantId),
        eq(systemAlerts.kind, 'statement_mismatch'),
        isNull(systemAlerts.recoveredAt),
      ),
    )
    .orderBy(systemAlerts.startedAt, systemAlerts.id);

  let alertsOpened = 0;
  let alertsUpdated = 0;
  let alertsRecovered = 0;
  const kept = new Set<string>();
  for (const alert of open) {
    const prefix = [...desired.keys()].find((key) =>
      alert.description.startsWith(key),
    );
    if (prefix === undefined || kept.has(prefix)) {
      await tx
        .update(systemAlerts)
        .set({ recoveredAt: sql`now()` })
        .where(eq(systemAlerts.id, alert.id));
      alertsRecovered++;
      continue;
    }
    kept.add(prefix);
    const wanted = desired.get(prefix)!;
    if (alert.description !== wanted.description) {
      await tx
        .update(systemAlerts)
        .set({
          description: wanted.description,
          affectedCalls: wanted.affected,
        })
        .where(eq(systemAlerts.id, alert.id));
      alertsUpdated++;
    }
  }
  for (const [prefix, wanted] of desired) {
    if (kept.has(prefix)) continue;
    await tx.insert(systemAlerts).values({
      tenantId,
      kind: 'statement_mismatch',
      description: wanted.description,
      affectedCalls: wanted.affected,
    });
    alertsOpened++;
  }
  return { alertsOpened, alertsUpdated, alertsRecovered };
}
