# 阶段 4 API 运行与验收

后端步骤 3 已实现，分支 `phase-4-api`，没有提交或推送。退款采用 `auth.login_failures.window_id UUID NOT NULL`，新窗口生成新 UUID，旧请求只退款到其预占窗口。这是 [设计 §11.1](phase-4-api-design.md#111-api-自有-sql-账户锁定) 已批准规则的实施细节，没有新的产品决定。

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

旧资料迁移保留 UUID 和账本引用，移除资料 email，建立 `auth_user_id UNIQUE NOT NULL` FK。规范化后邮箱冲突在任何结构变更前终止迁移。旧账号不会自动生成 credential，开发环境可重置数据库，其他环境须先解决重复邮箱并另行初始化密码。

紧急解锁使用 owner `DATABASE_URL`，按 Better Auth 的邮箱小写规则删除 counter，不改密码或会话。

```sh
pnpm --filter @fs-billing/api auth:unlock admin@example.com
```

服务每分钟清理无有效锁且已过期的 counter。凭据路由共享每 IP 每分钟 30 次限流，trustProxy 关闭，logout 不受凭据限流影响。当前内存 store 适用于单进程，多实例上线前须配置共享 store。

## 验证证据与限制

- `apps/api/src/app.test.ts` 验证健康端点、live OpenAPI、请求校验、可信来源、401、缓存启动断言和环境角色校验。
- `packages/db/src/auth.db.test.ts` 验证 catalog、五张 auth 表逐项 CRUD 权限、42501、身份 0/1/2 匹配、关联约束、Drizzle 列、旧资料迁移与账本引用。
- `apps/api/src/auth.db.test.ts` 验证真实登录 cookie、锁定矩阵、未知邮箱响应与时间容差、改密码共享计数、撤销、重置原子性、竞态、安装核心 schema 和 stale-refund 确定性交错。
- `apps/api/src/idor.db.test.ts` 与 `apps/api/scripts/prove-idor.ts` 验证 live OpenAPI 全量覆盖与显式过滤、RLS 两道防线。
- `.audit/phase-4-api.tsv` 与 `.audit/phase-4-api.todo.md` 保存本地实施记录。

本地 `pnpm check` 的 lint、format、全部 workspace typecheck 和 unit 均通过，unit 为 306 passed、1 existing skip；`pnpm build` 全部 workspace 通过。实际 OpenAPI 导出 10 个 contract operations。sandbox 的 standalone pnpm 内嵌 Node 20，运行检查使用临时 engine override wrapper，子脚本实际使用 Node 24.21.0。PostgreSQL socket 与变异子进程被 sandbox 拒绝，DB、完整变异证明、seed 和 unlock 的数据库效果没有本地运行证据，必须由 Bot 执行上述命令。后端验收勾选保持待验证，前端验收状态不变。

## 变更文件

以下清单包括接续前已有的未提交实现和本次完成的修改。评审记录 Markdown 仅修复格式，使全仓库 format check 通过。

```text
.env.example
.github/workflows/ci.yml
apps/api/package.json
apps/api/scripts/export-openapi.ts
apps/api/scripts/prove-idor.ts
apps/api/scripts/seed-auth.ts
apps/api/scripts/unlock-account.ts
apps/api/src/app.test.ts
apps/api/src/app.ts
apps/api/src/auth.db.test.ts
apps/api/src/auth/better-auth.ts
apps/api/src/auth/gateway.ts
apps/api/src/auth/types.ts
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
