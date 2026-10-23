# Seed data

The operator installs additive, repeatable development examples: admins, ten tenants, portal accounts, alert settings, rates, ledger entries, 22,449 formal CDRs (ABC001's per-call August/September calls plus three sample CDRs) and 326 unassigned calls tagged `ABC01` (phase 8: 324 assignable to ABC001 for 58.35, two answered before ABC001's first rate version and so without a rate), then generates the monthly statements. Source: `packages/db/src/seed.ts`, `src/bin/seed.ts`, and seed assertions in `src/ledger.db.test.ts`, `src/rls.db.test.ts`, `src/rates.db.test.ts`, `src/seed.db.test.ts`, `src/seed-calls.test.ts`, and `src/seed-unassigned.test.ts`.

## Sub-features

- `seed-samples` populates design examples, including ABC001 and GZT007.
- `seed-repeat` skips existing deterministic events and registered UUIDs.
- `seed-observe` prints tenant balances and allows independent stored-data reads.

## How to get to it (user POV)

- Configure/health-check the local owner database as described in the skill, then migrate before seed. Seed uses `DATABASE_URL` and creates August/September/October 2026 partitions separately from tenant-locked writes.

## Driving it with database commands

```sh
pnpm db:migrate
pnpm db:seed
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT
  (SELECT count(*) FROM tenants) AS tenants,
  (SELECT count(*) FROM admins) AS admins,
  (SELECT count(*) FROM portal_accounts) AS portal_accounts,
  (SELECT count(*) FROM rate_versions) AS rate_versions,
  (SELECT count(*) FROM rate_entries) AS rate_entries,
  (SELECT count(*) FROM ledger_entries WHERE idempotency_key LIKE 'seed:%') AS seed_ledger,
  (SELECT count(*) FROM cdrs) AS cdrs,
  (SELECT count(*) FROM unassigned_cdrs) AS unassigned;
SELECT t.code, t.currency, b.balance FROM tenants t JOIN tenant_balances b ON b.tenant_id = t.id ORDER BY t.code;
SELECT * FROM balance_discrepancies;
SQL
pnpm db:seed
```

- Require exit 0 and the CLI balance table. Repeat the same SQL after the second seed and compare results.
- On a fresh seed-only database, counts are `10, 2, 10, 11, 88, 23, 22469, 1` in query order (23 `seed:` ledger keys; ABC001's per-call charges use the production `call:<UUID>` key; the CDR count includes ABC001's 20 current-month calls, see below). Balances include ABC001 `-35.20`, GZT007 `86.27` (86.50 minus its two sample calls, 0.20 + 0.03, which now have `call:<UUID>` charges), CDT018 `0`, HZX014 `-100.36`, and GLB009 `-15.02`. Discrepancies are empty; a second seed does not duplicate rows.
- ABC001 has 22,472 ledger entries (5 manual, one charge per answered call, and the current-month set below): August charges `-1873.40` (9,642 calls), September charges `-2486.30` (12,804 calls), and pending credit recharge with seed input `500.00` (a raw read shows `500`); `tenants.created_at` is 2026-08-12 09:30 Beijing; on the 1st of the seeding month (the database clock's Beijing month, from October 2026, only once 03:00 has passed) it also has 20 answered calls between 00:05 and 02:00 totaling 81 minutes and `3.51`, plus one recharge of exactly `3.51` at 00:03:00, so the balance stays `-35.20` (this month's spend `3.51`, 20 calls; a re-run in the same month adds nothing, a run in a later month adds another self-offsetting set); its 447 rate changes from `0.0450` to `0.0480` on Beijing October 1. Acceptance `pnpm test:db` seeds its fresh database and checks these samples.
- Save before/after SQL and CLI output. Exact total counts apply only before acceptance tests or other writes add records.

## Gotchas

- This is additive insertion, not a reset or a repair command. Existing edited rows and tenant rate histories are not overwritten.
- Seed before migration fails on missing tables/functions. Missing configuration or insufficient privileges also fails.
- Historical ledger write times require owner access; the app role cannot backdate `created_at`.
- ABC001's ledger charges are one per call and match its CDRs exactly (statement `breakdown_gap` 0); the other tenants' charges are still daily summaries that represent many calls, and GZT007's two sample CDRs are charged individually (`call:<UUID>`). Account rows do not provide login credentials or an implemented login flow.
