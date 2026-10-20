import {
  apiContract,
  portalHomeApiContract,
  portalLedgerApiContract,
  portalLedgerExportApiContract,
  portalCdrApiContract,
  adminCdrApiContract,
  createAdminApiContract,
  adminRateRequestSchemas,
  adminAmountRequestSchemas,
} from '@fs-billing/shared';

export function createLiveApiContract(
  rateRequests = adminRateRequestSchemas,
  amountRequests = adminAmountRequestSchemas,
) {
  const admin = createAdminApiContract(rateRequests, amountRequests);
  return {
    ...apiContract,
    ...admin,
    ...adminCdrApiContract,
    ...portalHomeApiContract,
    ...portalCdrApiContract,
    ...portalLedgerApiContract,
    ...portalLedgerExportApiContract,
  };
}
export const liveApiContract = createLiveApiContract();
export type LiveApiOperationId = keyof typeof liveApiContract;
