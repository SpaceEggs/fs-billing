# Phase 6 PR 2 commands

All commands run from the isolated worktree. `.env` is ignored by Git. Connection values and temporary session secrets are not included in evidence.

```sh
pnpm install --frozen-lockfile --offline
pnpm check
pnpm test:db
pnpm test:idor
```

The performance command reads the local connection values, changes only the database pathname to `/fs_billing_perf`, and invokes the same script as the design prototype. The original `measure` command was not used because it drops and rebuilds candidate indexes.

```sh
PERF_DATABASE_URL='<local owner connection to fs_billing_perf>' \
PERF_APP_DATABASE_URL='<local fs_billing_app connection to fs_billing_perf>' \
PERF_AUTH_DATABASE_URL='<local fs_billing_auth connection to fs_billing_perf>' \
PERF_OUT="$PWD/docs/perf/portal-cdrs/pr2-ledger" PERF_ROUNDS=7 \
  pnpm --filter @fs-billing/db exec tsx scripts/portal-perf.ts ledger
```

`PERF_OUT` must be a fresh path to preserve earlier samples. The command measures two warmups and seven counted rounds per variant, then captures plans and real loopback HTTP requests. It throws on SQL errors, non-200 responses, invalid response schemas, empty results or insufficient month rows. All counted samples remain in `ledger.json`.

The browser run uses the separate `fs_billing_pr2_e2e` database, migrated and seeded from this worktree. Its launcher substitutes that pathname in the three local database URLs and supplies a temporary seed password without printing the URLs. It runs the existing real-API tests:

```sh
node --env-file=/Volumes/Dev/FS-Billing/.env /tmp/fsbilling-pr2-e2e.mjs \
  admin-balance.spec.ts admin-receivables.spec.ts
```
