# Phase 5 open questions

## Legacy tenants without balance alert settings — RESOLVED 2026-10-14

**Decision (user):** do **not** backfill or synthesize settings.

- **List:** keep the row; set `settingsConfigured: false` (or equivalent). Do not 503 the whole list; do not omit the row. `disabled` / `suspended` / `overdraft` health still computed from core data; only the normal vs low_balance branch treats the tenant as unconfigured.
- **Detail:** strict fail (503 or dedicated error) when settings are missing — no invented thresholds.
- Balance, ledger, tenant edit, disable, and enable still use core tenant data.
- Creating a tenant always writes explicit settings in the creation transaction.
- Updating settings on an unconfigured legacy tenant stays deferred until a before-state / backfill policy is chosen.

## First-login password-change gate — RESOLVED 2026-10-14

**Decision (user, Claude opinion):** Option A with supplements.

- Derive required-change from `auth.account.temporary_password_issued_at` (source of truth); do not store a second session flag.
- Deny by default in the shared request pipeline; allowlist only session, logout, and change-password.
- Blocked calls return dedicated `PASSWORD_CHANGE_REQUIRED` (403).
- After successful change: clear `temporary_password_issued_at` and revoke the account's other sessions.

## Cross-connection password-reset / session-revoke delivery — RESOLVED 2026-10-14

**Decision (user, Claude opinion):** narrowed Option B — SECURITY DEFINER functions, not outbox.

- Auth and business share one PostgreSQL database (roles differ). Add `fs_billing_auth`-owned functions with EXECUTE only for `fs_billing_app`:
  - `auth.revoke_user_sessions(user_id)`
  - `auth.set_credential(user_id, hash, temp_issued_at)` (hash computed in app before the transaction)
  - `auth.insert_credential(...)` for activation
- Business transaction writes status + audit + auth change atomically.
- Pin column shapes with tests so Better Auth upgrades cannot silently break them.
- Outbox remains the fallback only if product later insists on strict role separation without SECURITY DEFINER.

## Concurrent account activation recovery — RESOLVED 2026-10-14

**Decision (user, Claude opinion):** Option A with supplements.

- Migration fails loudly if duplicate `(user_id, provider_id)` rows exist (manual choice which credential survives); then add `UNIQUE(user_id, provider_id)`.
- Recovery uses `INSERT … ON CONFLICT DO NOTHING` — no new advisory locks.
- With narrowed-B credential insert in the same business transaction, the separate activate/recovery path mostly disappears; keep the unique constraint as a backstop.

## Remaining open questions

None for Phase 5 API continuation.
