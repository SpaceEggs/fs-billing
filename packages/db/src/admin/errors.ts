import type { AdminApiErrorCode, AdminCsvRowError } from '@fs-billing/shared';

export class AdminServiceError extends Error {
  constructor(
    readonly code: AdminApiErrorCode,
    message: string,
    readonly rows?: readonly AdminCsvRowError[],
  ) {
    super(message);
    this.name = 'AdminServiceError';
  }
}
