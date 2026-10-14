# login-errors — PASS

run 20261014T085015Z-3b300e, 2026-10-14T08:53:39.687Z, web http://127.0.0.1:44029

| step | action | result | detail |
|---|---|---|---|
| same-message | unknown email vs wrong password give identical status, code, message | PASS | both 401 INVALID_CREDENTIALS "账号或密码错误" |
| clear-abc001 | correct password clears abc001 counter | PASS |  |
| lockout | 5 wrong passwords for hzx014@example.com lock the account | PASS | 1:401 INVALID_CREDENTIALS, 2:401 INVALID_CREDENTIALS, 3:401 INVALID_CREDENTIALS, 4:401 INVALID_CREDENTIALS, 5:429 ACCOUNT_LOCKED retry=900; countdown "请在 15分00秒 后重试" -> "请在 14分58秒 后重试"; counter failed_count=5 |
| locked-correct-password | correct password while locked is still refused | PASS | 429 ACCOUNT_LOCKED retryAfterSeconds=898 |
| emergency-unlock | owner runs auth:unlock; counter row deleted; login works | PASS | 解除锁定计数 1 行 |
| disabled | disabled tenant cdt018 sees the disabled message, no session kept | PASS | 403 ACCOUNT_DISABLED; 0 session rows |
