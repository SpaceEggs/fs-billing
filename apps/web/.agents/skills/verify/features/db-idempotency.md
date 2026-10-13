# Idempotency

Callers can replay ledger operations without applying the same amount twice; PostgreSQL also prevents duplicate call UUIDs across partitions and tenants. Source: `packages/db/src/ledger.ts`, UUID/ledger constraints and triggers in `migrations/0000_init.sql`, `src/ledger.db.test.ts`, and `src/cdrs.db.test.ts`.

## Sub-features

- `idempotency-ledger` identifies a ledger event by tenant plus nonempty key.
- `idempotency-mismatch` rejects a replay whose kind or numeric amount differs.
- `idempotency-call` registers call UUIDs globally and permits one claim of an unassigned call.

## How to get to it (user POV)

- Use `appendLedgerEntry` inside an operator transaction. `callChargeKey(uuid)` generates `call:<uuid>`.
- Drive the checked-in replay/duplicate scenarios against real PostgreSQL, after the skill's database preconditions.

## Driving it with database commands

```sh
pnpm test:db packages/db/src/ledger.db.test.ts packages/db/src/cdrs.db.test.ts
```

- Require exit 0. Repeating a `-0.18` charge returns the same ledger ID, leaves one row, and changes the balance once to `-0.18` for its new test tenant.
- Reusing a key with another amount or kind throws `幂等键 … 已用于另一笔流水`. Concurrent same-tenant replays wait on the lock and read the committed existing row.
- Repeating a formal call UUID fails `23505`, constraint `call_uuids_pkey`, including another start time/month or tenant. An unassigned registration has NULL tenant and can be claimed once by a formal CDR; later claims fail.
- Save test summary and exit code; the suite independently reads stored row counts, IDs and balances.

## Gotchas

- Library replay compares only kind and numeric amount, not note, admin, or occurrence time. It returns the original row for matching kind/amount.
- Raw SQL duplicates without conflict handling fail `23505`. SQL `ON CONFLICT DO NOTHING` does not implement the library's mismatch check.
- CDR BEFORE INSERT UUID registration occurs before ordinary conflict handling; a CDR `ON CONFLICT` clause does not safely suppress registry duplicates. Seed checks registered UUIDs before inserting.
- These protections do not implement HTTP request idempotency or call ingestion retries; those routes do not exist yet.
