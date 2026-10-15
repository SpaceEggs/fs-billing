import type { AdminApiErrorCode } from '@fs-billing/shared';

export class AdminServiceError extends Error {
  constructor(
    readonly code: AdminApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminServiceError';
  }
}
