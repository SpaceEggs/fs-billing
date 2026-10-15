# Phase 5 open questions

## Legacy tenants without balance alert settings — RESOLVED 2026-10-14

**Decision (user):** follow recommendation option 1, deferred — do **not** backfill or synthesize settings.

- Detail and list projections return service unavailable when a tenant has no `balance_alert_settings` row.
- Balance, ledger, tenant edit, disable, and enable still use core tenant data.
- Creating a tenant always writes explicit settings in the creation transaction.
- Updating settings on an unconfigured legacy tenant stays deferred until a before-state / backfill policy is chosen (product owners pick legacy threshold + recipients then).
- Option 3 (silently project zero / empty) is rejected: invents saved settings and can misstate health.

## First-login password-change gate — OPEN 2026-10-14

The design requires forced password changes for initial and reset passwords. The current identity and session DTOs expose no password-change-required flag, and no contract decides which business operations remain available before changing the password.

- Option 1 (recommended): extend the session contract with an explicit required-change state and allow only session, logout, and password-change operations while it is set. Both admin and portal clients must handle that state.
- Option 2: keep the existing session response and reject every business operation with a new dedicated contract error until the password changes.

Deferred in this slice: the forced-change gate and its client contract. Temporary credential issuance, configurable 72-hour login expiry, and clearing issuance after a successful password change are implemented independently (in WIP stash pending Codex quota).

## Recoverable password reset and session revocation delivery — OPEN 2026-10-14

Auth and business data use separate connections. Resetting a credential and then writing an audit cannot satisfy atomic audit delivery. Account disable commits status and audit together and then revokes sessions; status denies access if auth revocation fails. Durable delivery is still needed for eventual cleanup when a disable request fails after its business transaction commits.

- Option 1 (recommended): add a durable business outbox event in the profile/audit transaction, deliver credential resets and session revocations through an idempotent auth consumer, and prevent enable until outstanding revocation events are delivered. Persist reset delivery state so retries do not duplicate the audit or issue new passwords accidentally.
- Option 2: introduce a restricted cross-schema database procedure and role allowing each lifecycle change and its audit to commit in one PostgreSQL transaction.

## Concurrent account activation recovery — OPEN 2026-10-14

Staged creation safely leaves an auth user with no credential if profile linking or activation fails. Recovery must avoid duplicate profiles, credentials, and audit events. However, `auth.account` currently has only a nonunique user index, so concurrent recovery cannot atomically claim a missing credential without a new lock or uniqueness rule. This phase does not introduce an auth row lock (only existing `lock_tenants`).

- Option 1 (recommended): audit and repair existing duplicates, add a unique `(user_id, provider_id)` constraint, then implement credential activation recovery with conflict handling against the existing profile and creation audit.
- Option 2: authorize a stable auth-user row lock for activation recovery, then check and insert the credential in that transaction.
