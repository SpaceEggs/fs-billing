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
export const adminStatusSchema = z.enum(['active', 'disabled']);
export const adminMutationResponseSchema = z.strictObject({
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
