import { z } from 'zod';

export const dialedNumberSchema = z
  .string()
  .regex(/^(?!00)[0-9]+$/, '号码格式错误');
export const authorizeRequestSchema = z.object({
  tenant: z.string().regex(/^[A-Za-z0-9]+$/),
  callee: dialedNumberSchema,
  uuid: z.uuid(),
});
export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>;
export const authorizeResponseSchema = z.discriminatedUnion('allowed', [
  z.object({
    allowed: z.literal(true),
    maxSeconds: z.number().int().positive().max(14400),
  }),
  z.object({
    allowed: z.literal(false),
    reason: z.enum([
      '号码格式错误',
      '租户不存在',
      '租户已停用',
      '无费率',
      '余额不足',
    ]),
    sipCode: z.union([
      z.literal(400),
      z.literal(403),
      z.literal(404),
      z.literal(402),
    ]),
  }),
]);
export type AuthorizeResponse = z.infer<typeof authorizeResponseSchema>;

// mod_json_cdr 的秒数通常是字符串；拒绝空串、负数、小数及溢出。
const seconds = z
  .union([z.string().regex(/^[0-9]+$/), z.number()])
  .pipe(z.coerce.number<string | number>().int().min(0).max(2147483647));
const epoch = seconds;
const flag = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');
export const modJsonCdrSchema = z
  .object({
    variables: z.object({
      uuid: z.uuid().transform((value) => value.toLowerCase()),
      billing_tenant: z.string().default(''),
      start_epoch: epoch.refine((value) => value > 0),
      answer_epoch: epoch.default(0),
      end_epoch: epoch.refine((value) => value > 0),
      billsec: seconds,
      duration: seconds,
      billing_unverified: flag.default(false),
      caller_id_number: z.string().optional(),
      destination_number: z.string().optional(),
      hangup_cause: z.string().default(''),
    }),
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
    startedAt: new Date(v.start_epoch * 1000),
    answeredAt: v.answer_epoch === 0 ? null : new Date(v.answer_epoch * 1000),
    endedAt: new Date(v.end_epoch * 1000),
    billsec: v.billsec,
    duration: v.duration,
    unverified: v.billing_unverified,
    caller:
      v.caller_id_number ??
      callflow?.[0]?.caller_profile?.caller_id_number ??
      '',
    callee:
      v.destination_number ??
      callflow?.[0]?.caller_profile?.destination_number ??
      '',
    hangupCause: v.hangup_cause,
  }));
export type ParsedCdr = z.infer<typeof modJsonCdrSchema>;

export const chargeJobSchema = z.object({
  tenantId: z.uuid(),
  callUuid: z.uuid(),
});
export type ChargeJob = z.infer<typeof chargeJobSchema>;
export const cdrResponseSchema = z.object({
  status: z.enum(['queued', 'duplicate', 'unassigned', 'invalid']),
  rawId: z.uuid(),
});
