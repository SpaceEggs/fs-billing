import { z } from 'zod';
import { moneyAmountSchema } from '../money.js';

export const adminIdParamsSchema = z.strictObject({ id: z.uuid() });
export const adminTenantParamsSchema = z.strictObject({ tenantId: z.uuid() });
export const adminPageQuerySchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const adminPageInfoSchema = z.strictObject({
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
});
export const adminTimestampSchema = z.iso.datetime({ offset: true });
export const adminNonnegativeAmountSchema = moneyAmountSchema.refine(
  (value) => !value.startsWith('-'),
  { message: 'errors:validation.amount.negative' },
);
export const adminNonzeroAmountSchema = moneyAmountSchema.refine(
  (value) => /[1-9]/.test(value),
  { message: 'errors:validation.amount.zero' },
);
export const adminPositiveAmountSchema = adminNonnegativeAmountSchema.refine(
  (value) => /[1-9]/.test(value),
  { message: 'errors:validation.amount.positive' },
);
export const DEFAULT_ADMIN_AMOUNT_MAX_INTEGER_DIGITS = 10;
export const DEFAULT_ADMIN_TOPUP_DECIMAL_PLACES = 2;
export const DEFAULT_ADMIN_ADJUSTMENT_DECIMAL_PLACES = 4;
export const DEFAULT_ADMIN_SETTINGS_DECIMAL_PLACES = 2;

export function createAdminInputAmountSchemas(
  maxIntegerDigits = DEFAULT_ADMIN_AMOUNT_MAX_INTEGER_DIGITS,
) {
  const digits = z.number().int().min(1).max(128).parse(maxIntegerDigits);
  const bounded = (decimalPlaces: number) =>
    moneyAmountSchema.superRefine((value, context) => {
      const [integer = '', fraction = ''] = value.replace(/^-/, '').split('.');
      if (integer.length > digits || fraction.length > decimalPlaces)
        context.addIssue({
          code: 'custom',
          message: 'errors:validation.amount.precision',
          params: { digits, decimalPlaces },
        });
    });
  return {
    positive: bounded(DEFAULT_ADMIN_TOPUP_DECIMAL_PLACES).refine(
      (value) => !value.startsWith('-') && /[1-9]/.test(value),
      {
        message: 'errors:validation.amount.positive',
      },
    ),
    adjustment: bounded(DEFAULT_ADMIN_ADJUSTMENT_DECIMAL_PLACES).refine(
      (value) => /[1-9]/.test(value),
      { message: 'errors:validation.amount.zero' },
    ),
    settings: bounded(DEFAULT_ADMIN_SETTINGS_DECIMAL_PLACES).refine(
      (value) => !value.startsWith('-'),
      { message: 'errors:validation.amount.negative' },
    ),
  };
}
export const adminInputAmountSchemas = createAdminInputAmountSchemas();

export const adminStatusSchema = z.enum(['active', 'disabled']);
export const adminMutationResponseSchema = z.strictObject({
  auditId: z.uuid().nullable(),
});
export const adminAuditedMutationResponseSchema = z.strictObject({
  auditId: z.uuid(),
});

export type AdminIdParams = z.infer<typeof adminIdParamsSchema>;
export type AdminTenantParams = z.infer<typeof adminTenantParamsSchema>;
export type AdminPageQuery = z.infer<typeof adminPageQuerySchema>;
export type AdminPageInfo = z.infer<typeof adminPageInfoSchema>;
export type AdminTimestamp = z.infer<typeof adminTimestampSchema>;
export type AdminNonnegativeAmount = z.infer<
  typeof adminNonnegativeAmountSchema
>;
export type AdminNonzeroAmount = z.infer<typeof adminNonzeroAmountSchema>;
export type AdminPositiveAmount = z.infer<typeof adminPositiveAmountSchema>;
export type AdminStatus = z.infer<typeof adminStatusSchema>;
export type AdminMutationResponse = z.infer<typeof adminMutationResponseSchema>;
export type AdminAuditedMutationResponse = z.infer<
  typeof adminAuditedMutationResponseSchema
>;
