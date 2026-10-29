import { runMailTest } from '../src/mail-cli.js';

// pnpm --filter @fs-billing/worker mail:test -- --to <地址>[,<地址>…]
process.exitCode = await runMailTest(process.argv.slice(2), process.env, {
  stdout: process.stdout,
  stderr: process.stderr,
});
