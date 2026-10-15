import {
  apiContract,
  createAdminApiContract,
  adminRateRequestSchemas,
} from '@fs-billing/shared';

export function createLiveApiContract(rateRequests = adminRateRequestSchemas) {
  const { adminTenantOverview: deferredOverview, ...admin } =
    createAdminApiContract(rateRequests);
  void deferredOverview;
  return { ...apiContract, ...admin };
}
export const liveApiContract = createLiveApiContract();
export type LiveApiOperationId = keyof typeof liveApiContract;
