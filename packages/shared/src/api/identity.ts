import { z } from 'zod';

export const currencySchema = z.enum(['CNY', 'USD']);
export type Currency = z.infer<typeof currencySchema>;

export const tenantIdentitySchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
  currency: currencySchema,
});
export type TenantIdentity = z.infer<typeof tenantIdentitySchema>;

export const adminIdentitySchema = z.strictObject({
  kind: z.literal('admin'),
  profileId: z.uuid(),
  name: z.string().min(1),
  email: z.email(),
});
export type AdminIdentity = z.infer<typeof adminIdentitySchema>;

export const customerIdentitySchema = z.strictObject({
  kind: z.literal('customer'),
  profileId: z.uuid(),
  email: z.email(),
  tenant: tenantIdentitySchema,
});
export type CustomerIdentity = z.infer<typeof customerIdentitySchema>;

export const identitySchema = z.discriminatedUnion('kind', [
  adminIdentitySchema,
  customerIdentitySchema,
]);
export type Identity = z.infer<typeof identitySchema>;
