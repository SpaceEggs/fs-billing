import { z } from 'zod';
import type { AdminIdentity, CustomerIdentity } from '@fs-billing/shared';
import type { AuthSession } from './auth/gateway.js';

export const authUserIdSchema = z.string().min(1).brand<'AuthUserId'>();
const profileIdSchema = z.uuid().brand<'ProfileId'>();
const tenantIdSchema = z.uuid().brand<'TenantId'>();
export type AuthUserId = z.infer<typeof authUserIdSchema>;
export const principalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('admin'),
    authUserId: authUserIdSchema,
    profileId: profileIdSchema,
  }),
  z.object({
    kind: z.literal('customer'),
    authUserId: authUserIdSchema,
    profileId: profileIdSchema,
    tenantId: tenantIdSchema,
  }),
]);
export type Principal = z.infer<typeof principalSchema>;
export type CustomerPrincipal = Extract<Principal, { kind: 'customer' }>;
export type AdminPrincipal = Extract<Principal, { kind: 'admin' }>;
export type ResolvedIdentity =
  | { kind: 'admin'; principal: AdminPrincipal; identity: AdminIdentity }
  | {
      kind: 'customer';
      principal: CustomerPrincipal;
      identity: CustomerIdentity;
    };
export type RequestContext =
  | { kind: 'public' }
  | { kind: 'session'; session: AuthSession }
  | (ResolvedIdentity & { session: AuthSession });
