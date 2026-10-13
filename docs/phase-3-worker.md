# 阶段 3 验收记录：FreeSWITCH 接口（`apps/worker`）

分工：Codex 编写代码，Claude Code 只读评审，Grok Bot 验证（本文件与 `docs/evidence/phase-3/` 由验证者记录）。验证时间 2026-10-13（PT）。

证据文件（`docs/evidence/phase-3/`）：`check.txt`、`test-db-1..3.txt`、`test-db-verbose.txt`、`coverage.txt`、`perf-authorize.txt`、`live-e2e.sh` / `live-e2e.txt`（真实启动 Worker 进程，curl + psql）、`claude-review.md`。

| #   | 验收标准                                                                      | 结果                | 证据                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 同一真实格式话单 POST 两次只入 1 条话单、1 条扣费                             | 通过                | live-e2e [1]：两次 200，raw_cdrs=2、cdrs=1、ledger=1，余额只减 0.192；测试「真实格式样本推送两次…任务重复执行也不重扣」「同一 UUID 并发推送只入一条话单和一个任务」                       |
| 2   | 500 条费率、1000 次授权 p95 < 50 ms                                           | 通过                | `perf-authorize.txt`：p95 ≈ 7.1 ms（max 52 ms）                                                                                                                                           |
| 3   | 停掉 API，授权与话单照常                                                      | 通过                | live-e2e 全程无 API 进程，Worker 独立连接数据库完成全部请求                                                                                                                               |
| 4   | 无密钥或白名单外 IP 返回 401/403                                              | 通过                | live-e2e：无密钥 401、错密钥 401；白名单设为 127.0.0.2 时自 127.0.0.1 请求 403；测试「缺密钥或不在 IP 白名单的请求在保存正文前拒绝」                                                      |
| 5   | `ABC01` 进入未归属话单、不扣费                                                | 通过                | live-e2e [5]：unassigned_cdrs `ABC01｜租户不存在｜pending`，ledger=0                                                                                                                      |
| 6   | `billing_unverified=true` 照常计费并保留标记                                  | 通过                | live-e2e [1]：样本带该标记，cdrs.unverified=t，扣费 0.192                                                                                                                                 |
| 7   | 计费中途杀 Worker 再重启只扣一次                                              | 通过                | live-e2e [7]：POST 后 `kill -9`，此时 ledger=0；重启并重推后 cdrs=1、ledger=1；测试「流水已插入后模拟崩溃…」「扣费提交但任务未确认：重启队列…不重复扣费」                                 |
| 8   | FreeSWITCH 测试机实打电话                                                     | **待办（PENDING）** | 需要用户的 FreeSWITCH 测试机；步骤见 `freeswitch/README.md`。未伪造。评审建议届时核对真实话单中 caller 号码字段位置（已加 callflow 回退）                                                 |
| 9   | 授权有费率、接通时无费率不按 0 计费                                           | 通过                | 测试「接通时无费率进入待人工处理，不按零元计费」「授权有费率，接通时新版移除前缀：pending 与告警…」                                                                                       |
| 10  | 号码格式错误：授权 400；话单不返回 400、存未归属并告警；拨号计划先去 `+`/`00` | 通过                | live-e2e [10]：`+44…`/`0044…`/`44abc` 授权 400「号码格式错误」；`+44…` 话单 HTTP 200，进 unassigned（号码格式错误）、ledger=0、有 cdr_failed 告警；`billing_authorize.lua:40` 去 `+`/`00` |
| 11  | `occurred_at` = `answered_at`，9-30 23:59 接通归属 9 月                       | 通过                | 测试「接通时刻选择整表版本，跨月处理仍按九月入账」；live-e2e ledger.occurred_at 与 cdrs.answered_at 相同                                                                                  |
| 12  | `call_uuids` 唯一闸门、识别 23505、raw_cdrs 保存原文                          | 通过                | 测试「已有未归属 UUID 改标签重推仍重复…」「同一 UUID 并发推送…」；live-e2e raw_cdrs=2（两次原文均保存）                                                                                   |
| 13  | 建分区是维护操作；写入路径缺分区 503 + partition_failed                       | 通过                | 测试「缺分区返回 503…不在写入路径建分区」「原文分区缺失返回 503…」「启动维护立即建分区，每日北京时间调度可重复运行」「启动及维护任务失败写 partition_failed」                             |
| 14  | savepoint 标记测试直接断言、去掉 `.catch()`                                   | 通过                | `packages/db/src/tenant-lock.db.test.ts` 直接读 `app.tenant_locks`，只接受 `TransactionRollbackError`                                                                                     |
| 15  | `ensureCdrPartitions` 不接受事务                                              | 通过                | 测试「维护入口在类型层拒绝事务，只接受连接池数据库」（`@ts-expect-error`），`pnpm check` typecheck 通过                                                                                   |
| 16  | 修正 phase-2-db.md:102 与迁移注释措辞                                         | 通过                | 两处改为「只有分区已存在时并发调用才不互相串行」；drizzle 迁移器不校验历史 hash，已有库再次 `pnpm db:migrate` 正常                                                                        |

## 测试与覆盖率

- `pnpm check`：通过，136 个测试
- `pnpm test:db` 连续 3 次：均通过，每次 121 个测试
- `pnpm coverage`：通过；`packages/rating` 行 100%、分支 96.36%（coverage 只统计单元测试，Worker 由 DB 测试覆盖）
- 本地启动 Worker 前需执行 `pnpm --filter @fs-billing/worker queue:migrate`（部署步骤），并在 `.env` 配置 `WORKER_SHARED_KEY`、`WORKER_ALLOWED_IPS`

## 评审

Claude Code 只读评审（`claude -p … --permission-mode plan`）：无 BLOCKER，全文见 `evidence/phase-3/claude-review.md`。

- 已修：SHOULD-FIX 1，真实话单的 `caller_id_number` 可能只在 `callflow[].caller_profile` 中，会导致话单整条判为无效、漏扣费。Codex 一轮修复：优先取 variables，回退到 callflow，仍缺则为空，并加 DB 测试。
- 待后续：重试耗尽后缺扣费流水的对账（2）、schema 不合格话单进入人工队列（3）、启动后连接池饥饿（4）以及若干 NIT（`/authorize` 的 401/403 测试、每次重试都写告警、pg-boss 补丁假设单实例等）。
