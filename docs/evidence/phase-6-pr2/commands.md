# Phase 6 PR 2 commands

All commands run from the isolated worktree. `.env` is ignored by Git. Connection values and temporary session secrets are not included in evidence.

```sh
pnpm install --frozen-lockfile --offline
pnpm check
pnpm test:db
pnpm test:idor
```

## Recorded performance runs

Both historical invocations read the local connection values from `.env`, changed only the database pathname to `/fs_billing_perf`, and invoked `packages/db/scripts/portal-perf.ts ledger`. The original `measure` command was not used because it drops and rebuilds candidate indexes. The effective arguments were the following; the connection placeholders stand for the local owner, application and authentication role URLs.

| Run              | Query shape                                                       | Recorded output directory                    | stdout                                                   |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| First formal run | Group by manual ID, kind and Beijing day                          | `docs/perf/portal-cdrs/pr2-ledger`           | [perf-command.txt](perf-command.txt)                     |
| Final formal run | Group by Beijing day and manual ID, retaining ordered `array_agg` | `docs/perf/portal-cdrs/pr2-ledger-day-first` | [perf-command-day-first.txt](perf-command-day-first.txt) |

The first historical invocation used these arguments. Its existing evidence directory is retained and must not be reused for a rerun.

```sh
PERF_DATABASE_URL='<local owner connection to fs_billing_perf>' \
PERF_APP_DATABASE_URL='<local fs_billing_app connection to fs_billing_perf>' \
PERF_AUTH_DATABASE_URL='<local fs_billing_auth connection to fs_billing_perf>' \
PERF_OUT="$PWD/docs/perf/portal-cdrs/pr2-ledger" PERF_ROUNDS=7 \
  pnpm --filter @fs-billing/db exec tsx scripts/portal-perf.ts ledger
```

The final historical invocation used the same connection values and round count with this different output directory. It also remains retained.

```sh
PERF_DATABASE_URL='<local owner connection to fs_billing_perf>' \
PERF_APP_DATABASE_URL='<local fs_billing_app connection to fs_billing_perf>' \
PERF_AUTH_DATABASE_URL='<local fs_billing_auth connection to fs_billing_perf>' \
PERF_OUT="$PWD/docs/perf/portal-cdrs/pr2-ledger-day-first" PERF_ROUNDS=7 \
  pnpm --filter @fs-billing/db exec tsx scripts/portal-perf.ts ledger
```

## Rerun without overwriting evidence

Set the three performance connection variables to local role URLs for `fs_billing_perf`, then use a fresh, unique directory. The `ledger` subcommand calls `mkdir` without recursive creation for `PERF_OUT` and rejects an existing directory before writing samples or plans. Neither historical directory above is a rerun target. Shell no-clobber also protects the stdout file.

```sh
set -o noclobber
capture_path="$PWD/docs/perf/portal-cdrs/pr2-ledger-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"
PERF_OUT="$capture_path" PERF_ROUNDS=7 \
  pnpm --filter @fs-billing/db exec tsx scripts/portal-perf.ts ledger \
  > "${capture_path}.stdout.txt" 2>&1
```

The command measures two warmups and seven counted rounds per variant, then captures plans and real loopback HTTP requests. It throws on SQL errors, non-200 responses, invalid response schemas, empty results or insufficient month rows. All counted samples remain in `ledger.json`.

## Browser verification

The browser run used the separate `fs_billing_pr2_e2e` database, migrated and seeded from this worktree. Its launcher substituted that pathname in the three local database URLs and supplied a temporary seed password without printing the URLs. It ran the existing real-API tests:

```sh
node --env-file=/Volumes/Dev/FS-Billing/.env /tmp/fsbilling-pr2-e2e.mjs \
  admin-balance.spec.ts admin-receivables.spec.ts
```

The launcher and database were temporary run inputs. The database was removed after the run; a new browser run requires a freshly migrated and seeded isolated database.
