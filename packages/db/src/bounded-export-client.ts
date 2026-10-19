import type { EventEmitter } from 'node:events';
import { z } from 'zod';

interface ExportLeaseClient {
  query(...args: never[]): unknown;
  on: EventEmitter['on'];
  removeListener: EventEmitter['removeListener'];
  release(error?: Error | boolean): void;
  readonly connection: {
    readonly stream: {
      readonly destroyed: boolean;
      readonly closed?: boolean;
      destroy(error?: Error): unknown;
      once: EventEmitter['once'];
      removeListener: EventEmitter['removeListener'];
    };
  };
}

const CLEANUP_TIMEOUT_MS = 2_000;
// The control client bounds connect, query, and physical teardown separately.
const CONTROL_TIMEOUT_MS = 8_000;
const backendResult = z.object({
  rows: z.array(z.object({ pid: z.number().int().positive() })),
});

type Operation = {
  readonly kind: 'query' | 'rollback';
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Export was interrupted');
}

function statementKind(
  args: unknown[],
): 'begin' | 'commit' | 'rollback' | 'query' {
  const query: unknown = args[0];
  const text =
    typeof query === 'string'
      ? query
      : typeof query === 'object' && query !== null && 'text' in query
        ? query.text
        : undefined;
  const command =
    typeof text === 'string'
      ? /^\s*(begin|commit|rollback)\s*;?\s*$/i.exec(text)?.[1]?.toLowerCase()
      : undefined;
  if (command === 'begin' || command === 'commit' || command === 'rollback')
    return command;
  return 'query';
}

export async function withBoundedExportClient<
  Client extends ExportLeaseClient,
  Result,
>(
  input: {
    readonly pool: { connect(): Promise<Client> };
    readonly signal: AbortSignal;
    readonly cancelBackend: (backendPid: number) => Promise<boolean>;
  },
  use: (client: NoInfer<Client>) => Promise<Result>,
): Promise<Result> {
  const { signal } = input;
  if (signal.aborted) throw abortError(signal);
  const client = await input.pool.connect();
  const descriptor = Object.getOwnPropertyDescriptor(client, 'query');
  const originalQuery = client.query.bind(client);
  let active: Operation | undefined;
  let transactionOpen = false;
  let backendPid: number | undefined;
  let discardError: Error | undefined;
  let control: Promise<void> | undefined;
  let controlTimer: ReturnType<typeof setTimeout> | undefined;
  const stream = client.connection.stream;
  let streamClosed = stream.closed ?? stream.destroyed;
  const onTeardownError = () => undefined;
  const onStreamClose = () => {
    streamClosed = true;
    client.removeListener('error', onTeardownError);
  };

  const discard = (error: Error) => {
    if (!discardError) {
      discardError = error;
      if (!streamClosed) client.on('error', onTeardownError);
    }
    client.connection.stream.destroy();
    active?.reject(discardError);
  };
  const bound = (operation: Operation) => {
    operation.timer ??= setTimeout(() => {
      discard(new Error('Export database operation did not settle'));
    }, CLEANUP_TIMEOUT_MS);
  };
  const onAbort = () => {
    if (!active || active.kind === 'rollback') return;
    bound(active);
    if (backendPid === undefined) {
      discard(abortError(signal));
      return;
    }
    if (control) return;
    const pid = backendPid;
    control = new Promise<void>((resolve) => {
      controlTimer = setTimeout(() => {
        controlTimer = undefined;
        discard(new Error('Export cancellation did not settle'));
        resolve();
      }, CONTROL_TIMEOUT_MS);
      void Promise.resolve()
        .then(() => input.cancelBackend(pid))
        .then(
          (cancelled) => {
            if (!cancelled)
              discard(new Error('PostgreSQL did not cancel the export query'));
          },
          (error: unknown) => {
            discard(
              error instanceof Error
                ? error
                : new Error('Export cancellation failed'),
            );
          },
        )
        .finally(() => {
          if (controlTimer !== undefined) clearTimeout(controlTimer);
          controlTimer = undefined;
          resolve();
        });
    });
  };
  const onClientError = (error: Error) => discard(error);
  const onClientEnd = () => discard(new Error('Export connection ended'));

  const query = async (args: unknown[]): Promise<unknown> => {
    const kind = statementKind(args);
    const rollback = kind === 'rollback';
    if (rollback && control) await control;
    if (discardError) throw discardError;
    if (!rollback && signal.aborted) throw abortError(signal);
    if (active) throw new Error('Export queries must run sequentially');
    if (args.some((argument) => typeof argument === 'function'))
      throw new Error('Export queries must use promises');
    let rejectOperation: (error: Error) => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    void interrupted.catch(() => undefined);
    const operation: Operation = {
      kind: rollback ? 'rollback' : 'query',
      reject: rejectOperation,
      timer: undefined,
    };
    active = operation;
    if (rollback) bound(operation);
    try {
      const result: unknown = Reflect.apply(originalQuery, client, args);
      const value: unknown = await Promise.race([
        Promise.resolve(result),
        interrupted,
      ]);
      if (kind === 'begin') transactionOpen = true;
      else if (kind === 'commit' || rollback) transactionOpen = false;
      if (!rollback && signal.aborted) throw abortError(signal);
      return value;
    } catch (error) {
      if (rollback)
        discard(error instanceof Error ? error : new Error('Rollback failed'));
      throw signal.aborted && !rollback ? abortError(signal) : error;
    } finally {
      if (operation.timer !== undefined) clearTimeout(operation.timer);
      if (active === operation) active = undefined;
    }
  };

  stream.once('close', onStreamClose);
  client.on('error', onClientError);
  client.on('end', onClientEnd);
  signal.addEventListener('abort', onAbort, { once: true });
  Object.defineProperty(client, 'query', {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    value: new Proxy(originalQuery, {
      apply(_target, _receiver: unknown, args: unknown[]) {
        return query(args);
      },
    }),
  });
  try {
    if (signal.aborted) throw abortError(signal);
    const backend: unknown = await query(['SELECT pg_backend_pid() AS pid']);
    const [identified] = backendResult.parse(backend).rows;
    if (!identified) throw new Error('Could not identify export backend');
    backendPid = identified.pid;
    return await use(client);
  } catch (error) {
    throw signal.aborted ? abortError(signal) : error;
  } finally {
    if (active)
      discard(new Error('Export callback ended with an active query'));
    if (control) await control;
    if (!discardError && transactionOpen)
      await query(['ROLLBACK']).catch(() => undefined);
    signal.removeEventListener('abort', onAbort);
    if (active?.timer !== undefined) clearTimeout(active.timer);
    if (controlTimer !== undefined) clearTimeout(controlTimer);
    if (descriptor) Object.defineProperty(client, 'query', descriptor);
    else Reflect.deleteProperty(client, 'query');

    if (!discardError || streamClosed)
      stream.removeListener('close', onStreamClose);
    client.removeListener('error', onClientError);
    client.removeListener('end', onClientEnd);
    client.release(discardError);
  }
}
