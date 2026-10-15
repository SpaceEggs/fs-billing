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
  { message: '金额不能为负' },
);
export const adminNonzeroAmountSchema = moneyAmountSchema.refine(
  (value) => /[1-9]/.test(value),
  { message: '金额不能为零' },
);
export const adminPositiveAmountSchema = adminNonnegativeAmountSchema.refine(
  (value) => /[1-9]/.test(value),
  { message: '金额必须大于零' },
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
    moneyAmountSchema.refine(
      (value) => {
        const [integer = '', fraction = ''] = value
          .replace(/^-/, '')
          .split('.');
        return integer.length <= digits && fraction.length <= decimalPlaces;
      },
      { message: `金额最多 ${digits} 位整数，且最多 ${decimalPlaces} 位小数` },
    );
  return {
    positive: bounded(DEFAULT_ADMIN_TOPUP_DECIMAL_PLACES).refine(
      (value) => !value.startsWith('-') && /[1-9]/.test(value),
      {
        message: '金额必须大于零',
      },
    ),
    adjustment: bounded(DEFAULT_ADMIN_ADJUSTMENT_DECIMAL_PLACES).refine(
      (value) => /[1-9]/.test(value),
      { message: '金额不能为零' },
    ),
    settings: bounded(DEFAULT_ADMIN_SETTINGS_DECIMAL_PLACES).refine(
      (value) => !value.startsWith('-'),
      { message: '金额不能为负' },
    ),
  };
}
export const adminInputAmountSchemas = createAdminInputAmountSchemas();

export const adminStatusSchema = z.enum(['active', 'disabled']);
export const adminMutationResponseSchema = z.strictObject({
  auditId: z.uuid().nullable(),
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
