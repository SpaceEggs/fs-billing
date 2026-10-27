import { runRestoreMonth } from '../src/raw-restore.js';

// pnpm --filter @fs-billing/worker raw:restore-month -- --month <YYYY-MM> [--dry-run]
process.exitCode = await runRestoreMonth(process.argv.slice(2), process.env, {
  stdout: process.stdout,
  stderr: process.stderr,
});
