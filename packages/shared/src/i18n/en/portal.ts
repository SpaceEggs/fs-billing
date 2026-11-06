export const portal = {
  ledgerKind: {
    recharge: 'Recharge',
    gift: 'Gift',
    adjustment: 'Adjustment',
    callCharge: 'Call charges',
  },
  home: {
    suspended: {
      title: 'Insufficient balance. Calls suspended',
      body: 'Contact customer service to make a top-up. Calls resume automatically once it arrives.',
    },
    balance: 'Current balance',
    available: 'Available balance',
    overdraftLimit: 'Overdraft limit',
    overdraftNote:
      'Calls are suspended when the balance and overdraft limit are used up',
    negativeBalance: 'The balance is negative. Available balance is still',
    monthSpend: 'Spend this month',
    monthSpendSub: '{{month}} · as of today',
    monthMinutes: 'Call minutes this month',
    monthMinutesMobile: 'This month',
    answeredCalls_one: '{{formatted}} answered call',
    answeredCalls_other: '{{formatted}} answered calls',
    minutesUnit: ' min',
    daily: {
      label: 'Daily spend for the last 30 days',
      mobileLabel: 'Spend in the last 30 days',
      range: '{{from}} to {{to}}',
      total: 'Total',
      totalLabel: 'Total {{total}}',
      swipe: '← Swipe',
    },
    noCalls: {
      label: 'No calls',
      title: 'No calls',
      body: 'Once outbound calls start, spend charts and recent calls appear here',
    },
    recent: {
      label: 'Recent calls',
      mobileTitle: 'Recent calls',
      title: 'Last 10 calls',
      all: 'View all',
    },
    loading: 'Loading home',
  },
  cdrs: {
    title: 'Calls',
    exportLabel: 'Export CSV (current filters)',
    rangeTooLong:
      'The date range exceeds the one-month limit: {{from}} to {{to}}. The end date cannot be later than {{limit}}.',
    timezone: 'Beijing time (UTC+8)',
  },
  statements: {
    title: 'Monthly statements',
    byMonth: ' · By calendar month, Beijing time (UTC+8)',
    empty: {
      label: 'No statements yet',
      title: 'No statements yet',
      body: 'Once the account is open, this month’s statement appears here in real time. The previous month’s final statement is generated early on the 1st.',
      bodyMobile:
        'This month’s statement appears here in real time. The previous month’s final statement is generated early on the 1st.',
    },
    refreshFailed: 'Failed to refresh statements. Data may be out of date',
    liveNote:
      'This month updates in real time as of {{time}}. The previous month’s final statement is generated early on the 1st. “Recharge” includes every credit received.',
    liveNoteCompact:
      'Select a month to see recharges, gifts, adjustments and call minutes',
    loadFailed: 'Failed to load statements',
    loading: 'Loading statements',
  },
  statementDetail: {
    detailsDeleted: 'Call details for this month were deleted',
    detailsDeletedBody:
      'The statement summary is unaffected, but call details can no longer be exported.',
    detailsDeletedBodyMobile:
      'The statement summary is unaffected, but call details can no longer be exported.',
    generatedAt: 'Statement generated at {{time}}',
    asOf: 'Data as of {{time}}',
    liveSuffix: ' · live updates',
    pendingSuffix: ' · final statement pending',
    inProgressNote:
      'This month is not over. The figures below are as of today and update in real time; the final statement is generated early on {{date}}.',
    pendingNote:
      'This month has ended and the final statement has not been generated yet. The figures below are computed in real time.',
    moreActions: 'More actions',
    print: 'Print',
    currency: 'Currency',
    exportSummary: 'Export CSV (summary)',
    exportDetails: 'Export CSV (call details for the month)',
    exporting: 'Exporting…',
    back: 'Back to statements',
    timezone: 'Beijing time (UTC+8)',
  },
  ledger: {
    title: 'Balance history',
    time: 'Time',
    kind: 'Type',
    amount: 'Amount',
    balanceAfter: 'Balance after',
    note: 'Note',
    balance: 'Balance',
    allKinds: 'All types',
    exporting: 'Exporting…',
    export: 'Export CSV',
    exportFailed: 'Export failed: {{reason}}',
    exportInterrupted: 'Export interrupted. Try again',
    currentBalance: 'Current balance',
    dateRange: 'Date range (Beijing time (UTC+8))',
    unit: 'entries',
    mergeNote:
      'Call charges are merged by day. Select one to view that day’s calls',
    refreshFailed: 'Failed to refresh balance history. Data may be out of date',
    rangeTooLong:
      'The date range exceeds the one-month limit: {{from}} to {{to}}. The end date cannot be later than {{limit}}.',
    total_one: '{{total}} entry',
    total_other: '{{total}} entries',
    filteredTotal: ' · Total ',
    loadFailed: 'Failed to load balance history',
    loading: 'Loading balance history',
    empty: {
      title: 'No balance history yet',
      body: 'After a top-up arrives or call charges are incurred, every change is recorded here',
    },
    filteredEmpty: {
      title: 'No entries match the filters',
      range: '{{from}} — {{to}}',
      kind: ' · Type: {{kind}}',
    },
    range: '{{from}}–{{to}} of {{total}}',
  },
  settings: {
    title: 'Account settings',
    info: 'Account information',
    infoHint:
      'These details are set by an administrator. Contact customer service to change them',
    email: 'Email',
    tenant: 'Tenant',
    currency: 'Currency',
    currencyNames: {
      CNY: 'CNY (Chinese yuan)',
      USD: 'USD (US dollar)',
    },
    theme: 'Theme',
  },
} as const;
