import { z } from 'zod';
import { adminIdentitySchema, customerIdentitySchema } from './identity.js';
import { moneySchema } from './money.js';

export const portalContextResponseSchema = z
  .strictObject({ identity: customerIdentitySchema, balance: moneySchema })
  .refine(
    (context) => context.identity.tenant.currency === context.balance.currency,
    {
      path: ['balance', 'currency'],
      message: '余额币种必须与租户币种一致',
    },
  );
export type PortalContextResponse = z.infer<typeof portalContextResponseSchema>;

export const adminContextResponseSchema = z.strictObject({
  identity: adminIdentitySchema,
});
export type AdminContextResponse = z.infer<typeof adminContextResponseSchema>;
