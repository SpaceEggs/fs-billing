import {
  apiContract,
  createAdminApiContract,
  adminRateRequestSchemas,
  adminAmountRequestSchemas,
} from '@fs-billing/shared';

export function createLiveApiContract(
  rateRequests = adminRateRequestSchemas,
  amountRequests = adminAmountRequestSchemas,
) {
  const { adminTenantOverview: deferredOverview, ...admin } =
    createAdminApiContract(rateRequests, amountRequests);
  void deferredOverview;
  return { ...apiContract, ...admin };
}
export const liveApiContract = createLiveApiContract();
export type LiveApiOperationId = keyof typeof liveApiContract;
