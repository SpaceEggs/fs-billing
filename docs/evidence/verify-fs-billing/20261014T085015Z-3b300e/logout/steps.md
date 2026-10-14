# logout — PASS

run 20261014T085015Z-3b300e, 2026-10-14T08:56:48.876Z, web http://127.0.0.1:44029

| step | action | result | detail |
|---|---|---|---|
| desktop-menu | account menu -> 退出登录 removes the session row | PASS | session row for this cookie deleted; cookie cleared |
| revisit | revisit / after logout -> /login; the same signed cookie that worked before logout -> 401 | PASS | old cookie: 200 before logout, 401 UNAUTHENTICATED after |
| mobile-sheet | 375px: 账号菜单 sheet -> 退出登录 | PASS | live abc001 sessions 3 -> 2 |
