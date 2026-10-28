import {
  AdminServiceError,
  CdrDeletionError,
  UnassignedError,
} from '@fs-billing/db';

/**
 * 阶段 8 的数据库函数抛 UnassignedError / CdrDeletionError（带 code，不依赖 API 的错误码表），
 * 这里映射成 AdminServiceError，由 app 的错误处理器按 adminApiErrorStatus 回 409 / 400。
 */
export async function mapBusinessErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UnassignedError || error instanceof CdrDeletionError)
      throw new AdminServiceError(error.code, error.message);
    throw error;
  }
}
