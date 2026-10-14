# Session expiry and return-to

When a session expires or is revoked, the user is sent to the login page of their zone. After logging in again, they return to the exact page they were on, query string included. There are two cases. Navigating with an expired session redirects to `/login?reason=expired`, which shows a `登录已过期` banner. A revoked session discovered while on a page opens a blocking dialog, whose `重新登录` button leads to `/admin/login?reason=expired`. A remembered path from the other zone is ignored after login, and the user lands on their own home.

## Sub-features

- `expired-redirect`: with an expired `auth.session.expires_at`, opening `/?tab=ledger&type=%E5%85%85%E5%80%BC` leads to `/login?reason=expired` with the status banner `登录已过期，请重新登录` / `登录后将返回之前的页面`. Logging in returns to the same URL.
- `revoked-dialog`: deleting the admin's session rows while they are on `/admin?view=verify`, then a refocus refetch, opens `dialog '登录已过期，请重新登录'` containing `登录后将回到当前页面`. Clicking `重新登录` goes to `/admin/login?reason=expired`. Logging in returns to `/admin?view=verify`.
- `cross-zone-fallback`: a signed-out visit to `/admin?from=portal-user`, then a customer login on `/admin/login`, lands on `/`.

## How to get to it (user POV)

- Leave a tab past the 7-day session lifetime, then navigate or reload.
- An admin resets your password, or `auth:bootstrap --replace` runs, while you have the app open. Either deletes your sessions. Return to the tab.
- Follow a deep link (bookmark or shared URL) while signed out.

## Driving it with Playwright (drive.mjs)

Preconditions:

- `$S/doctor.sh` is healthy. `abc001@example.com` and `lijun@example.com` are not locked.

- **Whole journey.** Run `$S/drive.mjs session-expiry`. Exit `0`, three steps PASS.
- **Expire and deep-link.** Log in as `abc001`. Expire the session in the DB, standing in for 7 days passing: `$S/sql.sh "UPDATE auth.session SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM auth.\"user\" WHERE email='abc001@example.com')"` (saved as `01-expire-sessions.sql.txt`). Open `/?tab=ledger&type=%E5%85%85%E5%80%BC`. The URL becomes `/login?reason=expired` and `getByRole('status')` contains both banner lines (`02-expired-banner.png`, `.aria.yml`). Log in again. The URL is exactly `/?tab=ledger&type=%E5%85%85%E5%80%BC` and `heading '首页'` is visible (`03-returned.png`).
- **Revoke while on a page.** Log in on `/admin/login` as `lijun@example.com` and open `/admin?view=verify`. Delete the sessions, as an admin reset does: `$S/sql.sh "DELETE FROM auth.session WHERE user_id = (SELECT id FROM auth.\"user\" WHERE email='lijun@example.com')"` (saved as `04-revoke-sessions.sql.txt`). Dispatch `visibilitychange` on `document`. `dialog '登录已过期，请重新登录'` appears with `登录后将回到当前页面` (`05-expired-dialog.png`, `.aria.yml`). Click `button '重新登录'`. The URL is `/admin/login?reason=expired`. Log in. The URL is `/admin?view=verify` (`06-returned.png`).
- **Wrong-zone return path.** In a fresh context, open `/admin?from=portal-user`. The URL becomes `/admin/login`. Log in as `abc001`. The URL is `/`.
- **API view.** After the expiry update, `$S/api.sh GET /api/auth/session <jar>` returns `401 SESSION_EXPIRED` with `"action":"reauthenticate"`. After the delete, it returns `401 UNAUTHENTICATED`.

## Gotchas

- The two cases differ by server code. `SESSION_EXPIRED` (row exists, past `expires_at`) adds `?reason=expired` and the banner. `UNAUTHENTICATED` (row gone, or cookie cleared) redirects to plain `/login` with no banner. Clearing browser cookies does not prove the expired banner.
- The dialog appears only when an in-page query refetches. Headless Chromium cannot really background a tab, so the journey dispatches `visibilitychange`, which is React Query's refocus trigger. This is the one synthetic event in the skill. Say so when you report.
- The expiry and revocation are DB edits that stand in for time passing and for an admin action. Each one is saved as its own `.sql.txt`. Do not treat them as product behavior.
- The return path lives in `sessionStorage`, so it is per tab. A login in a new tab or context goes home instead.
- Session lifetime is 7 days with no sliding refresh visible to the user. Do not wait for a real expiry.
