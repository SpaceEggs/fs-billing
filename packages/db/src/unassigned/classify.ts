import {
  decimal,
  longestPrefix,
  parseDialedNumber,
  versionAt,
  type DialedNumber,
} from '@fs-billing/rating';
import { CDR_VALIDATION_FAILURE_PREFIX } from '@fs-billing/shared';
import {
  cdrMonthStart,
  priceCdr,
  type Decimal,
  type IntakeCdr,
  type IntakeTenant,
  type PricedCdr,
} from '../cdr-intake.js';
import { ASSIGNABLE_REASONS, type SelectedRow } from './types.js';

export type NoRateReason = 'before_first_version' | 'prefix_not_in_version';

export interface AssignableRow {
  readonly row: SelectedRow;
  readonly cdr: IntakeCdr;
  readonly billingNumber: DialedNumber;
  readonly priced: PricedCdr;
  /** 接通所在的北京月（YYYY-MM-01）；未接通为 null。 */
  readonly answeredMonth: string | null;
}

export interface NoRateRow {
  readonly row: SelectedRow;
  readonly reason: NoRateReason;
  /** 租户任一费率版本里与该号码最长前缀匹配的条目；没有则为 null。 */
  readonly prefixHint: {
    readonly prefix: string;
    readonly country: string;
  } | null;
  readonly billingNumber: DialedNumber;
}

export interface Classification {
  readonly assignable: AssignableRow[];
  readonly noRate: NoRateRow[];
  /** 接通所在月份的话单已删除（决定 38）。 */
  readonly blocked: { readonly row: SelectedRow; readonly month: string }[];
  /** 无身份、无计费号码或原因不在可分配范围（决定 35）。 */
  readonly notAssignable: {
    readonly row: SelectedRow;
    readonly reason: string;
  }[];
  readonly chargeTotal: Decimal;
}

/** 校验失败的原因带每行不同的明细，汇总时合成一类。 */
export function reasonLabel(reason: string): string {
  return reason.startsWith(CDR_VALIDATION_FAILURE_PREFIX)
    ? CDR_VALIDATION_FAILURE_PREFIX.replace(/[:：]\s*$/, '')
    : reason;
}

function prefixHintFor(
  tenant: IntakeTenant,
  billingNumber: DialedNumber,
): NoRateRow['prefixHint'] {
  let best: { prefix: string; country: string } | null = null;
  for (const version of tenant.rating?.rates.versions ?? []) {
    const entry = longestPrefix(version.entries, billingNumber);
    if (entry && (!best || entry.prefix.length > best.prefix.length))
      best = { prefix: entry.prefix, country: entry.country };
  }
  return best;
}

/**
 * 把选中的待处理行按目标租户分成可分配、无费率、月份已冻结、不可分配四类。
 * 预览与分配（锁内重算）共用这一个函数，两边的数字不会各算各的。
 */
export function classifyRows(
  rows: readonly SelectedRow[],
  tenant: IntakeTenant,
  deletedMonths: ReadonlySet<string>,
): Classification {
  const assignable: AssignableRow[] = [];
  const noRate: NoRateRow[] = [];
  const blocked: Classification['blocked'][number][] = [];
  const notAssignable: Classification['notAssignable'][number][] = [];
  let chargeTotal = decimal('0');
  for (const row of rows) {
    const billingNumber =
      row.billingNumber === null
        ? undefined
        : parseDialedNumber(row.billingNumber);
    if (
      row.callUuid === null ||
      row.startedAt === null ||
      row.endedAt === null ||
      billingNumber === undefined ||
      !ASSIGNABLE_REASONS.includes(row.reason)
    ) {
      notAssignable.push({ row, reason: reasonLabel(row.reason) });
      continue;
    }
    const cdr: IntakeCdr = {
      callUuid: row.callUuid,
      startedAt: row.startedAt,
      answeredAt: row.answeredAt,
      endedAt: row.endedAt,
      caller: row.caller,
      callee: row.callee,
      billsec: row.durationSeconds,
      hangupCause: row.hangupCause,
      unverified: row.unverified,
      receivedAt: row.receivedAt,
    };
    const month = cdrMonthStart(cdr);
    if (deletedMonths.has(month)) {
      blocked.push({ row, month });
      continue;
    }
    const priced = priceCdr(tenant, cdr, billingNumber);
    if (priced === 'no_rate') {
      // 接通时刻有生效的版本而前缀不在其中，或接通早于租户的第一个费率版本。
      const version = tenant.rating
        ? versionAt(tenant.rating.rates, row.answeredAt!)
        : undefined;
      noRate.push({
        row,
        reason: version ? 'prefix_not_in_version' : 'before_first_version',
        prefixHint: prefixHintFor(tenant, billingNumber),
        billingNumber,
      });
      continue;
    }
    chargeTotal = chargeTotal.plus(priced.charge);
    assignable.push({
      row,
      cdr,
      billingNumber,
      priced,
      answeredMonth: row.answeredAt ? cdrMonthStart(cdr) : null,
    });
  }
  return { assignable, noRate, blocked, notAssignable, chargeTotal };
}
