---
name: verify-fs-billing
description: Launch and drive FS-Billing (React web portal + admin shell in apps/web, Fastify API with Better Auth in apps/api, Postgres) the way a user does, on an isolated throwaway stack, and capture proof (screenshots, ARIA snapshots, HTTP transcripts, SQL rows). Use to prove login, lockout, session expiry, logout, tenant isolation, theme/mobile, and 404 behavior end to end, or to check a change in the real app instead of unit tests. Also says how to run the separate FreeSWITCH/SIPp e2e surface.
---

# Verify FS-Billing

FS-Billing is a call-billing system. Its user surface is the web app: a customer portal (`/`, `/login`) and an admin shell (`/admin`, `/admin/login`). Both are served by `apps/web` (Vite + React) and call `apps/api` (Fastify + Better Auth) over `/api`. Postgres stores business rows under RLS and the `auth.*` schema. Secondary surfaces:

- **HTTP API.** Driven with `scripts/api.sh`. The contract is `packages/shared/src/api/contract.ts`.
- **Auth CLIs.** `auth:seed`, `auth:unlock`, and `auth:bootstrap` in `apps/api` (`docs/phase-4-api.md`). Run them through `scripts/with-env.sh`.
- **FreeSWITCH/SIPp e2e.** `freeswitch/test/run-integration.sh`. It has no UI and the browser harness does not drive it. See [features/freeswitch-sipp.md](features/freeswitch-sipp.md).
- **Worker** (`apps/worker`). Not started by this skill. The SIPp e2e covers it.

The feature map in [features/README.md](features/README.md) is the source for what to verify and how. Read it before you drive anything.

All commands run from the repo root, with `S=.cursor/skills/verify-fs-billing/scripts`.

## Isolation rules (read first)

- The user's dev Postgres container `fs-billing-postgres-1` runs on `127.0.0.1:5432`. **Never touch it or its databases.** `sql.sh` and `cleanup.sh` refuse to act on it, and every helper acts only on the container labelled `fs-billing-verify=<RUN_ID>`.
- The root `.env` points at `:5432`, and every pnpm script loads it with `--env-file-if-exists`. Node never lets a `.env` value override a variable that is already exported. `launch.sh` and `with-env.sh` export every DB, auth, and port variable, so repo commands reach the run's container. Never run `pnpm db:*`, `auth:*`, or `test:*` bare in this skill. Always prefix them with `$S/with-env.sh`.
- Do not use `apps/web/e2e` (`pnpm test:e2e`) for verification. It hard-codes ports 3000/4173 and reuses whatever server is already there.
- Every run gets its own container, free ports, secrets, and evidence dir, so two runs can coexist. The SIPp e2e is the exception: it uses fixed host-network ports.

## Launch

```sh
S=.cursor/skills/verify-fs-billing/scripts
$S/launch.sh            # about 10 s; the last line printed is the RUN_ID
```

From an empty database, `launch.sh` does the following:

1. It picks a `RUN_ID` (`YYYYMMDDTHHMMSSZ-xxxxxx`) and creates the state dir `/tmp/verify-fs-billing/<RUN_ID>/` (mode 700). It records the run as current in `/tmp/verify-fs-billing/current`.
2. It writes throwaway secrets (owner/app/auth DB passwords, `BETTER_AUTH_SECRET`, `SEED_AUTH_PASSWORD`) to `run.env` (mode 600). It never prints them.
3. It starts `docker run postgres:17.9-alpine` as `fsb-verify-<RUN_ID>`, with label `fs-billing-verify=<RUN_ID>`, a free `127.0.0.1` port, and tmpfs data. It waits until TCP `pg_isready` answers, which happens only after image init finishes.
4. It runs migrate, seed, and migrate again to check idempotence (`packages/db/src/bin/*.ts` via `tsx`), then `apps/api/scripts/seed-auth.ts` (`auth:seed`). Every seeded account gets `SEED_AUTH_PASSWORD`.
5. It starts the API (`node --import tsx src/main.ts`) under `setsid` on a free port. `BETTER_AUTH_URL` is set to the API origin, and `BETTER_AUTH_TRUSTED_ORIGINS` to the API and web origins.
6. It runs `vite build --outDir <state>/web-dist`, so `apps/web/dist` is never touched. Then it starts `vite preview --strictPort` under `setsid` on a free port, with `FS_BILLING_API_ORIGIN` set so `/api` proxies to this run's API.
7. **Ready** means a real `POST /api/auth/login` as `bjh003@example.com` through the web origin returns 200 with `"kind":"customer"` and `"email":"bjh003@example.com"`, and the logout that follows returns 204. Both transcripts are saved to `docs/evidence/verify-fs-billing/<RUN_ID>/launch/ready-login.http`. This is the stack's only login check outside the journeys.

It prints `READY` with the web, API, and Postgres addresses. If it fails, it prints the cleanup command to run for that `RUN_ID`. Prerequisites: Docker, Node 22/24, pnpm 10.34.7, `pnpm install --frozen-lockfile` already done, Playwright Chromium (`pnpm --filter @fs-billing/web exec playwright install chromium` if missing), `ss`, and `python3`.

To work on an older run, set `VERIFY_RUN_ID=<id>` in front of any helper. Otherwise the helpers use the run in `/tmp/verify-fs-billing/current`.

## Doctor

```sh
$S/doctor.sh            # exit 0 = healthy, 1 = at least one FAIL line
```

Doctor prints one `OK` or `FAIL` line per check:

- The container is running and is ours: id, label, and port all match. If it is not, doctor does not query the database at all.
- The API and web PIDs are alive and carry `VERIFY_RUN_ID=<RUN_ID>` in `/proc/<pid>/environ`. The listener on each port belongs to that process group.
- The git HEAD equals the revision recorded at launch. If HEAD moved, relaunch.
- Applied migrations equal the entries in `packages/db/migrations/meta/_journal.json`. Tenants and credentials exist. The query goes through `sql.sh`, which repeats the container guards.
- `/api/health` returns `{"status":"ok","service":"api"}`.
- The web serves the built `index.html`, and `/api` proxies to our API.

Doctor is read-only. It sends no login, writes no row, and creates no file, so it is safe to run at any time and never uses up the credential rate limit. Launch's ready check is the login proof. Run doctor first, and again whenever something looks wrong. Do not drive a run that fails doctor.

## Drive

The browser harness is Playwright (`@playwright/test` 1.64 from `apps/web` devDependencies). `drive.mjs` resolves it from there:

```sh
$S/drive.mjs customer-login          # or: admin-login login-errors session-expiry cross-tenant logout theme-and-mobile not-found
$S/drive.mjs customer-login --headed # watch it
$S/drive.mjs all                     # every feature in order, one child process each, then a summary table
```

Before it opens a browser, each journey waits until 61 s have passed since the run's last credential request (see [Gotchas](#gotchas)). It prints `waiting N s for the API's credential rate-limit window (30/min/IP) to reset` when it does. Expect `all` to spend up to a minute per feature on these waits.

Each journey runs headless Chromium (`locale zh-CN`, `Asia/Shanghai`) against the run's web origin. It prints a step table and exits `0` on PASS, `1` on FAIL, or `2` on BLOCKED (precondition missing; the reason is printed). Journeys use only ARIA roles and names taken from `apps/web/src`:

| UI                     | Handle                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login form             | `getByLabel('登录邮箱')`, `getByLabel('密码', { exact: true })`, `getByRole('button', { name: '登录', exact: true })`                                                                                         |
| Login headings         | portal `heading '登录'`, admin `heading '登录管理后台'`; admin page also shows `客户请使用客户门户登录`                                                                                                       |
| Login problems         | `getByRole('alert')`: `登录邮箱或密码错误` / `请检查后重新输入`; `登录失败次数过多，已暂时锁定` + `请在 M分SS秒 后重试` (also the disabled submit button's name); `该账号已停用` / `如需恢复使用，请联系客服` |
| Expired banner         | `getByRole('status')`: `登录已过期，请重新登录` · `登录后将返回之前的页面` (on `?reason=expired`)                                                                                                             |
| Expired dialog         | `getByRole('dialog', { name: '登录已过期，请重新登录' })` → `button '重新登录'`                                                                                                                               |
| Portal home            | `heading '首页'`, crumb text `ABC001 · 深圳市某某科技有限公司`, `getByRole('region', { name: '当前余额' })` → `-¥35.20`                                                                                       |
| Admin home             | `heading '概览'`, text `欢迎，王敏。…`, `html[data-product=admin]`                                                                                                                                            |
| Shell (desktop)        | `button '主题'` (◐) → `menuitemradio '浅色' / '深色' / '跟随系统'`; `button '账号菜单'` → `menu` → `menuitem '退出登录'`; `navigation '主导航'`                                                               |
| Shell (mobile < 768px) | `button '打开导航'` → `dialog '导航'`; `button '账号菜单'` → `dialog '账号菜单'` with `radiogroup '主题'` and `button '退出登录'`                                                                             |
| 404                    | `heading '找不到这个页面'`, `link '返回首页'`; admin, in the shell: `返回首页即回到「概览」`                                                                                                                  |

Theme state is `html[data-theme]` plus `localStorage['fs-billing.theme']`. The zone is `html[data-product]`.

HTTP goes through the web origin's `/api` proxy, the same path the browser uses. `api.sh` sends `Origin: <web origin>`, which the API requires on POST:

```sh
$S/api.sh login abc001@example.com a            # seeded password, cookie jar "a"
$S/api.sh login abc001@example.com x --wrong    # fixed wrong password
$S/api.sh GET /api/portal/context a
$S/api.sh POST /api/auth/logout a
$S/api.sh POST /api/admin/portal-accounts/<uuid>/reset-password a
VERIFY_API_BASE=api $S/api.sh GET /api/health  # hit the API origin directly
```

Database access always goes into OUR container through `docker exec`, as the owner role:

```sh
$S/sql.sh "SELECT email_key, failed_count, locked_until FROM auth.login_failures"
$S/sql.sh --value "SELECT count(*) FROM auth.session"   # bare value, for scripts
$S/sql.sh < some.sql
```

Repo CLIs run with the run's environment through `with-env.sh`, which also redacts their output:

```sh
$S/with-env.sh pnpm --filter @fs-billing/api auth:unlock hzx014@example.com   # emergency unlock
$S/with-env.sh pnpm test:idor                                                # IDOR suite, scratch fs_billing_test DB in our container
$S/with-env.sh pnpm --filter @fs-billing/api auth:bootstrap --kind portal --profile <portal-profile-uuid> --replace < /path/to/password-file
```

`auth:bootstrap --generate` prints a new password once, and `with-env.sh` cannot redact a value it does not know. If you use `--generate`, redirect its output into the state dir, not into evidence.

Seeded accounts (from `packages/db/src/seed.ts`; all use `SEED_AUTH_PASSWORD`):

| Account               | Role in journeys                           |
| --------------------- | ------------------------------------------ |
| `abc001@example.com`  | ABC001, CNY, balance −35.20: main customer |
| `glb009@example.com`  | GLB009, USD, −15.02: second tenant (B)     |
| `hzx014@example.com`  | HZX014: lockout target                     |
| `cdt018@example.com`  | CDT018: tenant `disabled`                  |
| `wangmin@example.com` | admin 王敏                                 |
| `lijun@example.com`   | admin 李俊: session revocation             |
| `bjh003@example.com`  | reserved for launch and doctor             |

## Evidence

Evidence goes to `docs/evidence/verify-fs-billing/<RUN_ID>/<feature-id>/`. Cleanup never deletes it.

- `steps.md` and `result.json`: each step's action, PASS/FAIL/BLOCKED, and the observed detail.
- `sNN-<step>-before` and `sNN-<step>-after` (`.png` full-page screenshot and `.aria.yml` Playwright `ariaSnapshot`): taken automatically around every step, of the page the journey last opened or acted on. A step that drives only HTTP has no page to capture; its proof is the `.http` transcript.
- `NN-name.png` and `NN-name.aria.yml`: named captures of the states a feature file cites, such as `05-locked`.
- `browser-http.txt`: every `/api/*` response the browser saw, with the request body, status, and JSON body. Credential fields are `[REDACTED]`. `NN-name.http` holds the curl transcripts from `api.sh`.
- `NN-name.sql.txt`: the query and its rows from our container. `NN-name.cli.txt`: CLI commands and their output.
- `launch/ready-login.http` and, after cleanup, `logs/` (`*.log.txt`: api, web, build, db-setup, and auth-seed logs, redacted) plus `revision.txt`.

No evidence file ends in `.log`, because the repo's `.gitignore` ignores `*.log`. Every file the helpers write is committable as is: `git add docs/evidence/verify-fs-billing/<RUN_ID>` picks up all of it. Check with `git status --ignored --short docs/evidence/verify-fs-billing/<RUN_ID>`, which must list no `!!` entries.

Every file written into evidence passes through redaction. Secret values from `run.env` become `[REDACTED]`, and so do `session_token=` cookie values and the JSON fields `password`, `currentPassword`, `newPassword`, `temporaryPassword`, `token`, and `secret`. The JSON rule covers values the run never knew, such as the temporary password a real reset returns. It matches across lines, so pretty-printed JSON with the key, colon, and value on separate lines is redacted too, and it handles escaped quotes inside the value. Never paste `run.env` or a raw cookie into evidence by hand.

After you change `verify_redact` in `lib.sh`, run `$S/selftest-redact.sh`. It needs no stack. It feeds synthetic single-line, multi-line, and escaped-quote cases through the redaction and exits 1 if any value survives or any output differs from the expected text.

`cleanup.sh` scans the evidence for every `run.env` secret before it deletes the state, and fails, keeping the state, if any file matches. It prints file names only. To scan by hand while the run is live, use `-l` so a hit shows the file and never the secret:

```sh
grep -rlF -e "$(grep ^SEED_AUTH_PASSWORD= /tmp/verify-fs-billing/<RUN_ID>/run.env | cut -d= -f2)" docs/evidence/verify-fs-billing/<RUN_ID>   # must print nothing
```

Proof standards:

- **Real user path.** Use the login form, menus, and links in the built app, through the same `/api` proxy. No test-only endpoints, internal setters, or seeded cookies. The API has no test hooks, and the raw Better Auth router is not mounted.
- **Action and resulting state.** Capture the screen before and after, plus the HTTP status and error `code` behind what the UI shows.
- **Side effects in rows.** Check `auth.session` (created on login, deleted on logout and revocation, none kept for disabled accounts), `auth.login_failures` (`failed_count`, `locked_until`, deleted by unlock or a successful login), `auth.account.updated_at` (unchanged by a forbidden reset), `operation_logs`, and `tenant_balances`.
- **DB edits stand in for elapsed time or an operator action.** Setting `auth.session.expires_at` into the past stands in for seven days passing. Deleting session rows is what an admin reset or `--replace` bootstrap does. Each such edit is saved as its own `.sql.txt`, and every journey says so. Never edit DB rows to make an assertion pass.
- **Mocks only at real production boundaries.** This skill mocks nothing. React Query's tab-refocus refetch is triggered with a `visibilitychange` event, the only synthetic browser event in use. It stands in for the user switching tabs, which headless Chromium cannot do.
- **Dry runs.** None of these flows has a dry-run mode. `auth:unlock` really deletes the counter row, and `auth:bootstrap --replace` really revokes sessions. Before you trust any `--dry-run` or "safe" mode added later, prove what it skips with `sql.sh` before and after.
- **Blocked is not passed.** If a precondition is missing (an account locked, seed changed), the journey exits 2 with the reason. Report it as BLOCKED, and never edit the journey to get around it.

## Cleanup

```sh
$S/cleanup.sh                           # current run
VERIFY_RUN_ID=<id> $S/cleanup.sh        # a specific run
```

`cleanup.sh` does the following:

- It sends TERM, then KILL after 5 s, to the API and web process groups recorded in `api.pid` and `web.pid`. It does this only while each PID still carries this run's `VERIFY_RUN_ID`. It never kills by name or port. A group that survives KILL is a failure.
- It runs `docker rm -f` on the recorded container id, and only if the id carries label `fs-billing-verify=<RUN_ID>`, then confirms the container is gone. A container is treated as gone only when `docker inspect` reports `No such object`. Any other inspect error, such as the daemon being down or permission denied, is a failure, because the container may still exist. A failed removal, or an id with another label, is also a failure.
- It copies redacted logs to `<evidence>/logs/` as `*.log.txt`, then runs the leak scan above.
- Only if every step succeeded does it delete `/tmp/verify-fs-billing/<RUN_ID>/` (secrets, cookie jars, web build) and print `evidence kept: <dir> (<n> files)`. Otherwise it prints each failure, keeps the state so you can fix the cause and rerun it, and exits 1.

Run cleanup after every run, including failed launches. Confirm with `ls docs/evidence/verify-fs-billing/<RUN_ID>/` and `docker ps --filter label=fs-billing-verify`.

Commit evidence only when a PR needs the proof. Every file is committable (see [Evidence](#evidence)).

## Helpers

| Script               | Invocation                                                                           | Purpose                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `launch.sh`          | `$S/launch.sh`                                                                       | Isolated stack from an empty DB; prints RUN_ID                                                     |
| `doctor.sh`          | `$S/doctor.sh`                                                                       | Read-only health and ownership check (no login, no writes)                                         |
| `drive.mjs`          | `$S/drive.mjs <feature\|all> [--headed]`                                             | Playwright journey and evidence for one feature, or all in turn                                    |
| `browser-fns.mjs`    | imported by `drive.mjs`                                                              | `page.evaluate` callbacks; the only script linted with browser globals                             |
| `api.sh`             | `$S/api.sh login <email> <jar> [--wrong]` / `$S/api.sh <METHOD> <PATH> [jar] [json]` | Redacted HTTP transcript via the web proxy                                                         |
| `sql.sh`             | `$S/sql.sh [--value] "<sql>"` / `$S/sql.sh < file.sql`                               | psql as owner in OUR container only                                                                |
| `with-env.sh`        | `$S/with-env.sh <command...>`                                                        | Repo CLI with the run's env, output redacted                                                       |
| `selftest-redact.sh` | `$S/selftest-redact.sh`                                                              | Offline self-test of `verify_redact`; exit 1 on any leak                                           |
| `cleanup.sh`         | `$S/cleanup.sh`                                                                      | Kill our process groups, remove our container, keep evidence; exit 1 and keep state on any failure |
| `lib.sh`             | sourced                                                                              | Run resolution, redaction, leak scan, ownership checks                                             |

Typical loop:

```sh
S=.cursor/skills/verify-fs-billing/scripts
RUN_ID=$($S/launch.sh | tail -n1)
$S/doctor.sh
$S/drive.mjs customer-login    # or: $S/drive.mjs all
$S/cleanup.sh
ls docs/evidence/verify-fs-billing/$RUN_ID/customer-login
```

## Gotchas

- **Credential rate limit.** `POST /api/auth/login` and `/api/auth/change-password` allow 30 requests per minute per client IP, in a fixed window that opens at the first request. Every browser and `api.sh` request in a run comes from `127.0.0.1`, so they all share one budget. Running features back to back used to hit it: `not-found` got `429 RATE_LIMITED` right after `login-errors`. Each journey now waits until 61 s have passed since the run's last credential request, which `api.sh` and `drive.mjs` record in the state dir. If you send logins by hand between journeys, they count too, and the next journey waits for them. Never raise or disable the API's limit to make a run pass. A `429 RATE_LIMITED` in a journey means the wait was bypassed; wait a minute and rerun that feature.
- **Doctor is read-only on purpose.** Do not add a login to it. A login uses up the rate-limit budget and writes a session row. Launch's ready check already proves login and logout.

Keep the map honest as the app grows: run `/maintain-verification-skill`.
