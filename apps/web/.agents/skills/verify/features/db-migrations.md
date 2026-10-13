# Database migrations

The operator applies pending SQL migrations, sets the application login password, and provisions current/next CDR months. Source: `packages/db/src/migrate.ts`, `bin/migrate.ts`, `migrations/0000_init.sql`, `migrations/meta/_journal.json`, and `src/migrate.db.test.ts`.

## Sub-features

- `migrate-apply` applies the checked-in migration through Drizzle's journal.
- `migrate-role` configures login for `fs_billing_app` from `APP_DATABASE_URL`.
- `migrate-repeat` repeats without another migration record and ensures current/next partitions.

## How to get to it (user POV)

- Configure the existing root `.env` as described in the skill. Use the local superuser owner for `DATABASE_URL`; connect to the running PostgreSQL before driving.

## Driving it with database commands

```sh
pnpm db:migrate
pnpm db:migrate
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM drizzle.__drizzle_migrations;'
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;'
pnpm test:db packages/db/src/migrate.db.test.ts
```

- Each CLI migration prints `迁移完成` and exits 0. With the current single migration, journal count stays 1.
- App connection reports `fs_billing_app`, false superuser, false BYPASSRLS. Acceptance also checks schema types/columns and RLS; partition acceptance is indexed separately.
- Save CLI output, independent journal/role reads, and test summary. Migration creates partitions using database now in Beijing months, rather than a fixed calendar date.

## Gotchas

- Missing/invalid URLs or an app URL with another username fail environment validation. Both URLs must use PostgreSQL protocol.
- The migration requires superuser privileges to revoke public advisory-function execution; its final check raises if revocation did not work. A generic non-superuser table owner is insufficient.
- Existing app role attributes are not reset by the conditional role creation. Inspect the role rather than assume an existing role is safe.
- Running `pnpm dev` does not migrate. App password and advisory-function privilege changes affect the whole cluster, including test runs.
