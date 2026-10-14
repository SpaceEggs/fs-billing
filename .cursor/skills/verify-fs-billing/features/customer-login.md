# Customer login

A customer signs in on the portal login page with their login email and password and lands on the portal home (`/`). The home page shows their tenant code and name in the top bar and the current balance in the tenant's currency. A signed-out visit to any portal page redirects to `/login`.

## Sub-features

- `entry-redirect`: a signed-out visit to `/` redirects to `/login`, which shows the `登录` form.
- `portal-login`: valid credentials return 200 with `identity.kind = customer` and navigate to `/`.
- `balance`: the home page shows the crumb `ABC001 · 深圳市某某科技有限公司` and the region `当前余额` with `-¥35.20` and `CNY`.
- `db-side-effects`: an `auth.session` row with a 7-day TTL exists, and the DB balance equals the UI balance.
- `usd-balance`: a USD tenant sees a dollar balance (`-$15.02`).

## How to get to it (user POV)

- Open the web origin's `/login` directly.
- Open any portal URL (`/`, `/?tab=…`) while signed out. The app redirects to `/login`.
- Use `/admin/login` with a customer account. See [admin-login](./admin-login.md) `kind-decides-zone`; it also ends on `/`.

## Driving it with Playwright (drive.mjs)

Preconditions:

- `$S/doctor.sh` is healthy.
- `abc001@example.com` and `glb009@example.com` are not locked. The journey checks this and exits 2 if either is locked.
- The seed is unchanged: ABC001 has `-35.20` CNY and GLB009 has `-15.02` USD.

- **Whole journey.** Run `$S/drive.mjs customer-login`. Exit `0` and every step shows PASS in `docs/evidence/verify-fs-billing/<RUN_ID>/customer-login/steps.md`.
- **Signed-out redirect.** Open `/`. Step `entry-redirect`. The URL becomes `/login` and `heading '登录'` is visible. Evidence: `01-login-form.png`, `01-login-form.aria.yml`.
- **Log in.** Fill `登录邮箱` with `abc001@example.com` and `密码` with the seeded password, then click `button '登录'`. Step `portal-login`. `http.log` shows `POST /api/auth/login -> 200` with `"kind":"customer"` and `"code":"ABC001"`, and the URL becomes `/`.
- **Balance shown.** Step `balance`. The page shows `heading '首页'`, the crumb `ABC001 · 深圳市某某科技有限公司`, and `region '当前余额'` containing `-¥35.20` and `CNY`, with `html[data-product=portal]`. Evidence: `02-portal-home.png`, `02-portal-home.aria.yml`.
- **Session row and DB balance.** Step `db-side-effects` reads them with `$S/sql.sh`. `03-session-and-balance.sql.txt` shows `abc001@example.com | t | 127.0.0.1 | -35.20`: a session expiring more than 6 days out, and `tenant_balances` equal to the UI value.
- **USD tenant.** Log in as `glb009@example.com` in a fresh context. Step `usd-balance`. `region '当前余额'` contains `-$15.02`. Evidence: `04-usd-home.png`.
- **API-only check.** Run `$S/api.sh login abc001@example.com a` then `$S/api.sh GET /api/portal/context a`. The response is 200 with `"balance":{"currency":"CNY","amount":"-35.20"}`.

## Gotchas

- The desktop form has the visible `heading '登录'`. Below 640px that h1 is hidden and `登录客户门户` shows instead, so use a desktop viewport for this journey.
- The balance renders only after `/api/portal/context` resolves, and a skeleton shows until then. Assert on the region text, not on the skeleton being gone.
- `-¥35.20` is red because the balance is negative. Any change to the seed balance changes the expected string. Fix the seed expectation in this file and in `drive.mjs` together, and never loosen it to a regex.
- A successful login also deletes that email's `auth.login_failures` row. Logging in before [login-errors](./login-errors.md) can hide a counter you meant to inspect.
- `bjh003@example.com` belongs to launch and doctor. Do not use it in journeys.
