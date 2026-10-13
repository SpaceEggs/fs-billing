# Balance rebuild

The operator detects cache/ledger differences and repairs balances through a standalone procedure. Source: `tenant_balances`, `balance_discrepancies`, and `rebuild_tenant_balances` in `packages/db/migrations/0000_init.sql`; acceptance cases in `packages/db/src/ledger.db.test.ts`.

## Sub-features

- `balance-audit` lists only balances differing from the ledger sum.
- `balance-rebuild` repairs one tenant at a time and returns the changed-tenant count.
- `balance-concurrent` reconciles safely with in-flight charges and new tenants.

## How to get to it (user POV)

- Use the owner URL after the skill's database connection check. App scope can read allowed discrepancies but cannot update the cache or execute the procedure.
- The procedure commits each tenant separately. Invoke it in autocommit, without `BEGIN`, `psql -1`, or multiple statements in its `-c` string.

## Driving it with database commands

```sh
pnpm test:db packages/db/src/ledger.db.test.ts
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'SELECT * FROM balance_discrepancies;'
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'CALL rebuild_tenant_balances(NULL);'
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'SELECT * FROM balance_discrepancies;'
```

- A healthy seed database has no discrepancies before/after and returns `fixed = 0`. If differences exist, `fixed` counts changed cache rows, not scanned tenants.
- Acceptance intentionally corrupts a test cache to 999, observes a discrepancy, restores the ledger sum 20 with `fixed = 1`, and checks concurrent/uncommitted charges and newly opened tenants. Do not corrupt the developer database to reproduce it.
- Save the independent reads, procedure result and test summary. Procedure repairs are persistent.

## Gotchas

- Explicit transaction invocation raises `2D000` on the first per-tenant commit. An empty cache returns 0 without a commit. App invocation/direct cache modification gives `42501`.
- The procedure locks one balance row at a time, sums after obtaining it, and commits before the next. It does not take tenant advisory locks or hold all tenant row locks together.
- It reselects remaining rows after each commit, so newly committed accounts can be included. An account committed after the final lookup is outside that run.
- A rebuild cannot be rolled back as one unit after earlier tenant commits; preserve evidence of partial progress if it fails.
