import { createAdminInputAmountSchemas } from './common.js';
import { createAdminBalanceOperationRequestSchema } from './balance.js';
import {
  createAdminTenantCreateRequestSchema,
  createAdminTenantSettingsRequestSchema,
} from './tenants.js';

export function createAdminAmountRequestSchemas(maxIntegerDigits?: number) {
  const amounts = createAdminInputAmountSchemas(maxIntegerDigits);
  return {
    balance: createAdminBalanceOperationRequestSchema(amounts),
    settings: createAdminTenantSettingsRequestSchema(amounts),
    tenantCreate: createAdminTenantCreateRequestSchema(amounts),
  };
}
export const adminAmountRequestSchemas = createAdminAmountRequestSchemas();
export type AdminAmountRequestSchemas = ReturnType<
  typeof createAdminAmountRequestSchemas
>;
