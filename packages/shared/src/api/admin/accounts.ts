import { z } from 'zod';

import { newPasswordSchema } from '../auth.js';
import {
  adminAuditedMutationResponseSchema,
  adminPageInfoSchema,
  adminPageQuerySchema,
  adminStatusSchema,
  adminTimestampSchema,
} from './common.js';

export const DEFAULT_ADMIN_TEMPORARY_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;

export const adminAccountSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  email: z.email(),
  status: adminStatusSchema,
  lastLoginAt: adminTimestampSchema.nullable(),
  createdAt: adminTimestampSchema,
});
export const adminAccountsQuerySchema = adminPageQuerySchema.extend({
  search: z.string().max(200).optional(),
  status: adminStatusSchema.optional(),
});
export const adminAccountsResponseSchema = z.strictObject({
  items: z.array(adminAccountSchema),
  pagination: adminPageInfoSchema,
});
export const adminAccountCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.email(),
});
export const adminAccountCreateResponseSchema =
  adminAuditedMutationResponseSchema.extend({
    account: adminAccountSchema,
    temporaryPassword: newPasswordSchema,
  });
export const adminPortalAccountSchema = adminAccountSchema.omit({ name: true });
export const adminPortalAccountsResponseSchema = z.strictObject({
  items: z.array(adminPortalAccountSchema).max(1),
});
export const adminPortalAccountCreateRequestSchema = z.strictObject({
  email: z.email(),
  initialPassword: newPasswordSchema.optional(),
});
export const adminPortalAccountCreateResponseSchema = z.discriminatedUnion(
  'passwordSource',
  [
    adminAuditedMutationResponseSchema.extend({
      account: adminPortalAccountSchema,
      passwordSource: z.literal('generated'),
      temporaryPassword: newPasswordSchema,
    }),
    adminAuditedMutationResponseSchema.extend({
      account: adminPortalAccountSchema,
      passwordSource: z.literal('supplied'),
    }),
  ],
);

export type AdminAccount = z.infer<typeof adminAccountSchema>;
export type AdminAccountsQuery = z.infer<typeof adminAccountsQuerySchema>;
export type AdminAccountsResponse = z.infer<typeof adminAccountsResponseSchema>;
export type AdminAccountCreateRequest = z.infer<
  typeof adminAccountCreateRequestSchema
>;
export type AdminAccountCreateResponse = z.infer<
  typeof adminAccountCreateResponseSchema
>;
export type AdminPortalAccount = z.infer<typeof adminPortalAccountSchema>;
export type AdminPortalAccountsResponse = z.infer<
  typeof adminPortalAccountsResponseSchema
>;
export type AdminPortalAccountCreateRequest = z.infer<
  typeof adminPortalAccountCreateRequestSchema
>;
export type AdminPortalAccountCreateResponse = z.infer<
  typeof adminPortalAccountCreateResponseSchema
>;
