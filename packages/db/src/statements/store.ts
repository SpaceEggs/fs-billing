import { and, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import {
  monthlyStatementCountries,
  monthlyStatementDays,
  monthlyStatements,
} from '../schema.js';
import { canonical, canonicalOrNull } from './decimal.js';
import { parseStatementMonth } from './months.js';
import type {
  StatementCountryRow,
  StatementDayRow,
  StatementHeader,
  StatementComputation,
  StoredStatement,
} from './types.js';

type HeaderRow = typeof monthlyStatements.$inferSelect;

function toHeader(row: HeaderRow): StatementHeader {
  return {
    id: row.id,
    tenantId: row.tenantId,
    month: row.month,
    version: row.version,
    openingBalance: canonical(row.openingBalance),
    recharge: canonical(row.recharge),
    gift: canonical(row.gift),
    adjustment: canonical(row.adjustment),
    callCharges: canonical(row.callCharges),
    closingBalance: canonical(row.closingBalance),
    calls: row.calls,
    callMinutes: canonical(row.callMinutes),
    breakdownGap: canonical(row.breakdownGap),
    detailsDeleted: row.detailsDeleted,
    generatedAt: row.generatedAt,
    firstGeneratedAt: row.firstGeneratedAt,
    generatedBy: row.generatedBy,
    reconcileStatus: row.reconcileStatus,
    reconciledAt: row.reconciledAt,
    reconcileDiff: canonicalOrNull(row.reconcileDiff),
  };
}

/** 账单头部，不含明细。月份已有账单行才有返回。 */
export async function readStatementHeader(
  tx: Tx,
  tenantId: string,
  monthInput: string,
  options: { forUpdate?: boolean } = {},
): Promise<StatementHeader | null> {
  const query = tx
    .select()
    .from(monthlyStatements)
    .where(
      and(
        eq(monthlyStatements.tenantId, tenantId),
        eq(monthlyStatements.month, parseStatementMonth(monthInput)),
      ),
    );
  const [row] = await (options.forUpdate ? query.for('update') : query);
  return row ? toHeader(row) : null;
}

/** 头部当前版本的国家与日明细；旧版本的行只留作排查，不读取。 */
export async function readStatementDetails(
  tx: Tx,
  header: Pick<StatementHeader, 'id' | 'version'>,
): Promise<{
  countries: StatementCountryRow[];
  days: StatementDayRow[];
}> {
  const countries = await tx
    .select()
    .from(monthlyStatementCountries)
    .where(
      and(
        eq(monthlyStatementCountries.statementId, header.id),
        eq(monthlyStatementCountries.version, header.version),
      ),
    )
    .orderBy(
      desc(monthlyStatementCountries.charge),
      monthlyStatementCountries.country,
    );
  const days = await tx
    .select()
    .from(monthlyStatementDays)
    .where(
      and(
        eq(monthlyStatementDays.statementId, header.id),
        eq(monthlyStatementDays.version, header.version),
      ),
    )
    .orderBy(monthlyStatementDays.day);
  return {
    countries: countries.map((row) => ({
      country: row.country,
      calls: row.calls,
      minutes: canonical(row.minutes),
      charge: canonical(row.charge),
    })),
    days: days.map((row) => ({
      day: row.day,
      calls: row.calls,
      minutes: canonical(row.minutes),
      charge: canonical(row.charge),
    })),
  };
}

/**
 * 读一张已生成的账单（头部加当前版本的明细）。没有账单行返回 null。
 * 国家按费用降序（numeric 排序，不是文本排序），同费用按国家名升序。
 */
export async function readStatement(
  tx: Tx,
  tenantId: string,
  monthInput: string,
): Promise<StoredStatement | null> {
  const header = await readStatementHeader(tx, tenantId, monthInput);
  if (!header) return null;
  return { ...header, ...(await readStatementDetails(tx, header)) };
}

/** 租户全部账单头部，月份降序。 */
export async function listStatements(
  tx: Tx,
  tenantId: string,
): Promise<StatementHeader[]> {
  const rows = await tx
    .select()
    .from(monthlyStatements)
    .where(eq(monthlyStatements.tenantId, tenantId))
    .orderBy(desc(monthlyStatements.month));
  return rows.map(toHeader);
}

/**
 * 已出账的月份（有账单行），月份降序，附话单是否已删除。
 * 阶段 8 删除话单的月份选择器据此只放行已出账月份。
 */
export async function listStatementMonths(
  tx: Tx,
  tenantId: string,
): Promise<{ month: string; detailsDeleted: boolean }[]> {
  const rows = await tx
    .select({
      month: monthlyStatements.month,
      detailsDeleted: monthlyStatements.detailsDeleted,
    })
    .from(monthlyStatements)
    .where(eq(monthlyStatements.tenantId, tenantId))
    .orderBy(desc(monthlyStatements.month));
  return rows;
}

/**
 * 插入账单头部与版本 1 的明细。同一租户同一月份只有一行：已有行（含并发的另一次抢先）返回 null，不写明细。
 * 在 repeatable read 下，冲突行若是本事务快照之后才提交的，数据库报 40001，由 withSystem 的重试处理。
 */
export async function insertStatement(
  tx: Tx,
  tenantId: string,
  monthInput: string,
  computation: StatementComputation,
  generatedBy: string | null,
): Promise<string | null> {
  const [inserted] = await tx
    .insert(monthlyStatements)
    .values({
      tenantId,
      month: parseStatementMonth(monthInput),
      openingBalance: computation.openingBalance,
      recharge: computation.recharge,
      gift: computation.gift,
      adjustment: computation.adjustment,
      callCharges: computation.callCharges,
      closingBalance: computation.closingBalance,
      callMinutes: computation.callMinutes,
      calls: computation.calls,
      breakdownGap: computation.breakdownGap,
      generatedBy,
      version: 1,
    })
    .onConflictDoNothing({
      target: [monthlyStatements.tenantId, monthlyStatements.month],
    })
    .returning({ id: monthlyStatements.id });
  if (!inserted) return null;
  await appendDetails(tx, inserted.id, tenantId, 1, computation);
  return inserted.id;
}

/** 追加某个版本的明细行（明细表只增）。 */
export async function appendDetails(
  tx: Tx,
  statementId: string,
  tenantId: string,
  version: number,
  computation: Pick<StatementComputation, 'countries' | 'days'>,
): Promise<void> {
  if (computation.countries.length > 0) {
    await tx.insert(monthlyStatementCountries).values(
      computation.countries.map((row) => ({
        statementId,
        tenantId,
        version,
        country: row.country,
        calls: row.calls,
        minutes: row.minutes,
        charge: row.charge,
      })),
    );
  }
  if (computation.days.length > 0) {
    await tx.insert(monthlyStatementDays).values(
      computation.days.map((row) => ({
        statementId,
        tenantId,
        version,
        day: row.day,
        calls: row.calls,
        minutes: row.minutes,
        charge: row.charge,
      })),
    );
  }
}

/** 月份是否已有账单行。 */
export async function statementExists(
  tx: Tx,
  tenantId: string,
  monthInput: string,
): Promise<boolean> {
  const { rows } = await tx.execute(
    sql`select 1 from monthly_statements
        where tenant_id = ${tenantId}::uuid and month = ${parseStatementMonth(monthInput)}::date`,
  );
  return rows.length > 0;
}
