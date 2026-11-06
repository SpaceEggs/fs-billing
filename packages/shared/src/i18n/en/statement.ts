export const statement = {
  period: {
    plain: '{{from}} to {{to}}',
    opened: '{{from}} (opened) to {{to}}',
    inProgress: '{{from}} to {{to}} (in progress)',
    openedInProgress: '{{from}} (opened) to {{to}} (in progress)',
  },
  unmatchedCharge: 'Some charges have no matching CDR rows',
} as const;
