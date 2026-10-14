# Logout

A signed-in user logs out from the account menu: the avatar dropdown on desktop, or the `账号菜单` bottom sheet on mobile. The server deletes that session row and clears the cookie, and the app returns to the zone's login page. Revisiting a protected page afterwards redirects to login, and the old token no longer authenticates.

## Sub-features

- `desktop-menu`: `button '账号菜单'` opens a `menu` showing the account. Clicking `menuitem '退出登录'` returns to `/login`. The `auth.session` row for this browser's token goes from 1 to 0, and the cookie is gone.
- `revisit`: `/` redirects to `/login`, and replaying the old token on `GET /api/auth/session` returns `401 UNAUTHENTICATED`.
- `mobile-sheet`: at 375px, `button '账号菜单'` opens `dialog '账号菜单'`. Clicking `button '退出登录'` returns to `/login`, and live `abc001` sessions drop by exactly 1.

## How to get to it (user POV)

- Desktop (≥ 768px): click the account name (top right), then `退出登录`.
- Mobile (< 768px): tap the avatar (top right), then `退出登录` in the bottom sheet.
- The blocked page (disabled account mid-session) has its own `退出登录` button, which uses the same flow.

## Driving it with Playwright (drive.mjs)

Preconditions:

- `$S/doctor.sh` is healthy. `abc001@example.com` is not locked.

- **Whole journey.** Run `$S/drive.mjs logout`. Exit `0`, three steps PASS.
- **Desktop logout.** Log in as `abc001`. The journey reads this browser's session cookie and confirms its session row exists (matched on `sha256(token)`, so the token never appears in a command line). Replaying the complete signed cookie outside the browser on `GET /api/auth/session` returns `200` for `abc001@example.com`. Click `button '账号菜单'`. `menu` contains `abc001@example.com` (`01-account-menu.png`, `.aria.yml`). Click `menuitem '退出登录'`. The URL becomes `/login` and the same query returns `0`. `02-session-row.sql.txt` records the before and after; the token itself is not written. No `better-auth.session_token` cookie remains (`03-after-logout.png`). `browser-http.txt` shows `POST /api/auth/logout -> 204`.
- **Revisit.** Open `/`. The URL becomes `/login`. Replay the same complete signed cookie on `GET /api/auth/session`. The response is now `401 {"code":"UNAUTHENTICATED"}`. Both replays are logged in `browser-http.txt`, so the pair proves the server revoked a cookie that was valid a moment earlier.
- **Mobile logout.** In a 375×812 touch context, log in as `abc001`. Count live sessions with `$S/sql.sh "SELECT count(*) FROM auth.session s JOIN auth.\"user\" u ON u.id=s.user_id WHERE u.email='abc001@example.com' AND s.expires_at > now()"`. Tap `button '账号菜单'`, then `button '退出登录'` inside `dialog '账号菜单'`. The URL becomes `/login` and the count drops by 1. `05-mobile-sessions.sql.txt` records the query and both counts (`04-mobile-after-logout.png`).
- **API view.** Run `$S/api.sh login abc001@example.com l`, then `$S/api.sh POST /api/auth/logout l` returns `204` with `set-cookie: better-auth.session_token=; … Max-Age=0`. Running `$S/api.sh POST /api/auth/logout l` again returns `401`.

## Gotchas

- A replay must send the whole cookie value, `<token>.<signature>`. The API rejects an unsigned token even before logout, so replaying only the token proves nothing.
- Logout deletes only this browser's session. Other sessions for the same user (other journeys, other contexts) stay live. Assert on this token, or on the count dropping by exactly one, never on "zero sessions for the user".
- On desktop the menu item is a Radix `menuitem` inside `menu`. On mobile it is a plain `button` inside `dialog '账号菜单'`. The same selector does not work for both.
- If the logout request fails for a reason other than 401, the UI stays signed in and shows `退出失败，请检查网络后重试`. If you see that, check API health before you retry.
- Logout is excluded from the credential rate limit. It does not use up the 30/min budget.
