# FS-Billing

FreeSWITCH 话单计费系统：呼叫前授权、话单入库与扣费、余额与流水，以及客户门户和管理后台。工程按 [阶段计划](docs/plan.md) 推进，业务规则见 [设计文档](docs/design.md)，页面说明见 [页面说明书](docs/pages.md)。

## 当前进度

| 阶段 | 内容                                              | 状态                                                                           |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0–3  | 工程骨架、计费核心、数据库与账本、FreeSWITCH 接口 | 已完成；FreeSWITCH 实机通话待阶段 10 验收                                      |
| 4    | API、登录与网页外壳                               | 已完成                                                                         |
| 5    | 管理后台：开户与资金                              | 代码验收已完成；2 条运维项待阶段 10                                            |
| 6    | 客户门户                                          | 验收 6 项已勾选；Windows Excel 核对 BOM CSV 待人工。见[阶段计划](docs/plan.md) |
| 7–10 | 月账单、话单运维、通知、部署上线                  | 未开始                                                                         |

各阶段的验收证据和未完成项以 [docs/plan.md](docs/plan.md) 的阶段表为准。

## 开发环境

- Node.js 22.23.2（`.node-version`）；支持 Node.js 22.12+ 或 24.x。
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

| 服务       | 地址                              | 验证                                      |
| ---------- | --------------------------------- | ----------------------------------------- |
| 客户门户   | http://127.0.0.1:5173/login       | 用门户种子账号登录后进入门户首页          |
| 管理后台   | http://127.0.0.1:5173/admin/login | 用管理员种子账号登录后进入后台首页        |
| API        | http://127.0.0.1:3000/api/health  | 返回 `{"status":"ok","service":"api"}`    |
| Worker     | http://127.0.0.1:3001/health      | 返回 `{"status":"ok","service":"worker"}` |
| PostgreSQL | 127.0.0.1:5432                    | `docker compose ps` 显示 healthy          |

Web 开发服务器把 `/api` 代理到 `FS_BILLING_API_ORIGIN`，缺省为 `http://127.0.0.1:3000`。API 校验 POST 请求的 Origin，所以 `.env` 的 `BETTER_AUTH_TRUSTED_ORIGINS` 必须包含 Web 的地址。健康接口不检查数据库。Worker 的授权、话单与扣费接口见 [Worker 接口](docs/worker-api.md)，FreeSWITCH 侧配置见 [FreeSWITCH 配置](freeswitch/README.md)。

数据库数据保存在 Docker 命名卷中。`pnpm db:down` 停止 PostgreSQL 并保留数据。

## 常用命令

| 命令               | 作用                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `pnpm check`       | lint、格式检查、类型检查、单元测试和 Web 构建，与 CI 的 `check` job 一致                                |
| `pnpm test`        | 单元测试，不连接数据库                                                                                  |
| `pnpm test:db`     | 在全新的 `fs_billing_test` 库上迁移、写种子并运行数据库验收测试。需要先 `pnpm db:up`                    |
| `pnpm test:idor`   | 只运行越权测试：用租户 A 的账号访问 OpenAPI 中每个客户端点的 B 租户数据，必须全部失败                   |
| `pnpm test:e2e`    | Playwright e2e，启动真实 API 和 Web，连接真实 PostgreSQL。需要已迁移、写种子的库和 `SEED_AUTH_PASSWORD` |
| `pnpm coverage`    | 计费核心 `packages/rating` 的覆盖率，行覆盖率低于 95% 时失败                                            |
| `pnpm build`       | 编译所有包和服务，构建网页                                                                              |
| `pnpm format`      | 自动格式化。已确认的设计稿和原始规划文档不参与格式化                                                    |
| `pnpm db:migrate`  | 以 `DATABASE_URL`（owner）执行未应用的迁移，设置应用角色密码，建当月与下月话单分区。可重复执行          |
| `pnpm db:seed`     | 写入与设计稿一致的示例数据（ABC001、GZT007 等 10 个租户，ABC001 余额 −35.20）。可重复执行               |
| `pnpm screenshots` | 截取登录页和 404 的实现与设计稿画框，写入 `docs/evidence/phase-4-web/screenshots/`                      |

客户门户首页的视觉对照用 `FSB_VISUAL=1 pnpm --filter @fs-billing/web exec playwright test e2e/portal-visual.spec.ts` 生成（环境同上），对照图写入 `docs/evidence/phase-6-web/visual/`，差异清单见 `docs/evidence/phase-6-web/visual-diff.md`。

管理后台的视觉对照用 `FSB_VISUAL=1 FSB_EVIDENCE_DIR=$PWD/docs/evidence/phase-5-web pnpm --filter @fs-billing/web exec playwright test e2e/admin-visual.spec.ts` 生成，需要与 `pnpm test:e2e` 相同的库和 `SEED_AUTH_PASSWORD`。对照图写入 `docs/evidence/phase-5-web/visual/`，差异清单见 `visual-diff.md`。

服务目前用 `pnpm --filter @fs-billing/api start` 和 `pnpm --filter @fs-billing/worker start` 直接运行 TS 源码，生产打包在阶段 10 完成。

## 目录

```text
apps/web         React + Vite：客户门户与管理后台
apps/api         Fastify API：Better Auth 登录、门户与管理后台接口、OpenAPI
apps/worker      Fastify Worker：呼叫前授权、话单入库、扣费任务与对账
packages/shared  Zod 数据格式与 API 契约，API 和 Web 共用
packages/db      表结构与迁移（SQL）、Drizzle 描述、RLS 身份、账本与费率读写、管理后台服务、种子
packages/rating  计费核心纯函数：金额与费率类型、计费、前缀匹配、号码归一化、授权、CSV
freeswitch/      授权 Lua、拨号计划、mod_json_cdr、内网 relay 与落盘重推
tooling/eslint/  金额保护规则
tests/           工具与跨包测试
design/          已确认的设计稿
docs/            设计、计划、各阶段设计与验收记录、证据
```

## 数据库与租户隔离

应用运行时用 `APP_DATABASE_URL` 连接。角色 `fs_billing_app` 不是超级用户，也没有 BYPASSRLS。代码在事务内用 `withTenant(db, tenantId, fn)` 或 `withAdmin(db, fn)` 声明身份，未声明时读不到任何业务行。API 只从登录身份取租户编号，不信任请求里的租户参数。登录相关的表放在单独的 `auth` schema，用 `AUTH_DATABASE_URL` 连接。

迁移是 `packages/db/migrations/` 下的手写 SQL，`packages/db/src/schema.ts` 是对应的 Drizzle 描述。表结构、账本不变量和费率版本规则见 [阶段 2 验收记录](docs/phase-2-db.md)，API 与登录的设计见 [阶段 4 后端设计](docs/phase-4-api-design.md)。运维人工查操作日志用只读角色 `fs_billing_audit` 和 `audit_operation_logs(...)`，手动授权后用 `audit_role_violations()` 复查，见 [阶段 5 设计](docs/phase-5-design.md) 的「运维审计查询（决定 f）」。

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

- [verify 技能](apps/web/.agents/skills/verify/SKILL.md) 覆盖阶段 0–3。[功能图](apps/web/.agents/skills/verify/features/README.md) 列出可验证的路径，包括 Worker 授权、话单入库、扣费任务和数据库账本。证据默认保存在 `artifacts/verify/`。
- [verify-fs-billing 技能](.cursor/skills/verify-fs-billing/SKILL.md) 覆盖阶段 4 的登录、越权、会话过期和 SIPp 呼叫。[功能图](.cursor/skills/verify-fs-billing/features/README.md) 列出可验证的路径，完整运行证据在 `docs/evidence/verify-fs-billing/`。

FreeSWITCH 实机通话按 [FreeSWITCH 配置](freeswitch/README.md) 另行保存证据。
