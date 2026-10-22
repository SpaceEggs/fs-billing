export type StatementErrorCode =
  | 'STATEMENT_DETAILS_DELETED'
  | 'STATEMENT_NOT_FINAL'
  | 'STATEMENT_VERSION_CONFLICT';

/** 重新生成的业务拒绝；API 层映射成 409。 */
export class StatementError extends Error {
  constructor(
    readonly code: StatementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StatementError';
  }
}
