import { runMailRequeue } from '../src/mail-cli.js';

// pnpm --filter @fs-billing/worker mail:requeue -- --id <uuid>  或  --since <时间>
process.exitCode = await runMailRequeue(process.argv.slice(2), process.env, {
  stdout: process.stdout,
  stderr: process.stderr,
});
