import {
  AdminServiceError,
  AlertSettingsInvalidError,
  AlertSettingsVersionConflictError,
  CdrDeletionError,
  UnassignedError,
} from '@fs-billing/db';

/**
 * 阶段 8 的数据库函数抛 UnassignedError / CdrDeletionError（阶段 9 加告警设置的两个错误）（带 code，不依赖 API 的错误码表），
 * 这里映射成 AdminServiceError，由 app 的错误处理器按 adminApiErrorStatus 回 409 / 400。
 */
export async function mapBusinessErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UnassignedError || error instanceof CdrDeletionError)
      throw new AdminServiceError(error.code, error.message);
    // 阶段 9：告警设置的乐观并发（版本不符 → 409）与库函数自己的输入底线（zod 已拦在前面，这里是兜底的 400）。
    if (error instanceof AlertSettingsVersionConflictError)
      throw new AdminServiceError(error.code, error.message);
    if (error instanceof AlertSettingsInvalidError)
      throw new AdminServiceError('VALIDATION_ERROR', error.message);
    throw error;
  }
}
