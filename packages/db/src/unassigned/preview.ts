import { and, eq, inArray } from 'drizzle-orm';
import { decimal, type Currency } from '@fs-billing/rating';
import { withAdmin, type Db, type Tx } from '../client.js';
import { loadDeletedMonths, type IntakeTenant } from '../cdr-intake.js';
import { NotFoundError } from '../errors.js';
import { loadRatingTenant } from '../rates.js';
import { monthlyStatements, tenants } from '../schema.js';
import { currentStatementMonth, monthKey } from '../statements/months.js';
import {
  classifyRows,
  type Classification,
  type NoRateReason,
} from './classify.js';
import {
  ASSIGN_MAX_ROWS,
  selectRows,
  type SelectedRow,
  type UnassignedSelection,
} from './types.js';

/** 目标租户：分配用它的币种与接通时刻生效的费率定价。 */
export interface AssignmentTarget extends IntakeTenant {
  readonly code: string;
  readonly name: string;
  readonly currency: Currency;
  /** 缓存余额，十进制字符串。 */
  readonly balance: string;
}

export async function loadAssignmentTarget(
  tx: Tx,
  tenantId: string,
): Promise<AssignmentTarget> {
  const [tenant] = await tx
    .select({
      id: tenants.id,
      code: tenants.code,
      name: tenants.name,
      currency: tenants.currency,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new NotFoundError('租户不存在');
  const rating = await loadRatingTenant(tx, tenant.code);
  return {
    ...tenant,
    rating,
    balance: rating?.balance.value.toFixed() ?? '0',
  };
}

/** final：该月已有账单，补扣费后会过期；live：当前北京月，账单尚未生成；none：月份已结束而账单还没生成。 */
export type AffectedMonthState = 'final' | 'live' | 'none';

export interface AffectedMonth {
  /** YYYY-MM。 */
  readonly month: string;
  readonly statementState: AffectedMonthState;
}

export async function describeAffectedMonths(
  tx: Tx,
  tenantId: string,
  months: readonly string[],
): Promise<AffectedMonth[]> {
  if (months.length === 0) return [];
  const sorted = [...new Set(months)].sort();
  const final = new Set(
    (
      await tx
        .select({ month: monthlyStatements.month })
        .from(monthlyStatements)
        .where(
          and(
            eq(monthlyStatements.tenantId, tenantId),
            inArray(monthlyStatements.month, sorted),
          ),
        )
    ).map((row) => row.month),
  );
  const current = await currentStatementMonth(tx);
  return sorted.map((month) => ({
    month: monthKey(month),
    statementState: final.has(month)
      ? 'final'
      : month >= current
        ? 'live'
        : 'none',
  }));
}

export interface NoRateGroup {
  readonly reason: NoRateReason;
  readonly prefixHint: {
    readonly prefix: string;
    readonly country: string;
  } | null;
  readonly count: number;
  /** before_first_version 时租户第一个费率版本的生效时间；其他情形为 null。 */
  readonly firstEffectiveFrom: Date | null;
  /** 至多 3 条样例，文案取接通日期与号码。 */
  readonly samples: readonly {
    readonly id: string;
    readonly answeredAt: Date;
    readonly billingNumber: string;
  }[];
}

export interface AssignmentPreview {
  readonly tenant: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly currency: Currency;
  };
  /** 选中的待处理话单条数。 */
  readonly selected: number;
  readonly assignable: number;
  /** 十进制字符串，租户币种；不舍入。 */
  readonly chargeTotal: string;
  readonly currency: Currency;
  readonly noRate: {
    readonly count: number;
    readonly groups: readonly NoRateGroup[];
  };
  readonly blocked: {
    readonly count: number;
    readonly months: readonly string[];
  };
  readonly notAssignable: {
    readonly count: number;
    readonly reasons: readonly {
      readonly reason: string;
      readonly count: number;
    }[];
  };
  readonly balance: {
    readonly current: string;
    readonly afterEstimate: string;
  };
  readonly affectedMonths: readonly AffectedMonth[];
}

export function noRateGroups(
  classification: Pick<Classification, 'noRate'>,
  target: Pick<AssignmentTarget, 'rating'>,
): NoRateGroup[] {
  const firstVersion = target.rating?.rates.versions.reduce<Date | null>(
    (earliest, version) =>
      earliest === null || version.effectiveFrom < earliest
        ? version.effectiveFrom
        : earliest,
    null,
  );
  const groups = new Map<
    string,
    {
      reason: NoRateReason;
      prefixHint: NoRateGroup['prefixHint'];
      count: number;
      samples: NoRateGroup['samples'][number][];
    }
  >();
  for (const item of classification.noRate) {
    const key = `${item.reason}:${item.prefixHint?.prefix ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        reason: item.reason,
        prefixHint: item.prefixHint,
        count: 0,
        samples: [],
      };
      groups.set(key, group);
    }
    group.count++;
    if (group.samples.length < 3 && item.row.answeredAt)
      group.samples.push({
        id: item.row.id,
        answeredAt: item.row.answeredAt,
        billingNumber: item.billingNumber,
      });
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((group) => ({
      ...group,
      firstEffectiveFrom:
        group.reason === 'before_first_version' ? (firstVersion ?? null) : null,
    }));
}

export function notAssignableReasons(
  classification: Pick<Classification, 'notAssignable'>,
): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of classification.notAssignable)
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function blockedMonths(
  classification: Pick<Classification, 'blocked'>,
): string[] {
  return [...new Set(classification.blocked.map((item) => item.month))]
    .sort()
    .map(monthKey);
}

/** 受影响的北京月（YYYY-MM-01）：可分配的已接通话单的接通月。 */
export function affectedMonthStarts(
  classification: Pick<Classification, 'assignable'>,
): string[] {
  return [
    ...new Set(
      classification.assignable.flatMap((item) =>
        item.answeredMonth ? [item.answeredMonth] : [],
      ),
    ),
  ].sort();
}

export function previewFrom(
  target: AssignmentTarget,
  selected: readonly SelectedRow[],
  classification: Classification,
  affectedMonths: readonly AffectedMonth[],
): AssignmentPreview {
  const chargeTotal = classification.chargeTotal;
  return {
    tenant: {
      id: target.id,
      code: target.code,
      name: target.name,
      currency: target.currency,
    },
    selected: selected.length,
    assignable: classification.assignable.length,
    chargeTotal: chargeTotal.toFixed(),
    currency: target.currency,
    noRate: {
      count: classification.noRate.length,
      groups: noRateGroups(classification, target),
    },
    blocked: {
      count: classification.blocked.length,
      months: blockedMonths(classification),
    },
    notAssignable: {
      count: classification.notAssignable.length,
      reasons: notAssignableReasons(classification),
    },
    balance: {
      current: target.balance,
      afterEstimate: decimal(target.balance).minus(chargeTotal).toFixed(),
    },
    affectedMonths,
  };
}

/**
 * 分配预览：只读，不拿租户锁，不落库，不写日志。
 * 与分配用同一个 classifyRows，目标租户的费率按话单的接通时刻取版本（决定 1）。
 * afterEstimate 只用于展示，提交时以事务内的实算为准。
 */
export function previewAssignment(
  db: Db | Tx,
  input: {
    tenantId: string;
    selection: UnassignedSelection;
    maxRows?: number;
  },
): Promise<AssignmentPreview> {
  return withAdmin(db, async (tx) => {
    const target = await loadAssignmentTarget(tx, input.tenantId);
    const selected = await selectRows(tx, input.selection, {
      status: 'pending',
      lock: false,
      maxRows: input.maxRows ?? ASSIGN_MAX_ROWS,
    });
    const classification = classifyRows(
      selected,
      target,
      await loadDeletedMonths(tx, target.id),
    );
    const affectedMonths = await describeAffectedMonths(
      tx,
      target.id,
      affectedMonthStarts(classification),
    );
    return previewFrom(target, selected, classification, affectedMonths);
  });
}
