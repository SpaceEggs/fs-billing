# 阶段 0 验收记录

分支：`phase-0-scaffold`，已通过 PR [#2](https://github.com/SpaceEggs/fs-billing/pull/2) squash 合并到 `main`（提交 `5492cea`）。

验证日期：2026-10-12。环境：macOS arm64，Node.js 22.23.2，pnpm 10.34.7，Docker 29.4.0 / OrbStack。

## 验收标准

- [x] 全新克隆后 `pnpm install && pnpm check` 通过。
- [x] `docker compose up -d --wait` 后 PostgreSQL 健康检查通过。
- [x] 在 rating 包写入 `export const fee = 0.1 * 3;` 后，`pnpm check` 报错。
- [x] CI 在一次提交上跑通，有记录可查。

## 本地运行证据

从提交 `c220df7` 使用 `git clone --no-local --branch phase-0-scaffold` 克隆到全新的 `/private/tmp/fs-billing-phase-0.fUQKkc`，目录中没有 `.env`、构建产物或 `node_modules`。执行 `pnpm install --frozen-lockfile && pnpm check` 返回 0，四个测试文件、36 个测试全部通过；安装过程中两次连接重置由 pnpm 自动重试恢复。

`pnpm check` 返回 0：ESLint、Prettier、全部六个工作包与根目录的 TypeScript 检查通过；Vitest 4 个测试文件、36 个测试通过。金额规则测试包含金额别名、复合赋值、自增自减、对象字段、解构、箭头函数、原生转换与两个目录的实际 ESLint 配置。

`pnpm build` 返回 0：全部包和服务编译通过，Web 生成 `dist/index.html` 与静态资源。

数据库运行输出：

```text
NAME                    IMAGE                  STATUS                    PORTS
fs-billing-postgres-1   postgres:17.9-alpine   Up (healthy)              127.0.0.1:5432->5432/tcp

SELECT version();
PostgreSQL 17.9 on aarch64-unknown-linux-musl

SHOW timezone;
UTC
```

临时写入 `packages/rating/src/money-probe.ts` 并执行 `pnpm check` 的输出：

```text
packages/rating/src/money-probe.ts
  1:20  error  金额/费率不得使用 number 运算，请使用字符串与 decimal.js。  money/no-number-money
✖ 1 problem (1 error, 0 warnings)
```

检查退出码为 1；临时文件已经删除。

`pnpm dev` 启动后的真实 HTTP 请求：

| 请求                                   | 状态 | 响应                                 |
| -------------------------------------- | ---- | ------------------------------------ |
| `GET http://127.0.0.1:3000/api/health` | 200  | `{"status":"ok","service":"api"}`    |
| `GET http://127.0.0.1:3001/health`     | 200  | `{"status":"ok","service":"worker"}` |
| `GET http://127.0.0.1:5173/api/health` | 200  | `{"status":"ok","service":"api"}`    |

浏览器实际打开 Web，显示“服务状态：连接正常”：

![阶段 0 Web 运行截图](evidence/phase-0/web.png)

## CI 证据

提交 `c220df72840ddec2343c26c947e81b3a389f8262` 的 [GitHub Actions 运行 #38263096133](https://github.com/SpaceEggs/fs-billing/actions/runs/38263096133) 已成功完成。Ubuntu runner 上安装、`pnpm check`、构建、浮点金额拒绝实验和 PostgreSQL 健康/SQL 检查均通过；数据库在任务结束时正常停止。

## 范围边界

这里只提供工程骨架和健康接口。计费规则、金额品牌类型、Drizzle 迁移、RLS、pg-boss、授权/CDR 接口、登录与正式页面按后续阶段实现。金额 ESLint 规则采用命名与文件内数据来源检查，不能证明跨函数或外部数据的金额语义；具体限制见根目录 README。
