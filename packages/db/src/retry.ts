const RETRYABLE = new Set(['40P01', '40001']);

interface RetryOptions<T> {
  operation: () => Promise<T>;
  attempts: number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function retryTransaction<T>({
  operation,
  attempts,
  random = Math.random,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: RetryOptions<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(sqlState(error) ?? '')) {
        throw error;
      }
      await sleep(random() * Math.min(10 * 2 ** (attempt - 1), 200));
    }
  }
}

/** drizzle 把驱动错误包在 cause 里。 */
function sqlState(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
  }
  return undefined;
}
