# Worker partition maintenance

Startup and a daily Beijing-midnight job prepare current/next-month formal and raw CDR partitions in their own maintenance transaction. Sources: `apps/worker/src/maintenance.ts`, `packages/db/src/partitions.ts`, `client.ts`, and their DB tests.

## Sub-features

- `partitions-startup` creates missing current/next-month partitions before HTTP starts.
- `partitions-daily` persists `0 0 * * *` with `Asia/Shanghai` and permits repeated maintenance jobs.
- `partitions-failure` logs and stores `partition_failed`, then propagates the maintenance error.
- `partitions-repush` returns 503 for missing formal/raw partitions without write-path DDL, then accepts replay after maintenance.
- `partitions-types` rejects a transaction argument to `ensureCdrPartitions` at compile time.
- `partitions-savepoint` directly verifies the tenant-lock marker before/after savepoint rollback.

## How to get to it (user POV)

Worker starts maintenance automatically. Use `ensureCdrPartitions(db)` only with a pool-backed `PoolDb`, outside a write transaction. App-role writes use `withSystem` and take tenant locks before writing; maintenance must not hold tenant locks.

## Driving it with jobs and database commands

```sh
pnpm typecheck
pnpm test:db apps/worker/src/app.db.test.ts packages/db/src/cdrs.db.test.ts packages/db/src/tenant-lock.db.test.ts
```

Require startup to recreate both next-month partitions and the stored schedule to have Beijing timezone. A real queued maintenance job must complete. Denying maintenance execution must produce `partition_failed` alerts and rejected calls, not swallowed exceptions.

Missing formal/raw partition fixtures must return HTTP 503, create no formal CDR, registration or job, and emit `partition_failed`. Raw text remains when its receive-month partition exists. Restore maintenance and replay; require one CDR and one eventual charge. Save test output and exit codes.

Typecheck must consume the `@ts-expect-error` for passing Tx to maintenance. The savepoint test reads `app.tenant_locks`: empty before, tenant UUID while locked inside the savepoint, empty after rollback. It accepts only `TransactionRollbackError`; advisory-lock release alone cannot establish marker rollback.

## Gotchas

- Existing partitions return before acquiring the partition lock; creation of the same missing partition serializes. Do not generalize the fast path to all concurrent calls.
- The type boundary uses `PoolDb`'s `$client`; a transaction lacks that member. SQL still rejects maintenance while tenant locks are marked, even if partitions exist.
- Direct child partitions have no app grants. Inspect data through parents and app scope; owner reads are for independent evidence.
- `pnpm test:db` recreates its test database and changes cluster role/function privileges. Use the verification skill's database preconditions.
