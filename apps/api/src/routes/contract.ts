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
  const admin = createAdminApiContract(rateRequests, amountRequests);
  return { ...apiContract, ...admin };
}
export const liveApiContract = createLiveApiContract();
export type LiveApiOperationId = keyof typeof liveApiContract;
