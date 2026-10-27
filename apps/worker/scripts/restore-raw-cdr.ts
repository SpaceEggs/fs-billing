import { runRestoreSingle } from '../src/raw-restore.js';

// pnpm --filter @fs-billing/worker raw:restore -- --id <uuid> --received-at <时间> [--out <文件>]
process.exitCode = await runRestoreSingle(process.argv.slice(2), process.env, {
  stdout: process.stdout,
  stderr: process.stderr,
});
