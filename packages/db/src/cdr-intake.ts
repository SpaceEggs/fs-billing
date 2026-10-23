import { and, eq } from 'drizzle-orm';
import {
  beijingMonth,
  decimal,
  findRate,
  money,
  priceCall,
  rate,
  type Currency,
  type DialedNumber,
  type RateEntry,
  type Tenant,
} from '@fs-billing/rating';
import type { Tx } from './client.js';
import { appendLedgerEntry, callChargeKey } from './ledger.js';
import { cdrs, monthlyStatements, tenants } from './schema.js';

/**
 * 入库定价与扣费的共享实现：Worker 的 HTTP 入库与扣费任务、阶段 8 的未归属话单分配都调用这里，
 * 所以同一通话不论走哪条路径，费率快照、金额和流水都由同一段代码得出。
 */

/** 十进制数（decimal.js 的 Decimal）；db 包不直接依赖 decimal.js，类型取自 rating 的 decimal()。 */
export type Decimal = ReturnType<typeof decimal>;

/** 话单所属月份的话单明细已删除（阶段 8 决定 38）：不定价、不扣费。 */
export const CDR_MONTH_DELETED_REASON = '所属月份话单已删除';

/** 扣费前复核发现话单所属月份的话单已删除：流水不能再落进已冻结的月份。 */
export class CdrMonthDeletedError extends Error {
  readonly code = 'CDR_MONTH_DELETED';

  constructor(
    readonly callUuid: string,
    readonly month: string,
  ) {
    super(`话单 ${callUuid} 属于话单已删除的月份 ${month}，不扣费`);
    this.name = 'CdrMonthDeletedError';
  }
}

/** 话单归属月（北京时间 YYYY-MM-01）：与话单列表、导出、删除的谓词一致，按接通时间，未接通按开始时间。 */
export function cdrMonthStart(cdr: {
  readonly startedAt: Date;
  readonly answeredAt: Date | null;
}): string {
  return `${beijingMonth(cdr.answeredAt ?? cdr.startedAt)}-01`;
}

/** 租户话单明细已删除的月份（YYYY-MM-01）。租户的账单行很少，一次取全。 */
export async function loadDeletedMonths(
  tx: Tx,
  tenantId: string,
): Promise<ReadonlySet<string>> {
  const rows = await tx
    .select({ month: monthlyStatements.month })
    .from(monthlyStatements)
    .where(
      and(
        eq(monthlyStatements.tenantId, tenantId),
        eq(monthlyStatements.detailsDeleted, true),
      ),
    );
  return new Set(rows.map((row) => row.month));
}

/**
 * 该租户该月的话单是否已删除。读已提交下每条语句看到最新已提交的行，
 * 所以调用方先 lockTenants 再调用，就不会漏掉与之串行的删除（删除也持租户锁）。
 */
export async function isMonthDeleted(
  tx: Tx,
  tenantId: string,
  month: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ month: monthlyStatements.month })
    .from(monthlyStatements)
    .where(
      and(
        eq(monthlyStatements.tenantId, tenantId),
        eq(monthlyStatements.month, month),
        eq(monthlyStatements.detailsDeleted, true),
      ),
    );
  return row !== undefined;
}

/** 写 cdrs 所需的话单字段；Worker 的 ParsedCdr 与未归属行都满足。 */
export interface IntakeCdr {
  readonly callUuid: string;
  readonly startedAt: Date;
  readonly answeredAt: Date | null;
  readonly endedAt: Date;
  readonly caller: string;
  readonly callee: string;
  /** 接通后通话秒数，写入 duration_seconds。 */
  readonly billsec: number;
  readonly hangupCause: string;
  readonly unverified: boolean;
  /** 来自未归属行时保留原来的接收时间；缺省为数据库 now()。 */
  readonly receivedAt?: Date | undefined;
}

export interface IntakeTenant {
  readonly id: string;
  /** 租户的费率表；租户不存在费率时为 undefined。 */
  readonly rating: Tenant<Currency> | undefined;
}

export interface PriceAndInsertOptions {
  /** 已预取的话单已删除月份；批量调用时传入，省掉逐条查询。 */
  readonly deletedMonths?: ReadonlySet<string> | undefined;
}

export type PriceAndInsertResult =
  | {
      readonly status: 'inserted';
      readonly billedMinutes: Decimal;
      /** 0 元或未接通为 0。 */
      readonly charge: Decimal;
      readonly entry: RateEntry<Currency> | undefined;
    }
  | { readonly status: 'no_rate' }
  | { readonly status: 'month_deleted'; readonly month: string };

export interface PricedCdr {
  readonly entry: RateEntry<Currency> | undefined;
  readonly billedMinutes: Decimal;
  /** 未接通与 0 元通话为 0。 */
  readonly charge: Decimal;
}

/** 接通时刻生效的费率与定价；未接通不收费（没有费率条目），已接通而无费率返回 'no_rate'。 */
export function priceCdr(
  tenant: Pick<IntakeTenant, 'rating'>,
  cdr: Pick<IntakeCdr, 'answeredAt' | 'billsec'>,
  billingNumber: DialedNumber,
): PricedCdr | 'no_rate' {
  if (!cdr.answeredAt) {
    return {
      entry: undefined,
      billedMinutes: decimal('0'),
      charge: decimal('0'),
    };
  }
  const entry = tenant.rating
    ? findRate(tenant.rating.rates, billingNumber, cdr.answeredAt)
    : undefined;
  if (!entry) return 'no_rate';
  const priced = priceCall(cdr.billsec, entry.perMinute);
  return {
    entry,
    billedMinutes: priced.billedMinutes,
    charge: priced.charge.value,
  };
}

/**
 * 按接通时刻生效的费率定价并写 cdrs，不写流水。调用方已持有租户锁（先 lockTenants）。
 * 不写 cdrs 的两种情况由返回值区分，调用方各自处理：
 * - month_deleted：所属月份的话单已删除（决定 38），Worker 停放为未归属，分配保持待处理；
 * - no_rate：已接通而接通时刻没有费率。
 * 其余写入 cdrs，由插入触发器登记或认领 call_uuids（HTTP 入库声明 app.cdr_ingest 时不认领）。
 */
export async function priceAndInsertCdr(
  tx: Tx,
  tenant: IntakeTenant,
  cdr: IntakeCdr,
  billingNumber: DialedNumber,
  options: PriceAndInsertOptions = {},
): Promise<PriceAndInsertResult> {
  const month = cdrMonthStart(cdr);
  const deleted = options.deletedMonths
    ? options.deletedMonths.has(month)
    : await isMonthDeleted(tx, tenant.id, month);
  if (deleted) return { status: 'month_deleted', month };

  const priced = priceCdr(tenant, cdr, billingNumber);
  if (priced === 'no_rate') return { status: 'no_rate' };
  const { entry } = priced;
  await tx.insert(cdrs).values({
    tenantId: tenant.id,
    callUuid: cdr.callUuid,
    startedAt: cdr.startedAt,
    answeredAt: cdr.answeredAt,
    endedAt: cdr.endedAt,
    caller: cdr.caller,
    callee: cdr.callee,
    billingNumber,
    durationSeconds: cdr.billsec,
    billedMinutes: priced.billedMinutes.toFixed(),
    charge: priced.charge.toFixed(),
    matchedPrefix: entry ? entry.prefix : null,
    country: entry ? entry.country : null,
    iso: entry?.iso || null,
    description: entry?.description || null,
    rate: entry ? entry.perMinute.perMinute.toFixed() : null,
    hangupCause: cdr.hangupCause,
    unverified: cdr.unverified,
    ...(cdr.receivedAt && { receivedAt: cdr.receivedAt }),
  });
  return { status: 'inserted', ...priced };
}

export interface ChargeCallOptions {
  /** 已预取的话单已删除月份；批量扣费时传入。 */
  readonly deletedMonths?: ReadonlySet<string> | undefined;
}

export interface ChargeCallResult {
  /** 写入（或幂等命中）的扣费流水的金额，正数；未接通与 0 元为 '0'，没有写流水。 */
  readonly charge: string;
  readonly occurredAt: Date | null;
}

/**
 * 读 cdrs 里保存的费率快照，写一笔 call_charge 流水：金额为负，occurred_at 是接通时间，
 * 幂等键 call:<UUID>，重复调用不重复扣费。调用方已持有租户锁（流水触发器会检查）。
 * 扣费前在锁内复核所属月份的话单是否已删除：删除话单持同一把租户锁，所以入库之后、扣费之前
 * 被删除的月份不会再写入新流水（抛 CdrMonthDeletedError，任务失败并由对账告警）。
 */
export async function chargeCall(
  tx: Tx,
  job: { readonly tenantId: string; readonly callUuid: string },
  options: ChargeCallOptions = {},
): Promise<ChargeCallResult> {
  const [row] = await tx
    .select({
      rate: cdrs.rate,
      billingNumber: cdrs.billingNumber,
      durationSeconds: cdrs.durationSeconds,
      startedAt: cdrs.startedAt,
      answeredAt: cdrs.answeredAt,
      currency: tenants.currency,
    })
    .from(cdrs)
    .innerJoin(tenants, eq(tenants.id, cdrs.tenantId))
    .where(
      and(eq(cdrs.callUuid, job.callUuid), eq(cdrs.tenantId, job.tenantId)),
    );
  if (!row) throw new Error(`话单 ${job.callUuid} 不存在`);
  if (row.answeredAt === null) return { charge: '0', occurredAt: null };
  if (row.rate === null) throw new Error(`话单 ${job.callUuid} 缺少费率快照`);
  const priced = priceCall(row.durationSeconds, rate(row.currency, row.rate));
  if (priced.charge.value.isZero()) return { charge: '0', occurredAt: null };
  const month = cdrMonthStart(row);
  const deleted = options.deletedMonths
    ? options.deletedMonths.has(month)
    : await isMonthDeleted(tx, job.tenantId, month);
  if (deleted) throw new CdrMonthDeletedError(job.callUuid, month);
  await appendLedgerEntry(
    tx,
    { id: job.tenantId, currency: row.currency },
    {
      kind: 'call_charge',
      amount: money(row.currency, priced.charge.value.neg().toFixed()),
      occurredAt: row.answeredAt,
      note: `通话扣费 ${job.callUuid} ${row.billingNumber}`,
      idempotencyKey: callChargeKey(job.callUuid),
    },
  );
  return { charge: priced.charge.value.toFixed(), occurredAt: row.answeredAt };
}
