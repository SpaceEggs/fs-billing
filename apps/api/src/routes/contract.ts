import { apiContract, adminApiContract } from '@fs-billing/shared';

export const liveApiContract = {
  ...apiContract,
  adminTenants: adminApiContract.adminTenants,
  adminTenantCreate: adminApiContract.adminTenantCreate,
  adminTenantDetail: adminApiContract.adminTenantDetail,
  adminTenantEdit: adminApiContract.adminTenantEdit,
  adminTenantDisable: adminApiContract.adminTenantDisable,
  adminTenantEnable: adminApiContract.adminTenantEnable,
  adminTenantSettings: adminApiContract.adminTenantSettings,
  adminTenantLedger: adminApiContract.adminTenantLedger,
  adminBalanceOperation: adminApiContract.adminBalanceOperation,
};
export type LiveApiOperationId = keyof typeof liveApiContract;
