# 阶段 8 PR 1 证据：数据库核心

2026-10-23，本机 PostgreSQL 17.9（Docker）、Node 24.22.1。设计见 [phase-8-design.md](../../phase-8-design.md)，PR 实现时的验证与偏差见该文末「PR 1 实现时的验证与偏差」。

## 测试结果

| 命令             | 结果                                                                                                                                                                        | 输出                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `pnpm check`     | 退出 0：lint、格式检查、类型检查全过；根目录单元测试 42 个文件、777 通过 1 跳过（本机没有 `lua5.3`，Lua 测试跳过，CI 必跑）；Web 单元测试 45 个文件、600 通过；Web 构建成功 | [pnpm-check.txt](pnpm-check.txt)         |
| `pnpm test:db`   | 退出 0：48 个文件、675 个测试全部通过（阶段 7 的 ABC001 8 月 1,176.60、9 月 −35.20 等依赖种子的测试全部照常通过）                                                           | [pnpm-test-db.txt](pnpm-test-db.txt)     |
| `pnpm test:idor` | 退出 0：1 个文件、35 个测试全部通过                                                                                                                                         | [pnpm-test-idor.txt](pnpm-test-idor.txt) |

改动前的基线（同一台机器，改动了种子之后、加新测试之前）是 43 个文件、613 个测试，其中只有 `audit.db.test.ts` 的完整行断言因多了 `actor_label` 列而失败，已更新。

验收 1 至 3 对应的测试（名字同设计文档「验收标准对应计划测试」）：

- `packages/db/src/unassigned/assign.db.test.ts`：`previews 326 ABC01 rows against ABC001 as 324 assignable, 58.35 and 2 without a rate`、`assigning charges 58.35 and writes one call_charge per assignable row`、`submitting the same batch twice charges once`、`the September statement becomes stale after the assignment and is not regenerated`（这四个在单独的、播过种子的库里跑，不改动共享测试库的种子数字）；`assigns a row once when two admins submit at the same time`、`a second claim of the call uuid fails with call_uuids_pkey`、`a failure in the middle rolls the whole batch back`、`rolls back when the preview figures no longer match`、`leaves rows without a call identity or billing number pending`、`rows answered in a details-deleted month are not assigned`、`creates the missing cdrs partition before assigning an old row` 等。
- `packages/db/src/unassigned/ignore.db.test.ts`：`ignores with a reason and restores to pending`、`rejects an empty reason`。
- `packages/db/src/cdr-deletion/delete.db.test.ts`：`rejects the current month and a month without a statement`、`deleting August leaves the ledger, balance, statement header and breakdown unchanged`、`flags the statement and removes the rows in one transaction`、`rejects a month with a charge not yet written`、`rejects a month that is stale or inconsistent`、`deleting the same month twice affects it once`、`delete waits for an in-flight assignment`、`regeneration racing a deletion is rejected by the guard`、`a re-pushed deleted call is a duplicate`、`writes one cdr_delete audit per month ...`、多月份中途失败等。
- 决定 38：`packages/db/src/cdr-intake.db.test.ts`、`apps/worker/src/ingest.db.test.ts` / `parks a call answered in a details-deleted month without charging it and opens a cdr_failed alert`。
- 越权与守卫：`rls.db.test.ts` / `new staff-only tables hide their rows from tenants`、`operation_logs stays append-only with a nullable actor`；`regenerate.db.test.ts` / `the guard rejects rewriting deletion metadata`；`apps/api/src/portal-statements.db.test.ts` 的门户账单原始 JSON 不含 `details_deleted_by / _at / _count`。

## 耗时（PORTALBIG）

原始输出：[ops-timings.txt](ops-timings.txt)（第一次运行见 [ops-timings-first-run.txt](ops-timings-first-run.txt)，已被取代）。脚本 `packages/db/scripts/ops-perf.ts` 会写库，只在 `fs_billing_perf` 的克隆库 `fs_billing_perf_p8pr1` 上运行（`CREATE DATABASE … TEMPLATE fs_billing_perf` 30 s，再 `pnpm db:migrate`，三个迁移 0016、0017、0018 合计 2.1 s）。PORTALBIG 在克隆库里本来没有费率表，脚本写入种子费率表（2025-01-01 起生效）后分配。

| 操作                                                         | 耗时                                    | 说明                                                                                        |
| ------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| 分配 326 条                                                  | 1.04 s（3.2 ms/行）                     | 同一个事务；租户锁探针最长排队 1.03 s                                                       |
| 分配 2000 条                                                 | 4.44 s（2.2 ms/行）                     | 租户锁探针最长排队 4.41 s                                                                   |
| 分配 5000 条                                                 | 10.40 s（2.1 ms/行）                    | 租户锁探针最长排队 10.36 s                                                                  |
| 分配预览（326 / 2000 / 5000 条）                             | 约 5–15 ms / 约 11–17 ms / 约 24–27 ms  | 只读，不拿租户锁                                                                            |
| 删除 PORTALBIG 2026-09（246,574 条话单，其中已接通 234,277） | 1.58 s                                  | 租户锁探针最长排队 1.13 s；删除前后流水 2,857,513 笔、流水合计与余额（105099.2880）逐字相同 |
| 删除月份列表（2026 年 12 个月，含每月话单数与未扣费检查）    | 2.34–2.72 s                             | 耗时与该年话单行数成正比；第一次实现（逐行过滤）为 7.05–9.64 s，见第一次运行                |
| 核对 PORTALBIG 全部账单（12 个月）                           | 2.79 s                                  | 删除前置条件需要核对为 ok；本次是 `reconcileTenantStatements`                               |
| 未归属列表，10 万行待处理：分组（41 组）                     | 约 20–29 ms                             | `unassigned_cdrs_status_tag`                                                                |
| 未归属列表：第 1 页 50 条 / 第 1000 页（offset 49,950）      | 0.7–3.3 ms / 25 ms                      | `unassigned_cdrs_status_time`；总数 `count(*)` 约 15 ms                                     |
| 操作日志，100 万行：最近 30 天最新 50 条 / 计数              | 0.6 ms（首次 29 ms）/ 约 7–11 ms        | `operation_logs_created`                                                                    |
| 操作日志：加租户 / 加操作类型 / 整年 offset 100,000          | 1.5–2.4 ms / 3.0–4.2 ms / 约 185–190 ms | 另有 `operation_logs_tenant_created`、`operation_logs_action_created`                       |

### ASSIGN_MAX_ROWS 取 2000

持租户锁期间，该租户的话单入库与扣费任务排队。FreeSWITCH 的 `json_cdr` 推送超时是 5 秒（`freeswitch/autoload_configs/json_cdr.conf.xml`，`timeout=5 retries=3 delay=5`），持锁超过 5 秒，这个租户的话单推送会超时重试（原文再存一份，登记表挡住重复入账）。每行约 2.2 ms：2000 条约 4.4 s 在 5 秒以内，5000 条约 10.4 s 不在。所以默认值从设计里的占位 5000 改为 2000，常量是 `packages/db/src/unassigned/types.ts` 的 `ASSIGN_MAX_ROWS`，函数参数 `maxRows` 可覆盖。授权接口不拿租户锁，不受影响（有测试）。

### 局限

- 一台笔记本上的 Docker PostgreSQL，数字只用于比较量级和定上限，不是生产容量承诺；上线前要在目标机器上复测，特别是 `ASSIGN_MAX_ROWS`。
- 未归属列表与操作日志测的是 SQL 形状（设计里的筛选与排序），不含 HTTP；接口在 PR 4，到时再测。
- 操作日志的「按管理员筛选」没有索引，测得很快是因为夹具只有两个管理员、每人一半的行（几乎每行都匹配，扫描很快就凑够 50 条）；管理员很多、某个管理员很少操作时这条查询会扫得更多，数据量大到需要时再加 `(admin_id, created_at)` 索引。
- 迁移 0018 在克隆库上耗时包含在上面的 2.1 s 里；克隆库里 `operation_logs` 是空表（三个索引建在空表上），有历史数据的库上建索引的耗时没有测，上线前迁移演练（阶段 10）要测。
- 归档（PR 3）与接口耗时（PR 4）不在本 PR。
