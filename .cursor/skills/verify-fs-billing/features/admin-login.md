# Admin login

An internal admin signs in on `/admin/login` and lands in the admin shell at `/admin`: the `概览` page, the admin's name in the account menu, and the admin accent (`html[data-product=admin]`). Where you land depends on the account kind in the login response, not on the login page used. A customer who signs in on the admin login page lands in the portal, and an admin who signs in on the portal login page lands in the admin shell.

## Sub-features

- `entry-redirect`: a signed-out visit to `/admin` redirects to `/admin/login`, which shows `heading '登录管理后台'` and the hint `客户请使用客户门户登录`.
- `admin-shell`: `wangmin@example.com` reaches `/admin` with `heading '概览'`, `button '账号菜单'` containing `王敏`, and the text `欢迎，王敏。…`. An `auth.session` row joined to `admins` exists.
- `kind-decides-zone`: a customer logging in on `/admin/login` lands on `/`, and a later visit to `/admin` bounces to `/`.
- `admin-via-portal-login`: an admin logging in on `/login` lands on `/admin`.

## How to get to it (user POV)

- Open `/admin/login` directly.
- Open any `/admin…` URL while signed out. The app redirects to `/admin/login`.
- Log in as an admin on the portal page `/login`. The app routes by account kind.

## Driving it with Playwright (drive.mjs)

Preconditions:

- `$S/doctor.sh` is healthy.
- `wangmin@example.com` and `abc001@example.com` are not locked.

- **Whole journey.** Run `$S/drive.mjs admin-login`. Exit `0`, and `steps.md` lists the four sub-feature IDs as PASS.
- **Signed-out redirect.** Open `/admin`. The URL becomes `/admin/login`, and the page shows `heading '登录管理后台'` and `客户请使用客户门户登录`. Evidence: `01-admin-login.png`, `.aria.yml`.
- **Admin login.** On `/admin/login`, fill `登录邮箱` with `wangmin@example.com` and the seeded password, then click `登录`. The URL becomes `/admin`, and the page shows `heading '概览'`, `欢迎，王敏。`, `button '账号菜单'` with `王敏`, and `html[data-product=admin]`. Evidence: `02-admin-home.png`, `.aria.yml`. `02-admin-session.sql.txt` shows `wangmin@example.com | 王敏 | t`.
- **Customer on the admin page.** In a fresh context, log in on `/admin/login` as `abc001@example.com`. The URL becomes `/` and `heading '首页'` is visible. Then `page.goto('/admin')` stays on `/`. Evidence: `03-customer-via-admin-login.png`.
- **Admin on the portal page.** In a fresh context, log in on `/login` as `wangmin@example.com`. The URL becomes `/admin`.
- **API view.** Run `$S/api.sh login wangmin@example.com adm` then `$S/api.sh GET /api/admin/context adm`. The response is 200 with `"identity":{"kind":"admin",…,"name":"王敏"}`.

## Gotchas

- `/admin/login` shows `登录管理后台` as the h1 on both desktop and mobile. The mobile layout also shows an `FS-Billing 管理后台` pill. Do not assert the portal copy here.
- Routing by kind happens client-side after a 200 login. The API accepts a customer login on either page, so the API response alone never proves the zone. Assert the final URL.
- Admin login creates a normal 7-day session, and nothing in this journey logs it out. Later journeys that count `wangmin` sessions must count before and after rather than expect zero.
