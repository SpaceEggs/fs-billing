# admin-login — PASS

run 20261014T091128Z-5c13b2, 2026-10-14T09:13:43.015Z, web http://127.0.0.1:53769

| step | action | result | detail |
|---|---|---|---|
| entry-redirect | visit /admin signed out | PASS |  |
| admin-shell | wangmin@example.com logs in on /admin/login | PASS |  |
| kind-decides-zone | customer abc001 logs in on /admin/login, then visits /admin | PASS | landed on / (portal), /admin bounces to / |
| admin-via-portal-login | admin logs in on /login | PASS |  |
