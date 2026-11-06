export const format = {
  year: '{{year}}',
  yearMonth: '{{month}} {{year}}',
  months: {
    jan: 'Jan',
    feb: 'Feb',
    mar: 'Mar',
    apr: 'Apr',
    may: 'May',
    jun: 'Jun',
    jul: 'Jul',
    aug: 'Aug',
    sep: 'Sep',
    oct: 'Oct',
    nov: 'Nov',
    dec: 'Dec',
  },
  duration: '{{minutes}}m {{seconds}}s',
  billedMinutes: '{{minutes}} min',
  rate: {
    cny: '¥{{value}}/min',
    usd: '${{value}}/min',
  },
  rateUnit: {
    cny: '¥/min',
    usd: '$/min',
  },
} as const;
