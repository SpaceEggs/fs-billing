# Stored rate versions

Operators create whole-table tenant rate snapshots and manage future snapshots while preserving effective history. `loadRatingTenant` reads status, currency, balance, overdraft and versions for rating. Source: `packages/db/src/rates.ts`, version/entry guards in `migrations/0000_init.sql`, and `src/rates.db.test.ts`.

## Sub-features

- `db-rates-create` locks the tenant and creates a snapshot, using database now when no effective time is supplied.
- `db-rates-history` preserves effective versions and entries.
- `db-rates-future` permits deleting a future version or replacing its entries by delete/insert under the tenant lock.
- `db-rates-read` feeds stored versions into the rating selector.

## How to get to it (user POV)

- Drive real acceptance from the repository root; backend callers use `createRateVersion` and `loadRatingTenant` in scoped transactions. No rate-management UI/HTTP route exists yet.

## Driving it with database commands

Read the skill's database preconditions, then run:

```sh
pnpm test:db packages/db/src/rates.db.test.ts
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL app.scope = 'admin';
SELECT t.code, v.effective_from, e.prefix, e.rate
FROM tenants t JOIN rate_versions v ON v.tenant_id = t.id
JOIN rate_entries e ON e.rate_version_id = v.id
WHERE t.code = 'ABC001' AND e.prefix = '447' ORDER BY v.effective_from;
ROLLBACK;
SQL
```

- Seed rows show Beijing September 1 `0.0450` and October 1 `0.0480` (numeric output may omit trailing zeros). Acceptance loads ABC001 and selects the correct rates on either side of the boundary.
- Require tests for immediate first-version authorization after commit, concurrent same-tenant version writes, duplicate effective times (`23505`), history mutation rejection (`42501`), and excessive scale rejection (`23514`). Save SQL results and summary.

## Gotchas

- Lock tenant IDs before writes; missing locks give `55000`. Multi-tenant transactions must lock the complete set first.
- Effective time cannot precede the tenant's latest version; an already scheduled future version blocks an immediate version (`23514`). Equal time is rejected by uniqueness.
- Version/entry UPDATE is forbidden. Effective versions cannot be deleted and effective entries cannot be added/deleted, except entries of a version newly created in the same transaction. Owner operations encounter the same guards.
- Guards use wall-clock time: a transaction that began before activation cannot keep editing after activation. Future entries may be deleted/reinserted, not updated.
- Server-clock effective times can accidentally schedule the initial rate in the future. Omit the time to use database now. Empty snapshots are possible and produce no matching rate.
