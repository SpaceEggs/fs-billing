# Cross-tenant isolation

A customer can read only their own tenant's data, and customer and admin APIs are kept apart. The portal API takes no tenant or account ID from the client: the tenant comes from the session. So customer A's cookie always returns A's data, and B's IDs in admin URLs are refused with 403. A customer cookie on admin endpoints and an admin cookie on portal endpoints both get `403 FORBIDDEN`, and no cookie gets `401 UNAUTHENTICATED`. The repo's IDOR suite enumerates every customer, authenticated, and session operation from the live OpenAPI and checks both defenses: explicit filters and RLS.

## Sub-features

- `own-tenant-only`: A (`abc001`) and B (`glb009`) each `GET /api/portal/context` and each body equals, field for field, the only context that customer may see: its own profile, email, tenant (id, code, name, currency from the DB) and balance (A `-35.20 CNY`, B `-15.02 USD`). Any extra field fails the step.
- `customer-to-admin`: A's cookie on `GET /api/admin/context` and on `POST /api/admin/portal-accounts/<B's id>/reset-password` gets `403 FORBIDDEN`. B's `auth.account.updated_at` is unchanged and `operation_logs` has 0 `reset_password` rows.
- `admin-to-portal`: an admin cookie on `GET /api/portal/context` gets `403 FORBIDDEN`.
- `anonymous`: no cookie gets `401 UNAUTHENTICATED` with `action: reauthenticate`.
- `idor-suite`: `pnpm test:idor` reports `Tests 15 passed (15)`, run on a scratch `fs_billing_test` DB inside the run's container.

## How to get to it (user POV)

- A logged-in customer's browser calls `/api/portal/context` from the portal home. Any HTTP client holding their cookie can call any `/api/*` path.
- A customer pastes an admin URL such as `/admin` into the browser. The UI bounces them to `/` (see [admin-login](./admin-login.md)), and this feature proves the API also refuses.
- A developer runs `pnpm test:idor`, and CI runs it too.

## Driving it with curl via api.sh (drive.mjs orchestrates)

Preconditions:

- `$S/doctor.sh` is healthy. `abc001`, `glb009`, and `wangmin` are not locked.
- `operation_logs` has no `reset_password` rows. A fresh launch has none.

- **Whole journey.** Run `$S/drive.mjs cross-tenant`. Exit `0`, five steps PASS. Transcripts are saved as `NN-*.http`.
- **Two tenants.** Run `$S/api.sh login abc001@example.com a`, `$S/api.sh login glb009@example.com b`, `$S/api.sh GET /api/portal/context a`, and `$S/api.sh GET /api/portal/context b`. Jar `a` returns `"code":"ABC001"` and `"amount":"-35.20"`. Jar `b` returns `"code":"GLB009"` and `"amount":"-15.02"`. The journey compares each whole body with one built from the DB for that customer, so an extra key or foreign tenant data fails. `05-tenant-ids.sql.txt` maps codes to ids and balances.
- **Customer on admin API.** Run `$S/api.sh GET /api/admin/context a`. The response is `403` with `"code":"FORBIDDEN"`. Get B's portal account id with `$S/sql.sh "SELECT p.id FROM portal_accounts p JOIN tenants t ON t.id=p.tenant_id WHERE t.code='GLB009'"`, then run `$S/api.sh POST /api/admin/portal-accounts/<id>/reset-password a`. The response is `403 FORBIDDEN`. `08-no-reset-side-effect.sql.txt` shows the same `updated_at` as before and `reset_logs 0`.
- **Admin on portal API.** Run `$S/api.sh login wangmin@example.com admin` then `$S/api.sh GET /api/portal/context admin`. The response is `403 FORBIDDEN`.
- **Anonymous.** Run `$S/api.sh GET /api/portal/context`. The response is `401` with `"code":"UNAUTHENTICATED"` and `"action":"reauthenticate"`.
- **IDOR suite.** Run `$S/with-env.sh pnpm test:idor`. The output contains `Tests  15 passed (15)` (`13-test-idor.cli.txt`). The suite creates and drops `fs_billing_test` in OUR container. Confirm with `$S/sql.sh "SELECT datname FROM pg_database"`: no `fs_billing_test` remains.
- **Mutation proof (optional, slower).** Run `$S/with-env.sh pnpm --filter @fs-billing/api prove:idor docs/evidence/verify-fs-billing/<RUN_ID>/cross-tenant/prove-idor`. It must report that baseline-app and baseline-owner pass, that mutation-owner detects B's balance leak, and that mutation-app passes (`docs/phase-4-api.md`).

## Gotchas

- There is no portal endpoint that takes a tenant id, so "A reads B by changing an id" cannot be attempted on the portal API. The real attack surfaces are the admin endpoints that take ids (the reset-password routes) and session or cookie confusion. Do not invent a URL like `/api/portal/tenants/<B>`: it returns `404 NOT_FOUND`, which proves nothing.
- `test:idor` and `prove:idor` load the root `.env`. Run them only through `with-env.sh`, or they drop and recreate `fs_billing_test` on the user's `:5432` server.
- Do not run `test:idor` while another DB suite runs against the same container. It drops and recreates `fs_billing_test` every time.
- POSTs need `Origin` set to a trusted origin, or they return `403 FORBIDDEN` before authorization runs. `api.sh` sends the web origin. A hand-written curl without it gives a misleading 403.
