import {
  DEFAULT_LOCALE,
  negateDecimalString,
  translate,
  type AdminTenantStatementResponse,
  type Locale,
  type PortalStatementResponse,
} from '@fs-billing/shared';

export type StatementSummarySource = Pick<
  PortalStatementResponse | AdminTenantStatementResponse,
  'figures' | 'countries' | 'days'
>;

export function statementSummaryHeaders(
  currency: string,
  locale: Locale = DEFAULT_LOCALE,
): string[] {
  return [
    translate(locale, 'csv:statement.headers.category'),
    translate(locale, 'csv:statement.headers.item'),
    translate(locale, 'csv:statement.headers.calls'),
    translate(locale, 'csv:statement.headers.billedMinutes'),
    translate(locale, 'csv:statement.headers.amount', { currency }),
  ];
}

/**
 * 汇总 CSV 的长表：一个表头，三类行（汇总、国家、日期）。
 * 汇总类金额带符号（充值、赠送为正，通话扣费为负，调账原符号，期初、期末原值），
 * 所以期初至通话扣费五行之和等于期末余额；国家、日期行的金额是费用（正数）。
 * 通话数与计费分钟只在通话扣费、国家、日期行填写，其余为空。
 * 国家名和日期是数据，两种语言都保持原值。
 */
export function statementSummaryRows(
  statement: StatementSummarySource,
  locale: Locale = DEFAULT_LOCALE,
): string[][] {
  const { figures } = statement;
  const category = (key: 'summary' | 'country' | 'day') =>
    translate(locale, `csv:statement.category.${key}`);
  const item = (
    key:
      | 'openingBalance'
      | 'recharge'
      | 'gift'
      | 'adjustment'
      | 'callCharges'
      | 'closingBalance',
  ) => translate(locale, `csv:statement.item.${key}`);
  return [
    [
      category('summary'),
      item('openingBalance'),
      '',
      '',
      figures.openingBalance,
    ],
    [category('summary'), item('recharge'), '', '', figures.recharge],
    [category('summary'), item('gift'), '', '', figures.gift],
    [category('summary'), item('adjustment'), '', '', figures.adjustment],
    [
      category('summary'),
      item('callCharges'),
      String(figures.calls),
      figures.callMinutes,
      negateDecimalString(figures.callCharges),
    ],
    [
      category('summary'),
      item('closingBalance'),
      '',
      '',
      figures.closingBalance,
    ],
    ...statement.countries.map((row) => [
      category('country'),
      row.country,
      String(row.calls),
      row.minutes,
      row.charge,
    ]),
    ...statement.days.map((row) => [
      category('day'),
      row.day,
      String(row.calls),
      row.minutes,
      row.charge,
    ]),
  ];
}
