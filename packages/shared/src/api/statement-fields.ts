import { z } from 'zod';
import { moneyAmountSchema, nonnegativeMoneyAmountSchema } from './money.js';

/**
 * 月账单的公共字段表。门户与后台各自从这里组合自己的 schema，互不继承：
 * 门户 schema 里不会出现版本、生成人、核对状态、差额，增加字段只能在后台那一侧。
 */

/** 账单月份，路径与查询里的写法 YYYY-MM；存储里的 date（该月 1 日）由数据库层换算。 */
export const statementMonthSchema = z
  .string()
  .regex(/^[0-9]{4}-(?:0[1-9]|1[0-2])$/)
  .refine((month) => !month.startsWith('0000'), {
    message: '账单月份必须在 0001-01 之后',
  });
export const statementMonthParamsSchema = z.strictObject({
  month: statementMonthSchema,
});
export type StatementMonthParams = z.infer<typeof statementMonthParamsSchema>;

/**
 * final：已有账单行；in_progress：当前北京月（实时）；pending：月份已结束但还没有账单行（实时）。
 * 列表与详情用同一个枚举。
 */
export const STATEMENT_STATES = ['final', 'in_progress', 'pending'] as const;
export const statementStateSchema = z.enum(STATEMENT_STATES);
export type StatementState = z.infer<typeof statementStateSchema>;

const timestamp = z.iso.datetime({ offset: true });

/** 账单的 6 个数、通话数和计费分钟。金额与分钟是规范十进制字符串，不舍入。 */
export const statementFigureFields = {
  openingBalance: moneyAmountSchema,
  recharge: nonnegativeMoneyAmountSchema,
  gift: nonnegativeMoneyAmountSchema,
  /** 带符号：赊账作废产生的反向调账也在这里。 */
  adjustment: moneyAmountSchema,
  /** 正数，公式里减去。 */
  callCharges: nonnegativeMoneyAmountSchema,
  closingBalance: moneyAmountSchema,
  /** 已接通话单条数，含 0 元通话。 */
  calls: z.int().nonnegative(),
  callMinutes: nonnegativeMoneyAmountSchema,
};

export const statementCountryFields = {
  country: z.string().min(1),
  calls: z.int().nonnegative(),
  minutes: nonnegativeMoneyAmountSchema,
  charge: nonnegativeMoneyAmountSchema,
};
export const statementDayFields = {
  /** 北京日。 */
  day: z.iso.date(),
  calls: z.int().nonnegative(),
  minutes: nonnegativeMoneyAmountSchema,
  charge: nonnegativeMoneyAmountSchema,
};

export const statementPeriodFields = {
  /** 首月是开户日，其余是该月 1 日。 */
  from: z.iso.date(),
  /** 进行中月份是读取时的北京日，其余是该月最后一天。 */
  to: z.iso.date(),
  /** 开户日落在这个月时非空，用于「2026-08-12（开户）至 2026-08-31」。 */
  openedOn: z.iso.date().nullable(),
};

export const statementReconcileStatusSchema = z.enum([
  'unchecked',
  'ok',
  'stale',
  'inconsistent',
]);
export type StatementReconcileStatus = z.infer<
  typeof statementReconcileStatusSchema
>;

/** 后台「重新生成」按钮的状态：进行中月份和话单已删除的月份不可用。 */
export const adminStatementRegenerableSchema = z
  .strictObject({
    allowed: z.boolean(),
    reason: z.enum(['in_progress', 'details_deleted']).nullable(),
  })
  .refine((value) => value.allowed === (value.reason === null), {
    message: '可重新生成时不应有原因，不可时必须有原因',
  });

export const statementTimestampSchema = timestamp;

type Parsed = { negative: boolean; digits: string; scale: number };
function parseDecimal(value: string): Parsed {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  return { negative, digits: `${whole}${fraction}`, scale: fraction.length };
}

function scaledSum(values: readonly string[], negated: ReadonlySet<number>) {
  const parsed = values.map(parseDecimal);
  const scale = Math.max(0, ...parsed.map((value) => value.scale));
  let total = 0n;
  parsed.forEach((value, index) => {
    const unit = BigInt(value.digits) * 10n ** BigInt(scale - value.scale);
    const signed = value.negative ? -unit : unit;
    total += negated.has(index) ? -signed : signed;
  });
  return { total, scale };
}

function formatScaled(total: bigint, scale: number): string {
  if (total === 0n) return '0';
  const negative = total < 0n;
  const digits = (negative ? -total : total)
    .toString()
    .padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** 精确十进制加法，结果规范（无多余尾零、无负零）。 */
export function addDecimalStrings(values: readonly string[]): string {
  const { total, scale } = scaledSum(values, new Set());
  return formatScaled(total, scale);
}

/** 精确十进制取反，结果规范；零仍是 '0'。 */
export function negateDecimalString(value: string): string {
  const { total, scale } = scaledSum([value], new Set([0]));
  return formatScaled(total, scale);
}

type Figures = {
  openingBalance: string;
  recharge: string;
  gift: string;
  adjustment: string;
  callCharges: string;
  closingBalance: string;
};

/** 期末 = 期初 + 充值 + 赠送 + 调账 − 通话扣费，精确相等。 */
export function statementFiguresBalance(figures: Figures): boolean {
  const { total } = scaledSum(
    [
      figures.openingBalance,
      figures.recharge,
      figures.gift,
      figures.adjustment,
      figures.callCharges,
      figures.closingBalance,
    ],
    new Set([4, 5]),
  );
  return total === 0n;
}

export function checkStatementFigures(
  figures: Figures,
  context: z.RefinementCtx,
  path: (string | number)[] = [],
) {
  if (!statementFiguresBalance(figures))
    context.addIssue({
      code: 'custom',
      path: [...path, 'closingBalance'],
      message: '期末余额必须等于期初 + 充值 + 赠送 + 调账 − 通话扣费',
    });
}

/**
 * 实时月份（进行中、待生成）有 asOf、没有生成时间；已生成的月份相反。
 * 话单已删除只会出现在已生成的月份。
 */
export function checkStatementLiveness(
  value: {
    state: z.infer<typeof statementStateSchema>;
    generatedAt: string | null;
    detailsDeleted: boolean;
    asOf?: string | null;
  },
  context: z.RefinementCtx,
) {
  const live = value.state !== 'final';
  if (live !== (value.generatedAt === null))
    context.addIssue({
      code: 'custom',
      path: ['generatedAt'],
      message: '只有已生成的账单才有生成时间',
    });
  if (value.asOf !== undefined && live !== (value.asOf !== null))
    context.addIssue({
      code: 'custom',
      path: ['asOf'],
      message: '只有实时月份才有读取时刻',
    });
  if (live && value.detailsDeleted)
    context.addIssue({
      code: 'custom',
      path: ['detailsDeleted'],
      message: '实时月份没有已删除的话单明细',
    });
}

/** 国家与日期明细：国家不重复，日期升序且不重复。 */
export function checkStatementBreakdown(
  value: {
    countries: readonly { country: string }[];
    days: readonly { day: string }[];
  },
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, row] of value.countries.entries()) {
    if (seen.has(row.country))
      context.addIssue({
        code: 'custom',
        path: ['countries', index, 'country'],
        message: '国家不能重复',
      });
    seen.add(row.country);
  }
  for (const [index, row] of value.days.entries()) {
    const previous = value.days[index - 1];
    if (previous && previous.day >= row.day)
      context.addIssue({
        code: 'custom',
        path: ['days', index, 'day'],
        message: '日期必须升序且不重复',
      });
  }
}
