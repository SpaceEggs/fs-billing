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
- 本轮已修：重试耗尽后缺扣费流水的对账、schema 不合格话单进入人工队列、启动连接池饥饿、`/authorize` 的 401/403 测试、每次重试重复写告警。

## 可靠性修复

新增迁移 `0002_worker_reliability`：话单保存补投次数、上次补投时间和一次性告警标记；未归属话单允许未知 UUID/时间，但必须关联原文且不能带缺失字段认领。原文先提交，校验失败再保存 pending 和原因；成功保存返回 HTTP 200 `unassigned`。校验失败的 pending 行不写 `call_uuid`，收到的 UUID 保留在关联原文中，不占用 `call_uuids` 闸门；修正重推可以正常入库和扣费。通过 schema 校验但租户、号码或费率有误的未归属话单仍共用 UUID 闸门，需要人工分配。JSON 语法损坏仍为原文加告警的 `invalid`。

每分钟 pg-boss 对账找正费用但缺扣费流水的话单。`WORKER_RECONCILE_LOOKBACK_DAYS` 限制 `started_at` 的回看范围，默认 30 天，Zod 接受 1–365 的整数；窗口外的旧话单需要人工核对并执行幂等补扣。候选查询按分区键裁剪旧分区，锁内重查与更新带完整话单主键。可配置宽限期 N（默认 5 分钟）与告警阈值 K（默认 3 轮）；计数不依赖 pg-boss 任务保留期。以队列名和确定性任务 ID 查当前轮次的活动任务，不扫描任务 JSON；检查已有流水，按 UUID/轮次生成确定性任务 ID，并在已有租户锁内提交补投和计数。重复执行不会重复补投/扣费；持续失败写一条告警，仍继续尝试。每个候选自成事务，单条失败记录租户、UUID 与错误后继续，末尾抛出汇总错误让 pg-boss 标记本次任务失败。无需新增锁，分区仍仅由独立维护事务创建。

启动挂起根因：`boss.send()` 虽收到 Drizzle 事务，冷缓存队列元数据查询仍经默认 adapter 另借连接。10 个入库事务占满共享池后，持有连接等待另一连接，形成池饥饿。将 pg-boss 元数据/调度池与业务池分开（默认 2 + 10），两个池都配置有界连接获取超时（默认 5000ms）；任务插入继续借用业务事务，不破坏原子性。配置均经 Zod 校验，详见 [接口与配置](worker-api.md)。

新增真实 DB 测试 `apps/worker/src/reliability.db.test.ts`：启动后 50 并发推送须在 10 秒测试期限内完成并保存 50 份原文/话单/任务；真实 pg-boss 三次重试耗尽后补投只收费一次；并发对账幂等；撤销账本 INSERT 权限导致真实扣费持续失败，告警去重，恢复后可收费；校验失败 pending 和原文引用；有效 UUID 的无效话单修正重推只扣一次；授权 401/403；每分钟调度任务可完成。

另有确定性的冷缓存回归测试：业务池仅 1 个连接，pg-boss 使用独立队列池且不调用会预热缓存的 `start()`，直接经 HTTP 推送话单。入库事务持有唯一业务连接时，首次 `send()` 仍须在 5 秒测试期限内成功，数据库须同时存在原文、话单和任务各一条。它与启动后 50 并发测试分别覆盖缓存缺失与启动流量，不依赖并发时序碰巧触发连接饥饿。校验失败测试的查询结果显式声明类型，单独断言原因字段，不禁用 ESLint。

本轮复核（Grok Bot 执行，2026-10-13 PT）：`pnpm check` 通过（11 文件 / 142 测试）；`pnpm test:db` 连续 3 次通过（9 文件 / 131 测试）；`docs/evidence/phase-3/live-e2e.sh` 重跑结果与上次一致。现场复现（`live-repro-run4.sh`）：冷启动后立即 50 并发 POST /cdr 全部 200，最慢 0.55s，50 条话单全部入库并最终扣费；校验失败话单返回 200，写入 pending 待办（原因 + 原文引用）及 `cdr_failed` 告警，非 JSON 原文也被保存并告警；人为将扣费任务置为 failed 且话单超过对账时限后，下一次每分钟对账补投，账本恰好 1 条，后续 tick 不再补投。

本轮评审修正：`0002` 去掉补投计数 CHECK，未归属话单新增 CHECK 使用 `NOT VALID`，避免迁移时扫描历史行。可靠性测试按确定性 ID 读取任务，只推进目标任务的领取状态；宽限期直接断言 0 次补投、1 个任务，并注明撤销共享角色权限依赖 `fileParallelism: false`。新增回看窗口、无 singleton_key 的活动任务和单条失败不阻断其余候选的回归用例。

本次修改后执行：`pnpm check` 通过（11 文件 / 146 测试）；`pnpm coverage` 通过，rating 行覆盖率 100%。`pnpm test:db` 在全局初始化连接 `127.0.0.1:5432` 时被沙箱以 `EPERM` 拒绝，迁移和 DB 回归用例均未执行，不能据此标记通过。
