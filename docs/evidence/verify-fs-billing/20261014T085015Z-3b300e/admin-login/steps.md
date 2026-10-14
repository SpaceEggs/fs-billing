# admin-login — PASS

run 20261014T085015Z-3b300e, 2026-10-14T08:52:30.871Z, web http://127.0.0.1:44029

| step | action | result | detail |
|---|---|---|---|
| entry-redirect | visit /admin signed out | PASS |  |
| admin-shell | wangmin@example.com logs in on /admin/login | PASS |  |
| kind-decides-zone | customer abc001 logs in on /admin/login, then visits /admin | PASS | landed on / (portal), /admin bounces to / |
| admin-via-portal-login | admin logs in on /login | PASS |  |
