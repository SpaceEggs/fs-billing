import {
  apiContract,
  portalHomeApiContract,
  portalLedgerApiContract,
  portalLedgerExportApiContract,
  portalStatementApiContract,
  portalCdrApiContract,
  adminCdrApiContract,
  adminStatementApiContract,
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
    ...adminStatementApiContract,
    ...portalHomeApiContract,
    ...portalCdrApiContract,
    ...portalLedgerApiContract,
    ...portalLedgerExportApiContract,
    ...portalStatementApiContract,
  };
}
export const liveApiContract = createLiveApiContract();
export type LiveApiOperationId = keyof typeof liveApiContract;
