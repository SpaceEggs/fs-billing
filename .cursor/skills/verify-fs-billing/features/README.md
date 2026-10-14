# FS-Billing verification map

This directory is the maintained source for verifying FS-Billing's user-facing behavior. It covers the customer portal and admin shell in `apps/web`, the `/api` surface of `apps/api`, the auth CLIs, and the separate FreeSWITCH/SIPp e2e. Read this index before driving, then use the matching feature file as the recipe. `S=.cursor/skills/verify-fs-billing/scripts` throughout.

## Baseline preconditions

- A run launched by `$S/launch.sh`, with its own `postgres:17.9-alpine` container `fsb-verify-<RUN_ID>`, its own API and web ports, and an empty database that was migrated, seeded, and given credentials by `auth:seed`.
- `$S/doctor.sh` prints `doctor: healthy` for that run. Never drive a stack the run did not start. Never touch `fs-billing-postgres-1` or `127.0.0.1:5432`.
- Seed facts the journeys rely on (`packages/db/src/seed.ts`):
  - ABC001 is a CNY tenant with balance `-35.20`.
  - GLB009 is a USD tenant with balance `-15.02`.
  - CDT018 is `disabled`.
  - The admins are `wangmin@example.com` (王敏) and `lijun@example.com` (李俊).
  - Every portal login is `<lowercase code>@example.com`, and every seeded account uses `SEED_AUTH_PASSWORD`.
- No seeded account has a live lock in `auth.login_failures`. Every journey checks this and exits BLOCKED if one does.

## Driving conventions

- Browser actions go through `$S/drive.mjs <feature-id>`, a headless Playwright Chromium against the run's web origin. Use `--headed` to watch.
- HTTP actions go through `$S/api.sh`, via the web origin's `/api` proxy with the web `Origin` header.
- DB reads go through `$S/sql.sh "<sql>"`, as the owner role in the run's container. Repo CLIs go through `$S/with-env.sh <command>`.
- Use ARIA roles and accessible names from `apps/web/src`, quoted exactly as in the feature files (Chinese copy included). Do not use CSS classes or positions.
- Journeys create sessions and failure counters as they run. Each one leaves the accounts it used unlocked. Run features one at a time, or all of them with `$S/drive.mjs all`. Login and change-password share a 30-per-minute-per-IP rate limit, so each journey first waits until 61 s have passed since the run's last credential request.
- A fresh launch is the reset. If a run's state is unclear, clean it up and launch again. Do not hand-edit rows to restore a baseline.

## Proof and skip reporting

- Every browser step records the user action, the HTTP status and error `code` behind it, and the screen before and after as `.png` and `.aria.yml`. API-only steps record `.http` transcripts instead.
- Every state change is also checked in rows: `auth.session`, `auth.login_failures`, `auth.account`, `operation_logs`, `tenant_balances`. The query and its rows are saved to `.sql.txt`.
- A DB edit that stands in for elapsed time or an operator action is saved as its own `.sql.txt` and named in the step (expiring `auth.session.expires_at`, deleting session rows).
- Evidence goes to `docs/evidence/verify-fs-billing/<RUN_ID>/<feature-id>/`. `steps.md` and `result.json` give PASS, FAIL, or BLOCKED per step.
- BLOCKED (exit 2) means a precondition was missing. Report it with the reason, and never as PASS. Do not report an entry point as verified through a different entry point.
- Report the run's git revision from `doctor.sh`, and note any uncommitted paths.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections, in this order:

1. `Sub-features`: short IDs, one line per behavior. They match the step IDs in `drive.mjs` output.
2. `How to get to it (user POV)`: every user entry point.
3. `Driving it with <harness>`: starts with `Preconditions:`, then labeled bullets. Each bullet pairs a user action with the exact command and the observable result, including DB side effects.
4. `Gotchas`: traps that can waste or invalidate a run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [customer-login](./customer-login.md): portal login, redirect when signed out, the balance on the home page, and the session row.
- [admin-login](./admin-login.md): admin login into the admin shell. The account kind decides the zone, whichever login page was used.
- [login-errors](./login-errors.md): one message for an unknown email and a wrong password, lockout after 5 failures with a countdown, emergency unlock, and the disabled account.
- [session-expiry](./session-expiry.md): an expired or revoked session goes to login, then back to the original URL with its query.
- [cross-tenant](./cross-tenant.md): tenant A cannot read B, customer and admin APIs are split, and the IDOR suite.
- [logout](./logout.md): logout from the desktop menu and the mobile sheet removes the session row, and revisiting redirects to login.
- [theme-and-mobile](./theme-and-mobile.md): light, dark, and system themes persist; the 375px layout; the account sheet and nav drawer.
- [not-found](./not-found.md): the 404 page in the portal and admin zones, signed in and signed out, plus the API 404.
- [freeswitch-sipp](./freeswitch-sipp.md): a separate surface. How to run the SIPp e2e, what PASS looks like, and why it is not isolated.
