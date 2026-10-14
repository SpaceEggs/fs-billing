# Login errors

Login failures must not reveal whether an email exists. An unknown email and a wrong password produce the same status, code, message, and on-screen alert. After 5 failed attempts within 15 minutes, the account is locked for 15 minutes. The page then shows a countdown driven by `retryAfterSeconds` and disables the form, and the DB holds a counter row. An operator's emergency unlock CLI deletes the counter so the user can log in again. A disabled account gets its own message and no session.

## Sub-features

- `same-message`: an unknown email and a wrong password both return `401 INVALID_CREDENTIALS "账号或密码错误"`. The UI shows the alert `登录邮箱或密码错误` / `请检查后重新输入`. Both emails get an `auth.login_failures` row with `failed_count = 1`.
- `clear-abc001`: a correct login deletes that email's counter. The unknown email's counter is removed with `auth:unlock`.
- `lockout`: attempts 1–4 return `401 INVALID_CREDENTIALS` and attempt 5 returns `429 ACCOUNT_LOCKED` with `retryAfterSeconds ≈ 900`. The alert reads `登录失败次数过多，已暂时锁定` / `请在 15分00秒 后重试`. The submit button is disabled and named by the countdown, which ticks down. The email field is disabled. The DB row has `failed_count = 5` and `locked_until ≈ now + 15 min`.
- `locked-correct-password`: the correct password while locked still returns `429 ACCOUNT_LOCKED`.
- `emergency-unlock`: `auth:unlock` prints `解除锁定计数 1 行` and the counter row is gone. A login with the correct password then reaches `/`.
- `disabled`: CDT018's portal login returns `403 ACCOUNT_DISABLED`. The alert reads `该账号已停用` / `如需恢复使用，请联系客服`, and `cdt018` has 0 `auth.session` rows.

## How to get to it (user POV)

- Submit the form on `/login` or `/admin/login` with a wrong password or an unknown email. Both pages share the logic. Admin copy differs only for disabled (`该管理员账号已停用`).
- Repeat wrong passwords five times on one email.
- An operator runs `pnpm --filter @fs-billing/api auth:unlock <email>`. In this skill that is always `$S/with-env.sh pnpm --filter @fs-billing/api auth:unlock <email>`.
- Log in as an account whose tenant or profile is disabled.

## Driving it with Playwright (drive.mjs)

Preconditions:

- `$S/doctor.sh` is healthy.
- `hzx014@example.com` has no `auth.login_failures` row. Check with `$S/sql.sh "SELECT * FROM auth.login_failures WHERE email_key='hzx014@example.com'"`. The journey exits 2 if the row exists.
- `abc001@example.com` is not locked. CDT018 is seeded `disabled`.
- Fewer than about 15 credential requests from this machine in the last minute (shared limit of 30/min/IP).

- **Whole journey.** Run `$S/drive.mjs login-errors`. Exit `0`, all six steps PASS.
- **Unknown email vs wrong password.** On `/login`, submit `nobody-verify@example.com` / `wrong-password-verify`, then `abc001@example.com` / `wrong-password-verify`. Step `same-message`. Both responses are `401 INVALID_CREDENTIALS` with identical `message`, and `getByRole('alert')` has text `登录邮箱或密码错误请检查后重新输入` both times. Evidence: `01-unknown-email.png`, `02-wrong-password.png`, `browser-http.txt`. `03-counters-after-one-failure.sql.txt` shows both emails with `failed_count 1` and no lock, and the step fails unless both rows exist with exactly those values.
- **Clear counters.** Log in correctly as `abc001`, then run `$S/with-env.sh pnpm --filter @fs-billing/api auth:unlock nobody-verify@example.com`. Step `clear-abc001`. The `abc001` counter count is `0`. Evidence: `04-unlock-unknown.cli.txt`.
- **Lock the account.** In a fresh page, submit `hzx014@example.com` with `wrong-password-1` through `wrong-password-5`. Step `lockout`. Attempts 1–4 return 401, attempt 5 returns 429 with `retryAfterSeconds` > 850. The alert contains `登录失败次数过多，已暂时锁定` and matches `请在 1[45]分\d{2}秒 后重试`. `button /^请在 \d+分\d{2}秒 后重试$/` is disabled and its name changes after 2 s (for example `15分00秒` to `14分58秒`). `登录邮箱` is disabled. Evidence: `05-locked.png`, `05-locked.aria.yml`. `06-lock-counter.sql.txt` shows `hzx014@example.com | 5 | t`.
- **Correct password while locked.** Run `$S/api.sh login hzx014@example.com locked`. Step `locked-correct-password`. The response is `429 ACCOUNT_LOCKED`. Evidence: `07-locked-correct-password.http`.
- **Emergency unlock.** Run `$S/with-env.sh pnpm --filter @fs-billing/api auth:unlock hzx014@example.com`. Step `emergency-unlock`. Output `解除锁定计数 1 行` (`08-auth-unlock.cli.txt`). `09-counter-after-unlock.sql.txt` shows `counter_rows 0`. After a reload and a correct login, the URL is `/` and the page shows `HZX014 · 杭州星讯通信有限公司` (`10-after-unlock.png`).
- **Disabled account.** On `/login`, submit `cdt018@example.com` with the seeded password. Step `disabled`. The response is `403 ACCOUNT_DISABLED`, and the alert contains `该账号已停用` and `如需恢复使用，请联系客服` (`11-disabled.png`). `12-disabled-state.sql.txt` shows `CDT018 | disabled | 0` sessions.

## Gotchas

- The lock engages on the fifth failure itself (429 on attempt 5), not on a sixth try. A loop that expects five 401s fails.
- The UI countdown is computed in the browser from `retryAfterSeconds` at response time. Assert that it changes, not an exact second, because the label can read `15分00秒` or `14分59秒`.
- The `auth:unlock` CLI loads the root `.env`. It reaches our container only because `with-env.sh` exports `DATABASE_URL` first, and exported variables win over `.env`. Running it bare unlocks the user's dev DB instead.
- Unknown emails also get counter rows: the API reserves before checking. Clean them up with `auth:unlock` so later runs start clean, as the journey does.
- The API's 30/min/IP credential limit returns `429 RATE_LIMITED` with the alert `请求过于频繁`. That is a different alert from the lock. If you see it, wait a minute and rerun. Do not count it as lockout proof.
- Stale counters expire after 15 minutes through a 1-minute background cleanup. A rerun soon after a failed run may be BLOCKED until you unlock.
- No admin profile is seeded as disabled, so the admin copy `该管理员账号已停用` cannot be shown without changing data. The journey covers the portal copy only. Report the admin variant as not covered.
