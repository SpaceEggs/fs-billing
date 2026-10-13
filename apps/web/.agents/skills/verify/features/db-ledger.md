# Append-only ledger

Operators append accounting events; insert triggers add their signed amount to the tenant balance cache. Source: `packages/db/src/ledger.ts`, ledger/balance sections of `migrations/0000_init.sql`, and `src/ledger.db.test.ts`.

## Sub-features

- `ledger-append` records recharge, credit recharge, gift, adjustment, or call charge.
- `ledger-shape` enforces signs, actor/note requirements, and occurrence/write time rules.
- `ledger-immutable` rejects UPDATE, DELETE, and TRUNCATE, including ordinary owner operations.
- `ledger-balance` updates the cached balance once for each inserted event.

## How to get to it (user POV)

- Use `appendLedgerEntry` or `appendLedgerEntries` inside an operator transaction. SQL operators must acquire tenant locks first. There is no ledger HTTP route yet.

## Driving it with database commands

Read the skill's database preconditions, then run:

```sh
pnpm test:db packages/db/src/ledger.db.test.ts
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL app.scope = 'admin';
SELECT id AS tid FROM tenants WHERE code = 'ABC001' \gset
SELECT balance AS before_balance FROM tenant_balances WHERE tenant_id = :'tid' \gset
SELECT lock_tenants(ARRAY[:'tid']::uuid[]);
INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key, occurred_at)
VALUES (:'tid', 'call_charge', -0.18, 'verify:ledger:charge', '2026-09-30T23:59:59+08:00');
SELECT kind, amount, occurred_at, created_at FROM ledger_entries WHERE idempotency_key = 'verify:ledger:charge';
SELECT balance - :'before_balance'::numeric AS delta FROM tenant_balances WHERE tenant_id = :'tid';
SELECT * FROM balance_discrepancies WHERE tenant_id = :'tid';
ROLLBACK;
SQL
```

- Require one negative charge, historical occurrence time, current transaction write time, delta `-0.18`, and zero discrepancies. Rollback leaves the original rows/balance intact. On fresh seed ABC001 has 33 entries totaling `-35.20`.
- Acceptance requires app and owner mutation attempts to fail `42501`. Preserve SQL results and test summary.

## Gotchas

- Recharge/credit/gift require positive amount and admin reference. Adjustment requires nonzero amount, admin reference, and nonblank note. Call charge requires negative amount and no admin reference. Invalid shape gives `23514`.
- Manual events require `occurred_at = created_at`; call occurrence is supplied as answer time. App backdating `created_at` gives `42501`; the owner seed can write historical times.
- Missing tenant lock gives `55000`. App cannot update the balance cache directly. Multi-tenant writes must lock the full set before writes; see tenant locking.
- Separate CDR storage does not automatically append a charge. Correct an accounting mistake by appending an appropriate event rather than changing history.
