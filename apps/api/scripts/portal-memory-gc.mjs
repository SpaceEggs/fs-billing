import process from 'node:process';
import { setImmediate } from 'node:timers';

if (
  process.env.PERF_GC_ON_SIGUSR2 !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  process.env.API_HOST !== '127.0.0.1' ||
  typeof globalThis.gc !== 'function'
)
  throw new Error(
    'Memory hook requires explicit opt-in, loopback test API and --expose-gc',
  );

let sequence = 0;
let pending = false;
process.on('SIGUSR2', () => {
  if (pending) return;
  pending = true;
  globalThis.gc();
  setImmediate(() => {
    globalThis.gc();
    setImmediate(() => {
      globalThis.gc();
      process.stdout.write(
        `${JSON.stringify({
          event: 'perf.memory.gc',
          sequence: ++sequence,
          pid: process.pid,
          ...process.memoryUsage(),
        })}\n`,
      );
      pending = false;
    });
  });
});
