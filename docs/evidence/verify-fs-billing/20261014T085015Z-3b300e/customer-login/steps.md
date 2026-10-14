# customer-login — PASS

run 20261014T085015Z-3b300e, 2026-10-14T08:51:28.117Z, web http://127.0.0.1:44029

| step | action | result | detail |
|---|---|---|---|
| entry-redirect | visit / signed out | PASS | redirected to /login, heading 登录 |
| portal-login | submit abc001@example.com + seeded password on /login | PASS | POST /api/auth/login 200 kind=customer tenant=ABC001 |
| balance | portal home shows tenant crumb and balance | PASS | region 当前余额 = -¥35.20 CNY |
| db-side-effects | session row exists and DB balance matches UI | PASS | auth.session row (7-day TTL) for abc001; tenant_balances ABC001 = -35.20 |
| usd-balance | USD tenant glb009 sees dollar balance | PASS | region 当前余额 = -$15.02 |
