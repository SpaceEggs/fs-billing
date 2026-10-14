# logout — PASS

run 20261014T083714Z-b9fa00, 2026-10-14T08:38:01.073Z, web http://127.0.0.1:51139

| step | action | result | detail |
|---|---|---|---|
| desktop-menu | account menu -> 退出登录 removes the session row | PASS | session row for this cookie deleted; cookie cleared |
| revisit | revisit / after logout -> /login; old token -> 401 | PASS |  |
| mobile-sheet | 375px: 账号菜单 sheet -> 退出登录 | PASS | live abc001 sessions 3 -> 2 |
