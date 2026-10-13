# CDR partitions

Operators provision Beijing calendar-month partitions for formal and raw CDR storage. Source: `packages/db/src/partitions.ts`, `migrate.ts`, `seed.ts`, partition functions in `migrations/0000_init.sql`, `src/cdrs.db.test.ts`, and `src/tenant-lock.db.test.ts`.

## Sub-features

- `partitions-ensure` creates requested current/future months idempotently.
- `partitions-boundary` routes formal calls by start time and raw calls by receipt time.
- `partitions-isolation` separates maintenance from tenant-locked writes.

## How to get to it (user POV)

- `pnpm db:migrate` calls `ensureCdrPartitions` for the database's current and next months. The exported wrapper starts a separate system transaction; default `monthsAhead = 1` includes the moment's month and the following month.
- SQL operators can call `cdr_ensure_partitions` as admin/system in a separate transaction. The SQL below persists four example partitions.

## Driving it with database commands

Read the skill's database preconditions, then run:

```sh
pnpm test:db packages/db/src/cdrs.db.test.ts packages/db/src/tenant-lock.db.test.ts
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL app.scope = 'system';
SELECT cdr_ensure_partitions('2027-01-15T12:00:00+08:00');
COMMIT;
BEGIN;
SET LOCAL app.scope = 'system';
SELECT cdr_ensure_partitions('2027-01-15T12:00:00+08:00');
COMMIT;
SQL
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT relname, pg_get_expr(relpartbound, oid) FROM pg_class WHERE relname IN ('cdrs_2027_01', 'cdrs_2027_02') ORDER BY relname;"
```

- Both calls return `cdrs_2027_01`, `cdrs_2027_02`, `raw_cdrs_2027_01`, `raw_cdrs_2027_02`. February bounds are `[2027-01-31 16:00:00+00, 2027-02-28 16:00:00+00)` when rendered in UTC.
- Acceptance inserts January's last Beijing second and February's first second and independently checks their table partitions. Missing-month insertion fails `23514`; no fallback partition exists.
- Save function results, catalog bounds, and test summary; record the persisted partitions.

## Gotchas

- Tenant/unscoped maintenance fails `42501`; held tenant locks fail `55000`, including the already-existing-partition path.
- Existing partitions return without waiting on the partition lock. Missing partitions need a name-specific advisory lock and parent-table DDL locks, so long reads can delay creation.
- Child partitions enable RLS but receive no app grants; query parents, not children, as the app role.
- Worker performs startup maintenance and daily pg-boss scheduling at Beijing midnight; see [Worker interfaces](worker-api.md). Missing partitions are not created on the CDR write path.
