export type CdrDeletionErrorCode =
  'CDR_MONTH_NOT_DELETABLE' | 'CDR_DELETE_COUNT_CHANGED' | 'VALIDATION_ERROR';

/** 删除话单的业务拒绝；API 层映射成 409 / 400。 */
export class CdrDeletionError extends Error {
  constructor(
    readonly code: CdrDeletionErrorCode,
    message: string,
    /** 触发拒绝的月份（YYYY-MM），请求级拒绝时为空。 */
    readonly month: string | null = null,
  ) {
    super(message);
    this.name = 'CdrDeletionError';
  }
}
