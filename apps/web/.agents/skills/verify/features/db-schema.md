# Database schema

Operators can inspect the migrated SQL schema and verify its constraints and correspondence with Drizzle. Handwritten `packages/db/migrations/0000_init.sql` is authoritative; `packages/db/src/schema.ts` describes queries/types. Acceptance source: `packages/db/src/migrate.db.test.ts`.

## Sub-features

- `schema-tables` provides 17 parent tables and the `receivables` and `balance_discrepancies` views.
- `schema-types` uses numeric amounts and timezone-aware timestamps.
- `schema-constraints` validates tenant identity and business event shapes in PostgreSQL.

## How to get to it (user POV)

- Read the skill's database-session preconditions. Migrate the configured local database or use the disposable acceptance database.

## Driving it with database commands

```sh
pnpm test:db packages/db/src/migrate.db.test.ts
```

- Require exit 0. Tests compare every Drizzle table's columns to the migrated database, require RLS on every public table including partitions, and reject float/real/money and timestamps without timezone in the schema.
- Inspect a migrated local database independently:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND data_type IN ('real', 'double precision', 'money', 'timestamp without time zone');
SELECT relname FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND NOT relrowsecurity;
SQL
```

- Both queries return zero rows. Save outputs and exit codes. Tenant codes are nonempty alphanumeric and unique; currency is CNY/USD, status active/disabled, overdraft nonnegative. Tenant ID/code/currency cannot be changed after creation.

## Gotchas

- Drizzle types alone do not prove SQL constraints or RLS. Use the migrated catalog and capability acceptance tests.
- Invalid SQL shapes produce constraint errors, commonly `23514`; duplicate keys produce `23505`, broken references `23503`.
- Tables for accounts, statements, logs and alerts do not imply implemented login, statement generation, or email delivery.
