export const format = {
  yearMonth: '{{year}}年{{month}}月',
  months: {
    jan: '1月',
    feb: '2月',
    mar: '3月',
    apr: '4月',
    may: '5月',
    jun: '6月',
    jul: '7月',
    aug: '8月',
    sep: '9月',
    oct: '10月',
    nov: '11月',
    dec: '12月',
  },
  duration: '{{minutes}}分{{seconds}}秒',
  billedMinutes: '{{minutes}}分钟',
  rate: {
    cny: '{{value}} 元/分钟',
    usd: '${{value}}/分钟',
  },
} as const;
