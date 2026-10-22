import {
  negateDecimalString,
  type AdminTenantStatementResponse,
  type PortalStatementResponse,
} from '@fs-billing/shared';

export type StatementSummarySource = Pick<
  PortalStatementResponse | AdminTenantStatementResponse,
  'figures' | 'countries' | 'days'
>;

export function statementSummaryHeaders(currency: string): string[] {
  return ['类别', '项目', '通话数', '计费分钟', `金额（${currency}）`];
}

/**
 * 汇总 CSV 的长表：一个表头，三类行（汇总、国家、日期）。
 * 汇总类金额带符号（充值、赠送为正，通话扣费为负，调账原符号，期初、期末原值），
 * 所以期初至通话扣费五行之和等于期末余额；国家、日期行的金额是费用（正数）。
 * 通话数与计费分钟只在通话扣费、国家、日期行填写，其余为空。
 */
export function statementSummaryRows(
  statement: StatementSummarySource,
): string[][] {
  const { figures } = statement;
  return [
    ['汇总', '期初余额', '', '', figures.openingBalance],
    ['汇总', '充值', '', '', figures.recharge],
    ['汇总', '赠送', '', '', figures.gift],
    ['汇总', '调账', '', '', figures.adjustment],
    [
      '汇总',
      '通话扣费',
      String(figures.calls),
      figures.callMinutes,
      negateDecimalString(figures.callCharges),
    ],
    ['汇总', '期末余额', '', '', figures.closingBalance],
    ...statement.countries.map((row) => [
      '国家',
      row.country,
      String(row.calls),
      row.minutes,
      row.charge,
    ]),
    ...statement.days.map((row) => [
      '日期',
      row.day,
      String(row.calls),
      row.minutes,
      row.charge,
    ]),
  ];
}
