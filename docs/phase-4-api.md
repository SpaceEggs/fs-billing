# 阶段 4 API 运行与验收

后端步骤 3 已实现，分支 `phase-4-api`。Bot 已完成下述验证记录。退款采用 `auth.login_failures.window_id UUID NOT NULL`，新窗口生成新 UUID，旧请求只退款到其预占窗口。这是 [设计 §11.1](phase-4-api-design.md#111-api-自有-sql-账户锁定) 已批准规则的实施细节，没有新的产品决定。

## Bot 运行命令

使用仓库要求的 Node 22 或 24 与 pnpm 10.34.7，按 `.env.example` 配置 owner `DATABASE_URL`、业务 `APP_DATABASE_URL`、认证 `AUTH_DATABASE_URL`、`BETTER_AUTH_SECRET` 和 `BETTER_AUTH_URL`。

依次执行以下命令。`test:db` 每次重建专用 `fs_billing_test` 数据库；隔离变异证明的四个进程依次重建同一个测试库，不能与其他 DB suite 并发运行。

```sh
pnpm check
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm db:migrate
pnpm test:db
pnpm test:idor
pnpm --filter @fs-billing/api prove:idor /tmp/fs-billing-idor-evidence
pnpm --filter @fs-billing/api openapi /tmp/fs-billing-openapi.json
pnpm build
```

IDOR suite 从真实 Fastify OpenAPI 枚举 customer、authenticated、session 操作，当前为 5 个。报告分母来自文档，新增操作缺少场景会失败。变异证明须输出 baseline-app、baseline-owner 通过，mutation-owner 检测到 B 余额泄漏，mutation-app 通过。脚本只在临时副本删除 tenant WHERE，并在结束时删除副本。数据库防线通过不能代替 owner lane 的泄漏断言。

CI 在数据库 setup 后执行 `test:db` 和变异证明，上传 OpenAPI、覆盖结果、测试报告、变异差异和最终证明，不上传环境或认证秘密。

## 开发账号与服务

`db:seed` 创建资料与 auth 用户，不设默认密码。设置仅开发使用的 `SEED_AUTH_PASSWORD` 后初始化凭据，密码须满足共享的新密码规则。初始化使用 Better Auth 的 `$context.password.hash`，重复运行不覆盖已有 credential，production 环境被拒绝。

```sh
pnpm --filter @fs-billing/api auth:seed
pnpm --filter @fs-billing/api start
```

示例管理员邮箱为 `wangmin@example.com`、`lijun@example.com`，门户邮箱为小写租户 code，例如 `abc001@example.com`。准确邮箱以种子 `auth.user` 为准。初始化不把密码输出到日志。

`BETTER_AUTH_TRUSTED_ORIGINS` 是逗号分隔的完整 Origin，不含路径或末尾斜杠，缺省使用 `BETTER_AUTH_URL` 的 Origin。生产认证 URL 必须为 HTTPS，session cookie 为 HttpOnly、SameSite=Lax、Secure。原始 Better Auth HTTP router 未挂载，没有公开注册端点。

## 数据库角色与紧急解锁

`fs_billing_app` 只执行受限身份函数及现有 RLS 业务查询，不能读 credential 或 session。`fs_billing_auth` 只访问五张 auth 表，没有业务权限。`fs_billing_identity` 是 NOLOGIN NOSUPERUSER BYPASSRLS，只拥有资料和租户必要列的 SELECT 与受限 SECURITY DEFINER 函数。owner 用于迁移、种子及紧急维护。服务在监听前同时检查两条连接的实际 `current_user`，拒绝 URL 与实际角色不一致。

旧资料迁移保留 UUID 和账本引用，移除资料 email，建立 `auth_user_id UNIQUE NOT NULL` FK。规范化后邮箱冲突在任何结构变更前终止迁移。旧账号不会自动生成 credential，开发环境可重置数据库，其他环境须先解决重复邮箱，再使用下述 owner bootstrap 初始化密码。迁移冲突检查保留 SQL `lower()`，非 ASCII 规范化受 collation 影响，迁移前另按 JS `email.toLowerCase()` 核对冲突。

托管 PostgreSQL（如 RDS / Cloud SQL）迁移前须由有权创建 BYPASSRLS 角色的管理员预置 `fs_billing_identity`；执行 `ALTER FUNCTION ... OWNER TO fs_billing_identity` 还须具备所需角色成员资格或平台授予的管理权限。普通 owner 用户不一定具备这些能力，须在部署前确认平台权限。

### 初始化生产凭据

`auth:bootstrap` 使用 owner `DATABASE_URL`，按 profile UUID 定位已有管理员或门户账号，使用 `(await auth.$context).password.hash`。URL 和实际数据库角色均拒绝 app/auth/identity。首次创建 credential；已有 credential 默认拒绝，`--replace` 在同一事务更新密码、撤销该用户所有 session 并清除失败计数。目标 auth.user 行锁使并行初始化串行。资料不存在或 credential 多于一行时拒绝。

```sh
pnpm --filter @fs-billing/api auth:bootstrap --kind admin --profile <admin-profile-uuid> --generate
pnpm --filter @fs-billing/api auth:bootstrap --kind portal --profile <portal-profile-uuid> --replace < /secure/password-input
```

密码只从 stdin 读取，或由 `--generate` 生成；不接受密码参数，避免 shell history 和进程列表泄露。stdin 可有一个结尾换行。生成密码仅在事务成功后输出一次，妥善保存；提供的密码不回显。需要 `BETTER_AUTH_SECRET` 与 `BETTER_AUTH_URL`，不限制 production。CLI 不创建业务资料或 auth.user，迁移和开户负责建立这些关联。

紧急解锁使用 owner `DATABASE_URL`，按 Better Auth 的邮箱小写规则删除 counter，不改密码或会话。

```sh
pnpm --filter @fs-billing/api auth:unlock admin@example.com
```

服务每分钟清理无有效锁且已过期的 counter。凭据路由共享每 IP 每分钟 30 次限流，trustProxy 关闭，logout 不受凭据限流影响。当前内存 store 适用于单进程，多实例上线前须配置共享 store。

## 验证证据与限制

- `apps/api/src/app.test.ts` 验证健康端点、live OpenAPI、请求校验、可信来源、401、缓存启动断言和环境角色校验。
- `packages/db/src/auth.db.test.ts` 验证 catalog、五张 auth 表逐项 CRUD 权限、42501、身份 0/1/2 匹配、关联约束、Drizzle 列、旧资料迁移与账本引用。
- `apps/api/src/auth.db.test.ts` 验证真实登录 cookie、锁定矩阵、未知邮箱响应与时间容差、改密码共享计数、撤销、重置原子性、竞态、安装核心 schema 和 stale-refund 确定性交错。
- `apps/api/src/bootstrap.db.test.ts` 验证 owner bootstrap、创建与替换、并行初始化、撤销失败回滚、CLI 密码输出与拒绝参数；CLI 子进程测试与 DB 测试一起由 Bot 运行，sandbox 拒绝嵌套进程。
- `apps/api/src/idor.db.test.ts` 与 `apps/api/scripts/prove-idor.ts` 验证 live OpenAPI 全量覆盖与显式过滤、RLS 两道防线。
- `.audit/phase-4-api.tsv` 与 `.audit/phase-4-api.todo.md` 保存本地实施记录。

Bot 已验证 `pnpm check`（309 pass）、`pnpm test:db` 连续三次（每次 235 pass）、`pnpm test:idor`（15 pass）、`prove:idor`、OpenAPI 导出和 build。Better Auth 1.7.7、@fastify/rate-limit 10.3.0 等依赖已安装并固定于锁文件。CI 结果在推送后记录到 evidence。前端验收状态不变。

## 变更文件

以下为步骤 3 的整批实施清单，包含已在分支上的文件。本次评审修复的工作区差异以 `git diff --name-only` 和未跟踪新文件为准。

```text
.env.example
.github/workflows/ci.yml
apps/api/package.json
apps/api/scripts/bootstrap-credential.ts
apps/api/scripts/export-openapi.ts
apps/api/scripts/prove-idor.ts
apps/api/scripts/seed-auth.ts
apps/api/scripts/unlock-account.ts
apps/api/src/app.test.ts
apps/api/src/app.ts
apps/api/src/auth.db.test.ts
apps/api/src/auth/better-auth.ts
apps/api/src/auth/bootstrap.ts
apps/api/src/auth/gateway.ts
apps/api/src/auth/types.ts
apps/api/src/bootstrap.db.test.ts
apps/api/src/config.ts
apps/api/src/errors.ts
apps/api/src/identity.ts
apps/api/src/idor.db.test.ts
apps/api/src/main.ts
apps/api/src/openapi.ts
apps/api/src/routes/admin.ts
apps/api/src/routes/auth.ts
apps/api/src/routes/portal.ts
apps/api/src/routes/register.ts
apps/api/src/types.ts
apps/api/test/support.ts
apps/api/tsconfig.build.json
apps/api/tsconfig.json
docs/design.md
docs/evidence/phase-4-api/contract-claude-review.md
docs/phase-4-api-design.md
docs/phase-4-api.md
docs/plan.md
freeswitch/test/seed.sql
package.json
packages/db/migrations/0005_auth.sql
packages/db/migrations/meta/_journal.json
packages/db/src/auth-schema.ts
packages/db/src/auth.db.test.ts
packages/db/src/client.ts
packages/db/src/index.ts
packages/db/src/migrate.db.test.ts
packages/db/src/migrate.ts
packages/db/src/schema.ts
packages/db/src/seed.ts
packages/db/test/global-setup.ts
packages/db/test/support.ts
packages/shared/src/api/api.test.ts
packages/shared/src/api/contract.ts
pnpm-lock.yaml
```

## 移植到 PR #17

相对 `bb3f7c2`，`packages/shared` 与 `docs` 的差异文件完整清单如下。以 `git diff bb3f7c2 --name-only -- packages/shared docs` 核对；移植时按 PR #17 的现有内容合并文档，避免覆盖后端说明。

```text
packages/shared/src/api/contract.ts
packages/shared/src/api/api.test.ts
docs/design.md
docs/evidence/phase-4-api/contract-claude-review.md
docs/phase-4-api-design.md
docs/phase-4-api.md
docs/plan.md
```

共享契约变化仅为 login 的 403 允许 `FORBIDDEN` 与既有 identity errors，logout 新增 403 `FORBIDDEN`，均用于不可信 Origin。logout 不接受 ACCOUNT_DISABLED 或 IDENTITY_UNAVAILABLE，不扩大其身份检查。没有新增错误码。未知路由使用 NOT_FOUND，413/415 等请求解析错误适配为既有 VALIDATION_ERROR。

## 本次评审修复文件

本次评审修复涉及下列 18 个文件。

```text
.github/workflows/ci.yml
apps/api/package.json
apps/api/scripts/bootstrap-credential.ts
apps/api/src/app.test.ts
apps/api/src/app.ts
apps/api/src/auth.db.test.ts
apps/api/src/auth/better-auth.ts
apps/api/src/auth/bootstrap.ts
apps/api/src/auth/gateway.ts
apps/api/src/auth/types.ts
apps/api/src/bootstrap.db.test.ts
apps/api/src/main.ts
apps/api/src/routes/portal.ts
apps/api/src/routes/register.ts
docs/phase-4-api-design.md
docs/phase-4-api.md
docs/plan.md
packages/shared/src/api/api.test.ts
```
