const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const statementTenantId = uuid(0xa001);
export const adminTenant = {
  id: statementTenantId,
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
};

/** 满足 期末 = 期初 + 充值 + 赠送 + 调账 − 通话扣费 的账单数字。 */
export function figures(over: Record<string, string | number> = {}) {
  return {
    openingBalance: '0',
    recharge: '3000',
    gift: '50',
    adjustment: '0',
    callCharges: '1873.4',
    closingBalance: '1176.6',
    calls: 9642,
    callMinutes: '37468',
    ...over,
  };
}

export const augustFigures = figures();
export const septemberFigures = figures({
  openingBalance: '1176.6',
  recharge: '1300',
  gift: '0',
  adjustment: '-25.5',
  callCharges: '2486.3',
  closingBalance: '-35.2',
  calls: 12804,
  callMinutes: '49726',
});

const stored = {
  generatedAt: '2026-09-01T18:00:15.000Z',
  firstGeneratedAt: '2026-09-01T18:00:15.000Z',
  version: 1,
  detailsDeleted: false,
  reconcileStatus: 'unchecked',
  regenerable: { allowed: true, reason: null },
};

export function finalRow(
  month: string,
  rowFigures: object,
  over: Record<string, unknown> = {},
) {
  return { month, state: 'final', figures: rowFigures, ...stored, ...over };
}

export function inProgressRow(month: string, rowFigures: object) {
  return {
    month,
    state: 'in_progress',
    figures: rowFigures,
    generatedAt: null,
    firstGeneratedAt: null,
    version: 0,
    detailsDeleted: false,
    reconcileStatus: null,
    regenerable: { allowed: false, reason: 'in_progress' },
  };
}

export function pendingTenantRow(month: string, rowFigures: object) {
  return {
    month,
    state: 'pending',
    figures: rowFigures,
    generatedAt: null,
    firstGeneratedAt: null,
    version: 0,
    detailsDeleted: false,
    reconcileStatus: null,
    regenerable: { allowed: true, reason: null },
  };
}

export function listRow(
  tenant: { id: string; code: string; name: string },
  month: string,
  rowFigures: object | null,
  over: Record<string, unknown> = {},
) {
  return rowFigures
    ? { tenant, ...finalRow(month, rowFigures), ...over }
    : {
        tenant,
        month,
        state: 'pending',
        figures: null,
        generatedAt: null,
        firstGeneratedAt: null,
        version: 0,
        detailsDeleted: false,
        reconcileStatus: null,
        regenerable: { allowed: true, reason: null },
        ...over,
      };
}

export const zero = figures({
  openingBalance: '0',
  recharge: '0',
  gift: '0',
  adjustment: '0',
  callCharges: '0',
  closingBalance: '0',
  calls: 0,
  callMinutes: '0',
});
