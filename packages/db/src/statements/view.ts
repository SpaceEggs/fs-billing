import { sql } from 'drizzle-orm';
import {
  beijingDateOf,
  latestRangeEnd,
  type Currency,
} from '@fs-billing/shared';
import type { Tx } from '../client.js';
import { AdminServiceError } from '../admin/errors.js';
import { NotFoundError } from '../errors.js';
import { computeStatement } from './compute.js';
import { firstStatementMonth } from './first-month.js';
import { databaseInstant } from './live.js';
import {
  addMonths,
  currentStatementMonth,
  parseStatementMonth,
} from './months.js';
import { listStatements, readStatement } from './store.js';
import type {
  StatementCountryRow,
  StatementDayRow,
  StatementFigures,
  StatementHeader,
  StatementState,
} from './types.js';

export interface StatementViewTenant {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly currency: Currency;
  /** 开户时刻的北京日。 */
  readonly createdDay: string;
}

function figuresOf(source: StatementFigures): StatementFigures {
  return {
    openingBalance: source.openingBalance,
    recharge: source.recharge,
    gift: source.gift,
    adjustment: source.adjustment,
    callCharges: source.callCharges,
    closingBalance: source.closingBalance,
    calls: source.calls,
    callMinutes: source.callMinutes,
  };
}

async function readTenant(
  tx: Tx,
  tenantId: string,
): Promise<StatementViewTenant> {
  const { rows } = await tx.execute<{
    id: string;
    code: string;
    name: string;
    currency: Currency;
    created_day: string;
  }>(sql`
    select id, code, name, currency,
      to_char(created_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as created_day
    from tenants where id = ${tenantId}::uuid`);
  const row = rows[0];
  if (!row) throw new NotFoundError('租户不存在');
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    currency: row.currency,
    createdDay: row.created_day,
  };
}

/** 月份晚于数据库时钟所在的北京月：请求本身无效（400）。 */
function assertNotFuture(month: string, current: string): void {
  if (month > current)
    throw new AdminServiceError(
      'VALIDATION_ERROR',
      `${month.slice(0, 7)} 晚于当前北京月`,
    );
}

export interface StatementView {
  readonly tenant: StatementViewTenant;
  /** 该月 1 日。 */
  readonly month: string;
  readonly state: StatementState;
  /** 实时月份（进行中、待生成）的读取时刻；已生成的账单为 null。 */
  readonly asOf: Date | null;
  /** 已生成的账单头部；实时月份为 null。 */
  readonly header: StatementHeader | null;
  readonly figures: StatementFigures;
  readonly breakdownGap: string;
  readonly countries: readonly StatementCountryRow[];
  readonly days: readonly StatementDayRow[];
  readonly period: {
    readonly from: string;
    readonly to: string;
    readonly openedOn: string | null;
  };
}

function periodOf(
  tenant: StatementViewTenant,
  month: string,
  state: StatementState,
  asOf: Date | null,
) {
  const openedOn = tenant.createdDay.startsWith(month.slice(0, 7))
    ? tenant.createdDay
    : null;
  return {
    from: openedOn ?? month,
    to:
      state === 'in_progress' && asOf
        ? beijingDateOf(asOf)
        : latestRangeEnd(month),
    openedOn,
  };
}

/**
 * 一个租户一个月份的账单视图：已有账单行读存下的头部与当前版本明细，
 * 否则当前北京月实时算 `in_progress`，已结束的月份实时算 `pending`。
 * 租户不存在、月份早于第一个应有月份（且没有账单行）抛 NotFoundError；晚于当前北京月是 400。
 * 门户与后台共用：租户身份由调用方的事务（withTenant / withAdmin）限定。
 */
export async function readStatementView(
  tx: Tx,
  tenantId: string,
  monthInput: string,
): Promise<StatementView> {
  const month = parseStatementMonth(monthInput);
  const tenant = await readTenant(tx, tenantId);
  const current = await currentStatementMonth(tx);
  assertNotFuture(month, current);

  const stored = await readStatement(tx, tenantId, month);
  if (stored) {
    return {
      tenant,
      month,
      state: 'final',
      asOf: null,
      header: stored,
      figures: figuresOf(stored),
      breakdownGap: stored.breakdownGap,
      countries: stored.countries,
      days: stored.days,
      period: periodOf(tenant, month, 'final', null),
    };
  }
  const first = await firstStatementMonth(tx, tenantId);
  if (first === null || month < first)
    throw new NotFoundError('该月份没有账单');
  const asOf = await databaseInstant(tx);
  const inProgress = month === current;
  const live = await computeStatement(tx, tenantId, month, {
    ...(inProgress && { asOf }),
    opening: inProgress ? 'balance' : 'ledger',
  });
  const state: StatementState = inProgress ? 'in_progress' : 'pending';
  return {
    tenant,
    month,
    state,
    asOf,
    header: null,
    figures: figuresOf(live),
    breakdownGap: live.breakdownGap,
    countries: live.countries,
    days: live.days,
    period: periodOf(tenant, month, state, asOf),
  };
}

export interface StatementListItem {
  readonly month: string;
  readonly state: StatementState;
  readonly header: StatementHeader | null;
  readonly figures: StatementFigures;
}

export interface StatementMonthList {
  readonly tenant: StatementViewTenant;
  readonly asOf: Date;
  /** 月份降序：当前北京月（实时）、待生成的月份（实时）、已生成的账单。 */
  readonly items: readonly StatementListItem[];
}

/**
 * 一个租户的全部账单月份：从第一个应有月份到当前北京月，已有账单行的读存下的头部，
 * 其余实时算。租户存在即有进行中月份那一行（可以全零）。租户不存在抛 NotFoundError。
 */
export async function readStatementMonthList(
  tx: Tx,
  tenantId: string,
): Promise<StatementMonthList> {
  const tenant = await readTenant(tx, tenantId);
  const asOf = await databaseInstant(tx);
  const current = await currentStatementMonth(tx, asOf);
  const first = (await firstStatementMonth(tx, tenantId)) ?? current;
  const headers = new Map(
    (await listStatements(tx, tenantId)).map((header) => [
      header.month,
      header,
    ]),
  );
  const months = new Set(headers.keys());
  for (let month = first; month <= current; month = addMonths(month, 1))
    months.add(month);
  const items: StatementListItem[] = [];
  for (const month of [...months].sort().reverse()) {
    const header = headers.get(month);
    if (header) {
      items.push({
        month,
        state: 'final',
        header,
        figures: figuresOf(header),
      });
      continue;
    }
    const inProgress = month === current;
    const live = await computeStatement(tx, tenantId, month, {
      ...(inProgress && { asOf }),
      opening: inProgress ? 'balance' : 'ledger',
    });
    items.push({
      month,
      state: inProgress ? 'in_progress' : 'pending',
      header: null,
      figures: figuresOf(live),
    });
  }
  return { tenant, asOf, items };
}
