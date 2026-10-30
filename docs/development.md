# 开发指南

本文档收录开发环境、命令、数据库与租户隔离、金额保护、CI 和运行验证的细节。快速开始见 [README](../README.md)。

## 开发环境

- Node.js 24.22.1（`.node-version`；仅支持 Node 24）。
- pnpm 10.34.7（`package.json` 的 `packageManager` 固定版本）。用 `corepack enable` 激活。
- Docker 引擎与 Docker Compose v2。执行前启动 Docker Desktop 或 OrbStack。

首次启动按顺序执行：

```sh
corepack enable
pnpm install
cp .env.example .env
pnpm dev:setup
pnpm db:migrate
pnpm db:seed
SEED_AUTH_PASSWORD=<开发密码> pnpm --filter @fs-billing/api auth:seed
pnpm --filter @fs-billing/worker queue:migrate
pnpm dev
```

`pnpm dev:setup` 执行 `pnpm check` 并启动 PostgreSQL。`auth:seed` 为种子账号设置登录密码，已有密码保持不变，账号邮箱见 `packages/db/src/seed.ts`。`pnpm dev` 同时启动 Web、API 和 Worker。

| 服务       | 地址                               | 验证                                      |
| ---------- | ---------------------------------- | ----------------------------------------- |
| 客户门户   | http://127.0.0.1:5173/login        | 用门户种子账号登录后进入门户首页          |
| 管理后台   | http://127.0.0.1:5173/admin/login  | 用管理员种子账号登录后进入后台首页        |
| API        | http://127.0.0.1:3000/api/health   | 返回 `{"status":"ok","service":"api"}`    |
| Worker     | http://127.0.0.1:3001/health       | 返回 `{"status":"ok","service":"worker"}` |
| PostgreSQL | 127.0.0.1:5432                     | `docker compose ps` 显示 healthy          |
| Mailpit    | http://127.0.0.1:8025（SMTP 1025） | `docker compose ps` 显示 healthy          |

Web 开发服务器把 `/api` 代理到 `FS_BILLING_API_ORIGIN`，缺省为 `http://127.0.0.1:3000`。API 校验 POST 请求的 Origin，所以 `.env` 的 `BETTER_AUTH_TRUSTED_ORIGINS` 必须包含 Web 的地址。健康接口不检查数据库。Worker 的授权、话单与扣费接口见 [Worker 接口](worker-api.md)，FreeSWITCH 侧配置见 [FreeSWITCH 配置](../freeswitch/README.md)。

数据库数据保存在 Docker 命名卷中。`pnpm db:down` 停止 PostgreSQL 与 Mailpit 并保留数据。

### 邮件（阶段 9）

`pnpm db:up` 同时启动 Mailpit（`axllent/mailpit`，固定版本见 `compose.yaml`）：SMTP 在 `127.0.0.1:1025`，网页收件箱与 HTTP API 在 `http://127.0.0.1:8025`。`.env.example` 里的 `SMTP_HOST=127.0.0.1`、`SMTP_PORT=1025`、`SMTP_SECURE=false`、`MAIL_FROM=billing@example.test` 就指向它，复制成 `.env` 后 Worker 发出的邮件都落在 Mailpit，不会发到外面。

| 键                                         | 默认      | 说明                                                                                               |
| ------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------- |
| `SMTP_HOST`                                | 无        | 不设置则邮件发送未启用：发件箱照常入队，Worker 启动时告警                                          |
| `SMTP_PORT`、`SMTP_SECURE`                 | 465、true | `true` 隐式 TLS（465）；`false` 为 STARTTLS，只有回环地址（Mailpit）允许不加密                     |
| `SMTP_USER`、`SMTP_PASS`                   | 无        | 同有或同无；非回环主机必须认证。QQ 邮箱的 `SMTP_PASS` 是授权码；只放运行环境，不进仓库、日志、文档 |
| `MAIL_FROM`                                | 无        | 设置了 `SMTP_HOST` 就必填；QQ 邮箱要求与 `SMTP_USER` 相同                                          |
| `SMTP_TIMEOUT_MS`、`MAIL_RATE_PER_MINUTE`  | 15000、20 | 连接/问候/套接字超时；每次分发（每分钟）最多发送封数                                               |
| `MAIL_MAX_ATTEMPTS`、`ALERT_QUIET_MINUTES` | 6、10     | 单封最多尝试次数（退避 1 分、5 分、15 分、1 小时、3 小时）；事件型告警的静默恢复窗口               |
| `APP_PUBLIC_URL`                           | 无        | 邮件里链接的站点根地址（`https://…`，本机回环可用 `http://`）                                      |

- `pnpm --filter @fs-billing/worker mail:test -- --to <地址>`：用当前 `SMTP_*` 直接发一封测试邮件并打印响应码，不经过发件箱（核实 SMTP 配置，真实 QQ 账号的核实步骤见 [运行手册](evidence/phase-9/qq-smtp-check.md)）。
- `pnpm --filter @fs-billing/worker mail:requeue -- --id <uuid>` 或 `--since <时间>`：把 `failed` 的邮件放回待发（额度恢复后补发）。
- **`pnpm test:db` 需要 Mailpit 在运行**（`pnpm db:up`）：邮件测试经 Mailpit 的 HTTP API 断言收到的邮件。测试只认 `MAILPIT_SMTP_HOST`、`MAILPIT_SMTP_PORT`、`MAILPIT_API_URL`（默认就是 compose 的端口，且必须是回环地址），**不读 `SMTP_*`**，所以 `.env` 里是真实邮箱也不会被测试用到。
- 新增队列后（阶段 9 的 `notify-tick`）要重新执行 `pnpm --filter @fs-billing/worker queue:migrate`。

### Worker 日志与脱敏（阶段 9）

Worker 与 API 的日志只写标准输出，部署后由 systemd journal 保存，不上传外部日志服务。客户的被叫号码是个人信息，日志里只留掩码和结构性字段，完整号码留在数据库。

- **号码掩码**（`packages/db/src/log-safe.ts` 的 `maskNumber`，Worker 的 `redact.ts` 重新导出）：保留 `+` 前缀，其余保留前 4 位和后 2 位，中间以 `*` 代替，括号里附总长度（不含 `+`）；长度 ≤ 6 的整体替换为 `*` 加长度。`8613800138000` 记成 `8613*******00(13)`，`+447700900123` 记成 `+4477******23(12)`，`12345` 记成 `*(5)`。
- **「授权计费号码不一致」日志**只含 `uuid`、`tenant`、四个号码的掩码（`dialedNumber`、`callee`、`luaBillingNumber`、`billingNumber`），以及对比字段：`calleeEqualsWorker`、`luaEqualsWorker`（Lua 送来的被叫、计费号码是否等于 Worker 按原拨号算出的计费号码，也就是 `resolveBillingNumber` 做的两个比较）、`shapes`（各号码的长度、是否以 `+` 或 `00` 开头）和 `reason`（`callee-differs`、`only-lua-differs`，两者都没有证据时 `unknown`）。排查 Lua 与 Worker 的归一化差异靠这些字段和 `freeswitch/tests/dialed-cases.tsv`；要完整号码，从后台查对应话单（`unassigned_cdrs`、`raw_cdrs`，受 RLS 与后台权限保护）。
- **API 请求 URL**（`apps/api/src/logging.ts` 的 `req` 序列化器，阶段 9 PR 8）：话单搜索的 `callee` 等查询参数会带客户号码。参数名是号码类（`callee`、`caller`、`dialed`、`number`、`phone`，不分大小写），或取值像号码（可选 `+`，至少 7 位数字，日期除外）时，整个值按同一条 `maskNumber` 规则掩码，其余参数、路径与顺序不变（`redactUrlForLog`）。请求头与正文不写进日志。目前 `app.ts` 关闭了请求日志，这是防线。
- **pino `redact`**（`createWorkerLogger`）：`req.headers["x-billing-key"]`、`req.headers.authorization`，以及数据库错误的 `err.detail`（含一层、两层 `cause`）。PostgreSQL 唯一冲突的 `detail` 形如 `Key (…)=(…)`，可能带号码或邮箱。
- **数据库错误序列化**（`scrubErrorForLog`，Worker 与 API 的日志器都用）：drizzle 把失败的查询包成 `DrizzleQueryError`，`message`/`stack` 里带 `\nparams: …`（绑定的实参，话单入库绑的是原始 CDR 正文和被叫），对象上还有 `query`、`params`。序列化时去掉 `params`、`query`、`detail`、`where`（含各层 `cause`），并截掉 `message`/`stack` 里 `\nparams:` 之后的内容；PostgreSQL 错误码、约束、表由调用处用 `postgresErrorFields` 单独记。PostgreSQL 自己写进错误 `message` 的值（例如 `invalid input syntax for type integer: "…"`）无法通用地去掉，所以绑定到号码的查询不要用会回显值的写法。
- **掩码的强度**：保留前 4 位和后 2 位意味着 7 至 9 位的号码只隐藏 1 至 3 位，这类短号码实际上几乎没有被掩码；决定 37 接受这一点（国际号码通常 10 位以上）。若要更严格，改为日志完全不含号码，只留 UUID、租户、长度和对比字段。
- **访问与保留（部署项，阶段 10 落实，本阶段不改服务器配置）**：日志保留 14 天（`journald.conf` 的 `MaxRetentionSec=14day`），只有 root 与运维组可读（journal 目录权限，运维账号放进 `systemd-journal` 组），不转发到外部服务。已记入[阶段 10 清单](plan.md#阶段-10部署与上线)。

### 真实 cron 与多实例测试（阶段 9）

`pnpm test:db` 里有两个文件要等真实时钟：`apps/worker/src/cron.db.test.ts`（不调用 `boss.send`，等 `notify-tick` 的 `* * * * *` 越过一个分钟边界自己触发；为控制 CI 时间只等一个边界）和 `apps/worker/src/multi-instance.db.test.ts`（两个 `PgBoss` 实例同库同队列：扣费任务、`supervise`、发件箱、`exclusive` 队列、真实分钟的调度）。两者合计约 2 至 3 分钟，其中等待时间取决于启动时刻距下一个分钟边界的远近（pg-boss 每 30 秒检查一次调度）。等待用带上限的轮询，上限 150 秒，不用固定 sleep；「恰好执行一次」靠任务 id（处理函数记下每个任务的 id，在没有排队/执行中/待重试的任务之后核对），不靠计时；这两个文件的测试自带超时（240 秒），不改 `vitest.db.config.ts` 的全局 `testTimeout`。只想跑别的文件时用 `pnpm test:db -- <文件>`。

## 常用命令

| 命令                                                                               | 作用                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`                                                                       | lint、格式检查、类型检查、单元测试和 Web 构建，与 CI 的 `check` job 一致                                                                                                 |
| `pnpm test`                                                                        | 单元测试，不连接数据库                                                                                                                                                   |
| `pnpm test:db`                                                                     | 在全新的 `fs_billing_test` 库上迁移、写种子并运行数据库验收测试。需要先 `pnpm db:up`（PostgreSQL 与 Mailpit）                                                            |
| `pnpm test:idor`                                                                   | 只运行越权测试：用租户 A 的账号访问 OpenAPI 中每个客户端点的 B 租户数据，必须全部失败                                                                                    |
| `pnpm test:e2e`                                                                    | Playwright e2e，启动真实 API 和 Web，连接真实 PostgreSQL。需要已迁移、写种子的库和 `SEED_AUTH_PASSWORD`                                                                  |
| `pnpm coverage`                                                                    | 计费核心 `packages/rating` 的覆盖率，行覆盖率低于 95% 时失败                                                                                                             |
| `pnpm build`                                                                       | 编译所有包和服务，构建网页                                                                                                                                               |
| `pnpm format`                                                                      | 自动格式化。已确认的设计稿和原始规划文档不参与格式化                                                                                                                     |
| `pnpm db:migrate`                                                                  | 以 `DATABASE_URL`（owner）执行未应用的迁移，设置应用角色密码，建当月与下月话单分区。可重复执行                                                                           |
| `pnpm db:seed`                                                                     | 写入与设计稿一致的示例数据（ABC001、GZT007 等 10 个租户，ABC001 余额 −35.20；阶段 9 起另有 5 条示例系统告警与合计 ¥6,300.00 / $1,700.00 的待收款，不排邮件）。可重复执行 |
| `pnpm screenshots`                                                                 | 截取登录页和 404 的实现与设计稿画框，写入 `docs/evidence/phase-4-web/screenshots/`                                                                                       |
| `pnpm --filter @fs-billing/worker raw:restore -- --id <uuid> --received-at <时间>` | 只读取回一条已归档的原始 JSON，核对哈希后把原文字节原样写到标准输出（阶段 8，见 [Worker 接口](worker-api.md#原始-json-归档阶段-8)）                                      |
| `pnpm --filter @fs-billing/worker mail:test -- --to <地址>`                        | 用当前 `SMTP_*` 直接发一封测试邮件（阶段 9，见上面的「邮件」）                                                                                                           |
| `pnpm --filter @fs-billing/worker mail:requeue -- --id <uuid>`                     | 把 `failed` 的邮件放回待发；也可用 `--since <时间>`                                                                                                                      |
| `pnpm --filter @fs-billing/worker raw:restore-month -- --month <YYYY-MM>`          | 整月恢复已归档的 `raw_cdrs` 分区（宽限期内挂回，已丢弃则从归档文件重建）                                                                                                 |

阶段 9 的概览、系统告警与月账单视觉对照（宽度 1440、1024、768、390，浅色与深色）用 `FSB_VISUAL=1 pnpm --filter @fs-billing/web exec playwright test e2e/admin-alerts-visual.spec.ts` 生成（环境同 `pnpm test:e2e`，库要是刚迁移、刚播种的），对照图写入 `docs/evidence/phase-9-web/visual/`，差异清单见 `docs/evidence/phase-9-web/visual-diff.md`。

客户门户首页的视觉对照用 `FSB_VISUAL=1 pnpm --filter @fs-billing/web exec playwright test e2e/portal-visual.spec.ts` 生成（环境同上），对照图写入 `docs/evidence/phase-6-web/visual/`，差异清单见 `docs/evidence/phase-6-web/visual-diff.md`。

管理后台的视觉对照用 `FSB_VISUAL=1 FSB_EVIDENCE_DIR=$PWD/docs/evidence/phase-5-web pnpm --filter @fs-billing/web exec playwright test e2e/admin-visual.spec.ts` 生成，需要与 `pnpm test:e2e` 相同的库和 `SEED_AUTH_PASSWORD`。对照图写入 `docs/evidence/phase-5-web/visual/`，差异清单见 `visual-diff.md`。

服务目前用 `pnpm --filter @fs-billing/api start` 和 `pnpm --filter @fs-billing/worker start` 直接运行 TS 源码，生产打包在阶段 10 完成。

## 数据库与租户隔离

应用运行时用 `APP_DATABASE_URL` 连接。角色 `fs_billing_app` 不是超级用户，也没有 BYPASSRLS。代码在事务内用 `withTenant(db, tenantId, fn)` 或 `withAdmin(db, fn)` 声明身份，未声明时读不到任何业务行。API 只从登录身份取租户编号，不信任请求里的租户参数。登录相关的表放在单独的 `auth` schema，用 `AUTH_DATABASE_URL` 连接。

迁移是 `packages/db/migrations/` 下的手写 SQL，`packages/db/src/schema.ts` 是对应的 Drizzle 描述。表结构、账本不变量和费率版本规则见 [阶段 2 验收记录](phase-2-db.md)，API 与登录的设计见 [阶段 4 后端设计](phase-4-api-design.md)。运维人工查操作日志用只读角色 `fs_billing_audit` 和 `audit_operation_logs(...)`，手动授权后用 `audit_role_violations()` 复查，见 [阶段 5 设计](phase-5-design.md) 的「运维审计查询（决定 f）」。

## 金额保护

`packages/rating`、`packages/db`、`apps/worker` 和 `apps/web/src` 启用 ESLint 规则 `money/no-number-money`。规则禁止对金额名称（fee、rate、amount、balance 等）、金额变量的本地别名以及小数输入做原生算术、自增自减和复合赋值，金额的 `Math`、`Number`、`parseFloat`、`parseInt` 调用也会报错。时长、端口等普通整数运算不受影响。

```ts
// ESLint 报错：money/no-number-money
const fee = 0.1 * 3;

// 正确：通过字符串进入 decimal.js
const fee = decimal('0.1').mul('3');
```

这条规则是保守的静态检查，不能证明跨函数或外部数据一定具有金额语义。金额要保持明确命名，用字符串和 Decimal 传递。`Money<Currency>` 与 `Rate<Currency>` 品牌类型让不同币种相加在类型检查阶段报错。不要把金额改名或转成 number 来绕开规则。

## CI

`ci.yml` 在推送到 `main`、PR 和手动触发时运行，分支上的提交通过 PR 运行一次。只改动 `design/` 或 `docs/evidence/` 下的 png、txt、diff 文件时跳过。

- `check` job：`pnpm check`、`pnpm coverage`、构建、浮点金额拒绝实验、CNY+USD 类型拒绝实验、空库上 `pnpm db:migrate && pnpm db:seed && pnpm db:migrate`、`pnpm test:db`，以及实时 OpenAPI 越权证明。
- `web-e2e` job：启动 PostgreSQL、迁移并写种子，运行 `pnpm test:e2e`。

`freeswitch.yml` 在 `freeswitch/`、`apps/worker/`、`packages/` 有改动时运行 FreeSWITCH 集成测试，另有每日定时运行。

PR 描述列出验收证据，CI 通过后 squash 合并到 `main`。

## 运行验证

两套验证技能提供进程归属检查、真实 HTTP 与浏览器验证，以及清理步骤：

- [verify 技能](../apps/web/.agents/skills/verify/SKILL.md) 覆盖阶段 0–3。[功能图](../apps/web/.agents/skills/verify/features/README.md) 列出可验证的路径，包括 Worker 授权、话单入库、扣费任务和数据库账本。证据默认保存在 `artifacts/verify/`。
- [verify-fs-billing 技能](../.cursor/skills/verify-fs-billing/SKILL.md) 覆盖阶段 4 的登录、越权、会话过期和 SIPp 呼叫。[功能图](../.cursor/skills/verify-fs-billing/features/README.md) 列出可验证的路径，完整运行证据在 `docs/evidence/verify-fs-billing/`。

FreeSWITCH 实机通话按 [FreeSWITCH 配置](../freeswitch/README.md) 另行保存证据。
