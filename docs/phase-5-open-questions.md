# Phase 5 open questions

## Legacy tenants without balance alert settings — RESOLVED 2026-10-14

**Decision (user):** do **not** backfill or synthesize settings.

- **List:** keep the row; set `settingsConfigured: false` (or equivalent). Do not 503 the whole list; do not omit the row. `disabled` / `suspended` / `overdraft` health still computed from core data; only the normal vs low_balance branch treats the tenant as unconfigured.
- **Detail:** strict fail with 500 `INTERNAL_ERROR` when settings are missing, per the 2026-10-15 error-mapping decision. Return the generic message `服务内部错误` without internal details. Do not invent thresholds.
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
  - `auth.insert_credential(...)` for the credential row
  - `auth.insert_user(...)` so creating the auth user joins the same business transaction and rolls back with it
  - `auth.clear_login_failures(email_key)` so reset deletes the JavaScript-normalized login-failure key inside that transaction
- Business transaction writes profile + audit + auth change atomically. Failed account creation leaves no auth user.
- Pin column shapes with tests so Better Auth upgrades cannot silently break them.
- Outbox remains the fallback only if product later insists on strict role separation without SECURITY DEFINER.

## Concurrent account activation recovery — RESOLVED 2026-10-14

**Decision (user, Claude opinion):** Option A with supplements.

- Migration fails loudly if duplicate `(user_id, provider_id)` rows exist (manual choice which credential survives); then add `UNIQUE(user_id, provider_id)`.
- Recovery uses `INSERT … ON CONFLICT DO NOTHING` — no new advisory locks.
- With narrowed-B credential insert in the same business transaction, the separate activate/recovery path mostly disappears; keep the unique constraint as a backstop.

## Remaining open questions

### Rate preview storage across processes — DEFERRED

Phase 5 runs one API process. `createAdminRatesService` keeps previews in a process-local `Map`. That is accepted for this phase:

- A restart drops every preview. Commit then returns `PREVIEW_STALE`.
- Another API process cannot see those previews, so a commit there also returns `PREVIEW_STALE`.
- Expired entries are removed only inside `savePreview`. The map grows until the next preview save.

Do not add multi-node infrastructure for this. When more than one API process is required, prefer an HMAC-signed preview token over a database table. The token is stateless, needs no new store, and can bind actor, tenant, base version, entries, schedule, and expiry. It stays deferred because `previewId` is `z.uuid()`, commit sends only that id, and a token carrying up to 10,000 rate rows can exceed the request body limit. Adopting it is a contract change.
