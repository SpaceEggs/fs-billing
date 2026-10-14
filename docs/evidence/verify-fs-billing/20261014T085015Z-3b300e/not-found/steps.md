# not-found — PASS

run 20261014T085015Z-3b300e, 2026-10-14T08:58:54.982Z, web http://127.0.0.1:44029

| step | action | result | detail |
|---|---|---|---|
| portal-signed-out | /no-such-page signed out -> 404, 返回首页 -> /login | PASS |  |
| admin-signed-out | /admin/no-such-page signed out -> admin 404, 返回首页 -> /admin/login | PASS |  |
| admin-in-shell | signed-in admin /admin/no-such-page -> 404 inside the shell | PASS |  |
| portal-in-shell | signed-in customer /x/y -> 404 inside the portal shell | PASS |  |
| api-404 | GET /api/no-such-route -> JSON 404 | PASS |  |
