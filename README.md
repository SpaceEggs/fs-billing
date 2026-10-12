# FS-Billing

FreeSWITCH 话单计费系统。工程按 [阶段计划](docs/plan.md) 推进，业务规则见 [设计文档](docs/design.md)。当前为阶段 0：可启动工程骨架。

## 开发环境

- Node.js 22.23.2（`.node-version`）；支持 Node.js 22.12+ 或 24.x。
- pnpm 10.34.7（`package.json` 的 `packageManager` 固定版本）。可用 `corepack enable` 激活。
- Docker 引擎与 Docker Compose v2，执行前启动 Docker Desktop 或 OrbStack。

```sh
corepack enable
pnpm install
cp .env.example .env
pnpm dev:setup
pnpm dev
```

`pnpm dev:setup` 一条命令执行 lint、格式检查、类型检查、测试，并等待 PostgreSQL 健康。仅检查代码可执行 `pnpm check`，首次克隆执行 `pnpm install && pnpm check`。

| 服务       | 地址                             | 验证                                      |
| ---------- | -------------------------------- | ----------------------------------------- |
| Web        | http://127.0.0.1:5173            | 页面显示“连接正常”                        |
| API        | http://127.0.0.1:3000/api/health | 返回 `{"status":"ok","service":"api"}`    |
| Worker     | http://127.0.0.1:3001/health     | 返回 `{"status":"ok","service":"worker"}` |
| PostgreSQL | 127.0.0.1:5432                   | `docker compose ps` 显示 healthy          |

Web 开发服务器代理 `/api` 到 3000 端口。自定义 API 端口时需同步修改 `apps/web/vite.config.ts` 的代理。API 与 Worker 各自启动，健康接口暂不检查数据库，也尚未提供业务接口。

```sh
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT version(); SHOW timezone;"'
pnpm build
pnpm db:down
```

数据库数据保存在 Docker 命名卷中，`pnpm db:down` 保留数据。Compose 中的凭据与超级用户只用于本地骨架；阶段 2 加入应用角色与 RLS。

## 目录与命令

```text
apps/web         React + Vite 占位页面
apps/api         Fastify API 独立进程
apps/worker      Fastify Worker 独立进程
packages/shared  Zod 数据格式
packages/db      数据库配置入口；阶段 2 加入 Drizzle 表与迁移
packages/rating  decimal.js 入口；阶段 1 加入计费规则
freeswitch/      阶段 3 加入配置与脚本
tooling/eslint/  金额保护规则
tests/           工具与跨包测试
docs/            设计、计划与验收记录
```

`pnpm lint` / `pnpm typecheck` / `pnpm test` 可单独执行；`pnpm format` 自动格式化工程文件。已确认设计稿和原始规划文档不参与格式化。`pnpm build` 验证网页构建与服务/包编译；服务目前通过 `pnpm --filter @fs-billing/api start` 和 `pnpm --filter @fs-billing/worker start` 运行 TS 源码，生产打包在阶段 10 完成。

工具版本依据 [Vite 环境要求](https://vite.dev/guide/) 和 [typescript-eslint 的类型检查配置](https://typescript-eslint.io/getting-started/typed-linting/) 选定，实际解析版本由 `pnpm-lock.yaml` 固定。

## 金额保护

在 `packages/rating/**/*.ts` 与 `apps/worker/**/*.ts` 启用 `money/no-number-money`。规则禁止金额名称（fee、rate、amount、balance 等）、金额变量的本地别名以及小数输入的原生算术、自增自减、复合赋值；金额的 `Math`、`Number`、`parseFloat`、`parseInt` 调用也会报错。时长、端口等普通整数运算可用。

```ts
// ESLint 报错：money/no-number-money
const fee = 0.1 * 3;

// 正确：通过字符串进入 decimal.js
const fee = decimal('0.1').mul('3');
```

这是一条保守的静态保护规则，不能证明跨函数或外部数据一定具有金额语义。金额应保持明确命名、使用字符串与 Decimal 传递，阶段 1 再加入金额、费率和币种品牌类型；不要将金额改名或转换为 number 来绕开规则。

## CI 与阶段验收

每次 push 和 PR 执行安装、`pnpm check`、构建、浮点金额拒绝实验与 PostgreSQL 启动/SQL 检查。阶段分支使用 `phase-<编号>-<简称>`，完成后 PR 列出验收证据，通过后 squash 合并到 `main`。阶段 0 证据记录在 [验收记录](docs/phase-0-scaffold.md)。
