/** A PostgreSQL transport failure, with the driver's original error preserved. */
export class DatabaseUnavailableError extends Error {
  constructor(cause: Error) {
    super('Database unavailable', { cause });
    this.name = 'DatabaseUnavailableError';
  }
}

const transportCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);
const transportMessages = new Set([
  'Connection terminated unexpectedly',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'timeout expired',
  'Client was closed and is not queryable',
  'Client has encountered a connection error and is not queryable',
]);

function normalize(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof DatabaseUnavailableError)
    return error;
  if (
    transportMessages.has(error.message) ||
    ('code' in error &&
      typeof error.code === 'string' &&
      transportCodes.has(error.code))
  )
    return new DatabaseUnavailableError(error);
  return error;
}

// Preserve pg's overloaded signatures and both its callback and Promise APIs.
export function normalizePgOperation<T extends (...args: never[]) => unknown>(
  operation: T,
): T {
  return new Proxy(operation, {
    apply(target, receiver: unknown, args: unknown[]) {
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        args[args.length - 1] = new Proxy(callback, {
          apply(callbackTarget, callbackReceiver: unknown, values: unknown[]) {
            values[0] = normalize(values[0]);
            const result: unknown = Reflect.apply(
              callbackTarget,
              callbackReceiver,
              values,
            );
            return result;
          },
        });
      }
      const result: unknown = Reflect.apply(target, receiver, args);
      return result instanceof Promise
        ? result.catch((error: unknown) => {
            throw normalize(error);
          })
        : result;
    },
  });
}
