# FS-Billing verification map

Read this index before a run. This map covers implemented phase 0, 1, and 2 behavior plus phase 3 units a–e. Worker authorization and CDR ingestion now have HTTP paths; business UI remains unimplemented.

## Baseline preconditions

- Web/HTTP: start the owned launcher at ports 3000, 3001, and 5173; require Doctor before the connected baseline and use a fresh browser tab.
- Rating: installed dependencies; use root `pnpm test` with the literal file filters below. No database or server is needed.
- Database: PostgreSQL, configured `.env`, and a successful role/connection check. Read the skill's Package and database sessions section first: `pnpm test:db` recreates `fs_billing_test` and changes cluster role/function privileges; migrate/seed target `DATABASE_URL`.
- Use a fresh evidence directory for every session. SQL examples assume `.env` has been exported as shown in the skill.

## Proof and skip reporting

- Save each action and its observable result under the run directory.
- Capture browser snapshots and screenshots for Web states.
- Capture status and exact response JSON for HTTP paths.
- Report skipped sub-feature IDs. Do not treat one entry point as proof of another.
- Stop only processes started by this run. Keep evidence and record persistent database effects after teardown.

## Features

### Phase 0: Web and HTTP

- [Web service status](web-status.md) covers the connected state, unavailable state, and reopening after recovery.
- [API health](api-health.md) covers direct API access and access through the Web proxy.
- [Worker health](worker-health.md) covers direct access and independence from the API process.

### Phase 1: rating

- [Call authorization](call-authorization.md): balance/overdraft decision, rejection reasons, duration cap.
- [Rate CSV](rate-csv.md): import validation, line errors, export format.
- [Rate selection](rate-selection.md): effective snapshot and longest prefix.
- [Number and amount validation](number-format-validation.md): dialed syntax, decimal/rate validation, display rounding and currency checks.
- [Call pricing](call-pricing.md): billing cycles and precise charges.
- [Beijing time attribution](beijing-time-attribution.md): local-time parsing and answer day/month.

### Phase 2: database and operator operations

- [Database schema](db-schema.md): SQL constraints, types, Drizzle column correspondence.
- [Database migrations](db-migrations.md): owner CLI, migration journal, app role setup.
- [Scoped database access](db-scoped-access.md): RLS, `withTenant`, `withAdmin`, `withSystem`, retries.
- [Append-only ledger](db-ledger.md): accounting event shapes, trigger-maintained balances.
- [Tenant locking](db-tenant-locking.md): per-tenant serialization, batch order and rejected lock sequences.
- [CDR partitions](db-partitions.md): Beijing monthly boundaries, `ensureCdrPartitions`, maintenance separation.
- [Balance rebuild](db-balance-rebuild.md): discrepancy detection and standalone owner procedure.
- [Idempotency](db-idempotency.md): ledger retry identity and global call UUID deduplication.
- [Seed data](db-seed.md): repeatable sample data and expected balances.
- [Stored rate versions](db-rate-versions.md): immutable history, future version management, rating reads.
- [CDR storage](db-cdr-storage.md): answered/unanswered constraints, raw text and unassigned calls.
- [Receivable settlement](db-receivable-settlement.md): credit recharge confirmation as an independent event.

### Phase 3: Worker interfaces

- [Worker authorization and CDR ingestion](worker-api.md): HTTP contracts, raw preservation, UUID deduplication, unassigned handling, transactional charging, crash recovery, endpoint security and daily partition maintenance.

**Stale claim (phase 0):** PostgreSQL was only a supporting check and business features had no real paths. Database operations and rating acceptance commands now have paths above. The three phase 0 endpoints still perform no business writes. Monetary lint and build remain supporting checks in the root README.
