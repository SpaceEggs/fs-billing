# Not found (404)

Unknown URLs show a 404 page: the text `404`, `找不到这个页面`, an explanation, and a `返回首页` link to the zone's home. The zone comes from the path: `/admin/...` is the admin zone, everything else is the portal. Signed-out users, or users from the other zone, see a bare 404. Signed-in users in their own zone see it inside the shell. Unknown `/api/*` paths return a JSON `404 NOT_FOUND`.

## Sub-features

- `portal-signed-out`: `/no-such-page` shows `heading '找不到这个页面'` and `页面不存在或链接已失效，请检查地址是否正确`. `link '返回首页'` leads to `/` and then redirects to `/login`.
- `admin-signed-out`: `/admin/no-such-page` shows the admin-zone 404 (`html[data-product=admin]`). `返回首页` leads to `/admin` and then redirects to `/admin/login`.
- `admin-in-shell`: a signed-in admin on `/admin/no-such-page` sees the 404 inside the shell (`button '账号菜单'`, crumb `找不到页面`) with `返回首页即回到「概览」`. `返回首页` leads to `/admin`.
- `portal-in-shell`: a signed-in customer on `/x/y` sees the 404 inside the portal shell, with the crumb `ABC001 · 深圳市某某科技有限公司`.
- `api-404`: `GET /api/no-such-route` returns `404 {"error":{"code":"NOT_FOUND",…}}`.

## How to get to it (user POV)

- Type or follow a bad link under the portal (`/anything`) or the admin area (`/admin/anything`), signed in or out.
- An HTTP client calls a non-existent `/api/...` path.

## Driving it with Playwright (drive.mjs)

Preconditions:

- `$S/doctor.sh` is healthy. `abc001` and `wangmin` are not locked.

- **Whole journey.** Run `$S/drive.mjs not-found`. Exit `0`, five steps PASS.
- **Portal, signed out.** Open `/no-such-page`. The page shows `heading '找不到这个页面'` and the explanation (`01-portal-404.png`, `.aria.yml`). Click `link '返回首页'`. The URL becomes `/login`.
- **Admin, signed out.** Open `/admin/no-such-page`. The page shows the heading and `html[data-product=admin]` (`02-admin-404-signed-out.png`). Click `返回首页`. The URL becomes `/admin/login`.
- **Admin, in shell.** Log in as `wangmin` on `/admin/login`, then open `/admin/no-such-page`. The page shows the heading, `button '账号菜单'`, and `返回首页即回到「概览」` (`03-admin-404-shell.png`, `.aria.yml`). Click `返回首页`. The URL becomes `/admin`.
- **Portal, in shell.** Log in as `abc001`, then open `/x/y`. The page shows the heading and the crumb `ABC001 · 深圳市某某科技有限公司` (`04-portal-404-shell.png`).
- **API 404.** Run `$S/api.sh GET /api/no-such-route`. The response is `404` with `"code":"NOT_FOUND"` (`05-api-404.http`).

## Gotchas

- The bare 404 and the in-shell 404 depend on whether the session's identity matches the path's zone. A customer on `/admin/nope` gets the bare admin 404, not the portal shell.
- The page renders nothing while the session query is pending. Wait for the heading, not for `load`.
- `vite preview` serves `index.html` for every unknown path (SPA fallback), so the HTTP status of a page 404 is 200. Only `/api/*` gives a real 404 status. Do not assert a 404 status on page URLs.
- `返回首页即回到「概览」` is hidden below 768px. Use a desktop viewport for `admin-in-shell`.
