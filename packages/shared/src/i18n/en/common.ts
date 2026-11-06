export const common = {
  locale: {
    label: 'Language',
  },
  ui: {
    close: 'Close',
    closeDialog: 'Close dialog',
  },
  theme: {
    label: 'Theme',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
  },
  action: {
    cancel: 'Cancel',
    confirm: 'OK',
    retry: 'Retry',
    reset: 'Reset',
    clearFilters: 'Clear filters',
    backToFirstPage: 'Back to page 1',
  },
  copy: {
    copy: 'Copy',
    copied: 'Copied ✓',
    copyLabel: 'Copy {{label}}',
    copySecret: 'Copy {{label}}',
    failed: 'Cannot access the clipboard. Select the text and copy it manually',
  },
  account: {
    menu: 'Account menu',
    settings: 'Account settings',
    signOut: 'Sign out',
  },
  pagination: {
    label: 'Pagination',
    page: 'Page {{page}} of {{pages}}',
    previous: 'Previous',
    next: 'Next',
  },
  status: {
    normal: 'Normal',
    lowBalance: 'Low balance',
    overdrawn: 'Overdrawn',
    suspended: 'Suspended',
    disabled: 'Disabled',
    paid: 'Paid',
    unpaid: 'Unpaid',
    voided: 'Voided',
    answered: 'Answered',
    unanswered: 'Not connected',
    unverified: 'Unverified',
    settingsMissing: 'Alerts not configured',
  },
  timezone: {
    beijing: 'Beijing time (UTC+8)',
    rangeLimited: 'Beijing time (UTC+8) · up to one month',
  },
  weekday: {
    mon: 'Mon',
    tue: 'Tue',
    wed: 'Wed',
    thu: 'Thu',
    fri: 'Fri',
    sat: 'Sat',
    sun: 'Sun',
  },
  chart: {
    noSpend: 'No spend in the last 30 days',
    label: 'Daily spend for the last {{n}} days',
    todaySuffix: ' (today)',
  },
  filter: {
    title: 'Filter',
    active: 'Filter, {{n}} selected',
    result: 'Show results',
    resultCount: 'Show {{count}}{{unit}} results',
  },
  dateRange: {
    value: '{{label}}: {{from}} to {{to}}',
    previousMonth: 'Previous month',
    nextMonth: 'Next month',
    selectEnd: 'Select an end date',
    endLimitPending:
      'The end date cannot be later than {{date}} (ranges are limited to one month; choosing backwards recalculates from the earlier date)',
    endLimit:
      'The end date cannot be later than {{date}} (ranges are limited to one month)',
  },
  monthField: {
    value: '{{label}}: {{month}}',
    previousMonth: '{{label}}: previous month',
    nextMonth: '{{label}}: next month',
    previousYear: 'Previous year',
    nextYear: 'Next year',
  },
  listComma: ', ',
  error: {
    unavailable: 'The service is temporarily unavailable. Try again later',
    forbidden:
      'This account cannot view this content. Contact another administrator if you need access',
    notFound: 'The content does not exist or has been deleted',
    unknown:
      'The request could not be completed. Refresh the page and try again',
    titleBody: '{{title}}. {{body}}',
    listSeparator: '; ',
    loadForbiddenTitle: 'No permission',
    loadFailedTitle: 'Failed to load',
    loadForbiddenBody:
      'This account cannot view this content. Contact an administrator if you need access',
    loadNetworkBody: 'Network error. Try again later',
    loadRequestBody:
      'The request could not be completed. Refresh the page or contact an administrator',
  },
} as const;
