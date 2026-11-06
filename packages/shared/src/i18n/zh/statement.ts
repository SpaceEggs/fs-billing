export const statement = {
  period: {
    plain: '{{from}} 至 {{to}}',
    opened: '{{from}}（开户）至 {{to}}',
    inProgress: '{{from}} 至 {{to}}（进行中）',
    openedInProgress: '{{from}}（开户）至 {{to}}（进行中）',
  },
  unmatchedCharge: '部分扣费没有对应的话单明细',
} as const;
