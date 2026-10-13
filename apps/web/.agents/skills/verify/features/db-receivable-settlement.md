# Receivable settlement

An operator confirms collection of a credit recharge by appending a settlement event. The `receivables` view changes from pending to received without modifying the original ledger or charging the balance again. Source: settlement table/view in `packages/db/migrations/0000_init.sql`, `src/schema.ts`, and settlement cases in `src/ledger.db.test.ts`.

## Sub-features

- `receivable-pending` exposes credit recharge ledger rows as pending.
- `receivable-confirm` records received date, confirming admin and optional note.
- `receivable-once` permits only one settlement per credit recharge.

## How to get to it (user POV)

- Use admin-scoped app SQL after the skill's database preconditions, or drive acceptance. There is no collection-confirmation UI/HTTP route yet.

## Driving it with database commands

```sh
pnpm test:db packages/db/src/ledger.db.test.ts
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL app.scope = 'admin';
SELECT id AS tid FROM tenants WHERE code = 'ABC001' \gset
SELECT id AS aid FROM admins WHERE email = 'wangmin@example.com' \gset
SELECT ledger_entry_id AS eid FROM receivables WHERE tenant_id = :'tid' AND status = 'pending' ORDER BY created_at LIMIT 1 \gset
SELECT balance AS before_balance FROM tenant_balances WHERE tenant_id = :'tid' \gset
INSERT INTO receivable_settlements (tenant_id, ledger_entry_id, received_on, confirmed_by, note)
VALUES (:'tid', :'eid', '2026-10-05', :'aid', 'verify collection');
SELECT amount, status, received_on FROM receivables WHERE ledger_entry_id = :'eid';
SELECT balance - :'before_balance'::numeric AS delta FROM tenant_balances WHERE tenant_id = :'tid';
SELECT kind, amount FROM ledger_entries WHERE id = :'eid';
ROLLBACK;
SQL
```

- On fresh seed, ABC001's pending amount is `500` (numeric output omits trailing zeros). The view becomes received on `2026-10-05`, delta is 0, and the original row remains credit recharge for 500. Rollback leaves it pending.
- Require passing acceptance for independent settlement, duplicate rejection (`23505`), and rejection of settling an ordinary recharge (`23503`). Save SQL and test outputs.

## Gotchas

- This manual recipe requires an unsettled seed credit recharge; if none remains, record that prerequisite and use the isolated acceptance scenario.
- Settlement is append-only, with app SELECT/INSERT privileges and owner mutation-rejection triggers. It must reference the same tenant and a `credit_recharge` event plus a valid confirming admin.
- Settlement does not add funds again. Tenant scope can read its receivables but cannot confirm collection; scope does not implement authentication.
