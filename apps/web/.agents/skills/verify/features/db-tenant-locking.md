# Tenant locking

Rate and ledger writers serialize per tenant using transaction-level locks acquired by `lock_tenants`; different tenant IDs use different lock keys. Source: `packages/db/src/client.ts`, `ledger.ts`, lock functions in `migrations/0000_init.sql`, `src/tenant-lock.db.test.ts`, and concurrency cases in `src/ledger.db.test.ts` and `src/rates.db.test.ts`.

## Sub-features

- `locks-tenant` makes a second same-tenant writer wait for the first transaction.
- `locks-batch` sorts/deduplicates a complete tenant set before writes.
- `locks-order` rejects dangerous acquisition order with `55000`.
- `locks-identity` checks both scope permission and transaction ownership of the lock.

## How to get to it (user POV)

- Call `lockTenants(tx, ids)` before writes or row locks. `appendLedgerEntries` canonicalizes UUIDs, sorts and locks the whole set once, and returns entries in that order.
- For a live operator wait, open two `psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1` sessions after loading the skill's database configuration.

## Driving it with database commands

```sh
pnpm test:db packages/db/src/tenant-lock.db.test.ts packages/db/src/ledger.db.test.ts packages/db/src/rates.db.test.ts
```

In session A:

```sql
BEGIN;
SET LOCAL app.scope = 'admin';
SELECT id AS tid FROM tenants WHERE code = 'ABC001' \gset
SELECT lock_tenants(ARRAY[:'tid']::uuid[]);
```

In session B:

```sql
BEGIN;
SET LOCAL app.scope = 'admin';
SET LOCAL lock_timeout = '1s';
SELECT id AS tid FROM tenants WHERE code = 'ABC001' \gset
SELECT lock_tenants(ARRAY[:'tid']::uuid[]);
```

- B times out with `55P03`; without the timeout it waits until A ends. Run `ROLLBACK` in B and then A. A different tenant can acquire its lock while A holds ABC001; use a fresh transaction in B and select GZT007 to drive that case.
- Require passing acceptance tests for same-tenant serialization, inverse batch input order, savepoint rollback, and rejected lock sequences. Save both session outputs and test summary.

## Gotchas

- Acquire all tenants in one call before writes/row locks. A new lower UUID after a higher one, a new lock after a write or row lock, or a strong table/unrelated advisory lock causes `55000`. Reusing an already held tenant is allowed.
- Tenant scope may lock only itself; missing scope or another tenant gives `42501`. NULL entries are ignored and duplicates removed.
- Lock ownership needs transaction-local markers and a real advisory lock. Commit and savepoint rollback release the corresponding locks/markers; pooled connection history or session locks do not substitute.
- App cannot directly execute advisory-lock functions. Partition maintenance while holding tenant locks gives `55000`, even if partitions already exist.
