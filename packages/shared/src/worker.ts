import { z } from 'zod';

export const INVALID_NUMBER_REASON = '号码格式错误';
export const CDR_VALIDATION_FAILURE_PREFIX = '话单校验失败: ';
/** 校验失败原因最多列出的问题数，超出写「等 N 项」。 */
export const CDR_ISSUE_LIMIT = 5;
/** 校验失败原因的最大长度（含前缀）。 */
export const CDR_REASON_MAX_LENGTH = 200;

export const dialedNumberSchema = z
  .string()
  .regex(/^[1-9][0-9]{5,14}(?![\s\S])/, INVALID_NUMBER_REASON);
export const authorizeRequestSchema = z.object({
  tenant: z.string().regex(/^[A-Za-z0-9]+$/),
  callee: z.string(),
  dialedNumber: z.string(),
  billingNumber: z.string().optional(),
  uuid: z.uuid(),
});
export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>;
export const authorizeResponseSchema = z.discriminatedUnion('allowed', [
  z.object({
    allowed: z.literal(true),
    maxSeconds: z.number().int().positive().max(14400),
    billingNumber: dialedNumberSchema,
  }),
  z.object({
    allowed: z.literal(false),
    reason: z.enum([
      INVALID_NUMBER_REASON,
      '租户不存在',
      '租户已停用',
      '无费率',
      '余额不足',
    ]),
    sipCode: z.union([
      z.literal(403),
      z.literal(404),
      z.literal(402),
      z.literal(484),
    ]),
  }),
]);
export type AuthorizeResponse = z.infer<typeof authorizeResponseSchema>;

// mod_json_cdr 的秒数通常是字符串；拒绝空串、负数、小数及溢出。
const seconds = z
  .union([z.string().regex(/^[0-9]+$/), z.number()])
  .pipe(z.coerce.number<string | number>().int().min(0).max(2147483647));
const epoch = seconds;
const microseconds = z.union([z.string().regex(/^[0-9]+$/), z.number()]).pipe(
  z.coerce
    .number<string | number>()
    .int()
    .min(0)
    .max(2147483647 * 1_000_000 + 999_999),
);
const flag = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');
export const modJsonCdrSchema = z
  .object({
    variables: z
      .object({
        uuid: z.uuid().transform((value) => value.toLowerCase()),
        billing_tenant: z.string().default(''),
        start_epoch: epoch.refine((value) => value > 0),
        start_uepoch: microseconds.optional(),
        answer_epoch: epoch.optional(),
        answer_uepoch: microseconds.optional(),
        end_epoch: epoch.refine((value) => value > 0),
        end_uepoch: microseconds.optional(),
        billsec: seconds,
        duration: seconds,
        billing_unverified: flag.default(false),
        caller_id_number: z.string().optional(),
        destination_number: z.string().optional(),
        billing_dialed_number: z.string(),
        billing_number: z.string().optional(),
        hangup_cause: z.string().default(''),
      })
      .transform((v) => ({
        ...v,
        answer_epoch:
          v.answer_epoch ?? Math.floor((v.answer_uepoch ?? 0) / 1_000_000),
        startMicros: v.start_uepoch ?? v.start_epoch * 1_000_000,
        answerMicros: v.answer_uepoch ?? (v.answer_epoch ?? 0) * 1_000_000,
        endMicros: v.end_uepoch ?? v.end_epoch * 1_000_000,
      })),
    callflow: z
      .array(
        z.object({
          caller_profile: z
            .object({
              caller_id_number: z.string().optional(),
              destination_number: z.string().optional(),
            })
            .optional(),
        }),
      )
      .optional(),
  })
  .superRefine(({ variables: v }, ctx) => {
    if (
      (v.start_uepoch !== undefined &&
        Math.floor(v.start_uepoch / 1_000_000) !== v.start_epoch) ||
      (v.answer_uepoch !== undefined &&
        Math.floor(v.answer_uepoch / 1_000_000) !== v.answer_epoch) ||
      (v.end_uepoch !== undefined &&
        Math.floor(v.end_uepoch / 1_000_000) !== v.end_epoch) ||
      v.endMicros < v.startMicros ||
      (v.answerMicros !== 0 &&
        (v.answerMicros < v.startMicros || v.answerMicros > v.endMicros)) ||
      v.end_epoch < v.start_epoch ||
      (v.answer_epoch !== 0 &&
        (v.answer_epoch < v.start_epoch || v.answer_epoch > v.end_epoch)) ||
      v.duration !== v.end_epoch - v.start_epoch ||
      v.billsec > v.duration ||
      (v.answer_epoch === 0
        ? v.billsec !== 0
        : v.billsec > v.end_epoch - v.answer_epoch)
    ) {
      ctx.addIssue({ code: 'custom', message: '话单时间与时长不一致' });
    }
  })
  .transform(({ variables: v, callflow }) => ({
    callUuid: v.uuid,
    tenantTag: v.billing_tenant,
    // Date and the database driver retain milliseconds; truncate the remaining microseconds.
    startedAt: new Date(Math.floor(v.startMicros / 1000)),
    answeredAt:
      v.answerMicros === 0 ? null : new Date(Math.floor(v.answerMicros / 1000)),
    endedAt: new Date(Math.floor(v.endMicros / 1000)),
    billsec: v.billsec,
    duration: v.duration,
    unverified: v.billing_unverified,
    caller:
      v.caller_id_number ??
      callflow?.[0]?.caller_profile?.caller_id_number ??
      '',
    callee: v.billing_dialed_number,
    billingNumber: v.billing_number,
    hangupCause: v.hangup_cause,
  }));
export type ParsedCdr = z.infer<typeof modJsonCdrSchema>;

/**
 * 话单校验失败的简短原因：固定前缀加最多 5 个「路径(错误码)」，超出写「等 N 项」（N 为问题总数），
 * 总长不超过 200 字符。路径取自 schema 的字段名，不含输入值，也不含 Zod 的 message；完整信息仍在 raw_cdrs.body。
 */
export function summarizeCdrIssues(error: {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly code: string;
  }[];
}): string {
  const entries: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.') || '(root)';
    const entry = `${path}(${issue.code})`;
    if (!entries.includes(entry)) entries.push(entry);
  }
  const shown = entries.slice(0, CDR_ISSUE_LIMIT);
  const render = () =>
    `${CDR_VALIDATION_FAILURE_PREFIX}${shown.join(', ')}${
      entries.length > shown.length ? ` 等 ${entries.length} 项` : ''
    }`;
  while (render().length > CDR_REASON_MAX_LENGTH && shown.length > 1)
    shown.pop();
  return render().slice(0, CDR_REASON_MAX_LENGTH);
}

export const chargeJobSchema = z.object({
  tenantId: z.uuid(),
  callUuid: z.uuid(),
});
export type ChargeJob = z.infer<typeof chargeJobSchema>;
export const cdrResponseSchema = z.object({
  status: z.enum(['queued', 'duplicate', 'unassigned', 'invalid']),
  rawId: z.uuid(),
});
