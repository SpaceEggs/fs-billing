# Scoped database access

Backend callers declare transaction-local identity with `withTenant`, `withAdmin`, or `withSystem`; PostgreSQL RLS filters rows and restricts writes. Source: `packages/db/src/client.ts`, RLS policies in `migrations/0000_init.sql`, `src/rls.db.test.ts`, and `src/client.db.test.ts`.

## Sub-features

- `scope-empty` returns no business rows without identity.
- `scope-tenant` reads only the selected tenant and cannot write business data.
- `scope-operator` exposes all tenant business rows to admin/system subject to table grants and invariants.
- `scope-retry` retries outermost operator transactions on deadlock/serialization failure.

## How to get to it (user POV)

- Read the skill's database-session preconditions and verify that the SQL connection is the non-superuser, non-BYPASSRLS app role.
- Use actual wrapper acceptance for TypeScript behavior, and transaction-local SQL to inspect operator-visible results.

## Driving it with database commands

```sh
pnpm test:db packages/db/src/rls.db.test.ts packages/db/src/client.db.test.ts
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*) FROM tenants;
BEGIN;
SET LOCAL app.scope = 'admin';
SELECT id AS tid FROM tenants WHERE code = 'ABC001' \gset
SELECT code FROM tenants ORDER BY code;
ROLLBACK;
BEGIN;
SET LOCAL app.scope = 'tenant';
SELECT set_config('app.tenant_id', :'tid', true);
SELECT code FROM tenants;
SELECT callee, charge FROM cdrs ORDER BY started_at;
SELECT count(*) FROM admins;
SELECT count(*) FROM unassigned_cdrs;
ROLLBACK;
BEGIN;
SET LOCAL app.scope = 'system';
SELECT count(*) FROM admins;
SELECT count(*) FROM tenants;
ROLLBACK;
SELECT count(*) FROM tenants;
SQL
```

- On a fresh seed-only database, unscoped counts are 0; admin sees 10 tenants. Tenant sees only ABC001 and three calls: `447700900123/0.18`, `18765550100/0.25`, `8613800138000/0`. Tenant staff-only counts are 0. System sees 10 tenants and 0 admins. After rollback, unscoped count returns to 0.
- Acceptance requires tenant writes to fail: modifying its visible tenant row gives `42501`; deleting its CDRs affects zero rows. Cross-tenant locks and direct child-partition reads give `42501`.
- Wrapper tests require complete-transaction retries for `40P01`/`40001`, at most three attempts. Other errors do not retry. Save SQL results and passing test summary.

## Gotchas

- Scope variables assume trusted backend code. They do not authenticate SQL callers; a caller with arbitrary app SQL can select operator scope.
- `admins` and `operation_logs` are admin-only. System scope is not universal access. `raw_cdrs`, `unassigned_cdrs`, `system_alerts`, and UUID registration are operator-only; app grants further restrict direct registry access.
- Nested operator wrappers use savepoints without independent retries; callbacks must contain rerunnable database operations. `psql` scope changes do not implement wrapper retries.
- Owner/superuser queries bypass RLS and cannot prove tenant isolation.
