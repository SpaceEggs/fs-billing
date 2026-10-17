import { z } from 'zod';
import { dayRangeFields } from './day-range.js';

export const CDR_PAGE_SIZE = 50;
export const CDR_MAX_PAGE = 100_000;

const timestamp = z.iso.datetime({ offset: true });
const decimalText = z
  .string()
  .max(128)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const isZero = (value: string) => /^0(?:\.0+)?$/.test(value);

/**
 * 被叫号码搜索词归一化成 billing_number 的写法：国际号码，首位 1-9，不含 + 和 00 冠字、国内长途 0。
 * 去掉空白、连字符、括号和开头的 +，再去掉全部开头的 0，剩余必须是 1 至 15 位数字。
 * 无法归一化时返回 undefined。
 */
export function normalizeCalleeSearch(raw: string): string | undefined {
  const compact = raw.replace(/[\s\-()]/g, '');
  const digits = compact.startsWith('+') ? compact.slice(1) : compact;
  if (!/^[0-9]+$/.test(digits)) return undefined;
  const stripped = digits.replace(/^0+/, '');
  return /^[1-9][0-9]{0,14}$/.test(stripped) ? stripped : undefined;
}

export const calleeSearchSchema = z
  .string()
  .max(40)
  .transform((raw, context) => {
    const normalized = normalizeCalleeSearch(raw);
    if (normalized === undefined) {
      context.addIssue({
        code: 'custom',
        message: '被叫号码只能包含数字、+、空格、连字符和括号',
      });
      return z.NEVER;
    }
    return normalized;
  });

export const cdrStatusSchema = z.enum(['answered', 'all']);

export const pageNumberSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(CDR_MAX_PAGE)
  .default(1);

/** 话单筛选的公共字段：北京日范围、被叫、国家、接通状态。范围上限由 checkDayRange 检查。 */
export const cdrFilterFields = {
  ...dayRangeFields,
  callee: calleeSearchSchema.optional(),
  country: z.string().trim().min(1).max(200).optional(),
  status: cdrStatusSchema.default('answered'),
};

export const cdrPaginationSchema = z.strictObject({
  page: z.int().min(1).max(CDR_MAX_PAGE),
  pageSize: z.literal(CDR_PAGE_SIZE),
  total: z.int().nonnegative(),
});

/**
 * 话单行的公共字段。没有 status 字段：已接通即 answeredAt 非空。
 * 门户在此基础上不再增加字段；后台只多一个 unverified。
 */
export const cdrFields = {
  callUuid: z.uuid(),
  startedAt: timestamp,
  answeredAt: timestamp.nullable(),
  endedAt: timestamp,
  caller: z.string(),
  callee: z.string(),
  country: z.string().nullable(),
  matchedPrefix: z.string().nullable(),
  durationSeconds: z.int().nonnegative(),
  billedMinutes: decimalText,
  rate: decimalText.nullable(),
  charge: decimalText,
  hangupCause: z.string(),
};

type CdrShape = {
  startedAt: string;
  answeredAt: string | null;
  endedAt: string;
  country: string | null;
  matchedPrefix: string | null;
  durationSeconds: number;
  billedMinutes: string;
  rate: string | null;
  charge: string;
};

/** 与 cdrs 的检查约束一致：未接通没有时长和费用，已接通必须有国家、前缀和费率。 */
export function checkCdrShape(cdr: CdrShape, context: z.RefinementCtx) {
  const started = Date.parse(cdr.startedAt);
  const ended = Date.parse(cdr.endedAt);
  if (ended < started)
    context.addIssue({
      code: 'custom',
      path: ['endedAt'],
      message: '挂断时间不能早于振铃开始时间',
    });
  if (cdr.answeredAt === null) {
    if (
      cdr.durationSeconds !== 0 ||
      !isZero(cdr.billedMinutes) ||
      !isZero(cdr.charge)
    )
      context.addIssue({
        code: 'custom',
        path: ['charge'],
        message: '未接通话单的时长、计费分钟和费用必须为 0',
      });
    return;
  }
  const answered = Date.parse(cdr.answeredAt);
  if (answered < started || answered > ended)
    context.addIssue({
      code: 'custom',
      path: ['answeredAt'],
      message: '接通时间必须在振铃开始与挂断之间',
    });
  if (cdr.country === null || cdr.matchedPrefix === null || cdr.rate === null)
    context.addIssue({
      code: 'custom',
      path: ['country'],
      message: '已接通话单必须有国家、匹配前缀和费率',
    });
}

/** 汇总栏：通话数取 pagination.total，不在这里重复。 */
export const cdrSummaryFields = {
  billedMinutes: decimalText,
  charge: decimalText,
  unansweredCalls: z.int().nonnegative(),
};

export const cdrCountriesResponseSchema = z.strictObject({
  countries: z.array(z.string().min(1)),
});
export type CdrCountriesResponse = z.infer<typeof cdrCountriesResponseSchema>;
