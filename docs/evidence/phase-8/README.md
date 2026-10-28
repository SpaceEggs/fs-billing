# 阶段 8 PR 1 证据：数据库核心

2026-10-23，本机 PostgreSQL 17.9（Docker）、Node 24.22.1。设计见 [phase-8-design.md](../../phase-8-design.md)，PR 实现时的验证与偏差见该文末「PR 1 实现时的验证与偏差」。

## 测试结果

| 命令             | 结果                                                                                                                                                                        | 输出                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `pnpm check`     | 退出 0：lint、格式检查、类型检查全过；根目录单元测试 42 个文件、777 通过 1 跳过（本机没有 `lua5.3`，Lua 测试跳过，CI 必跑）；Web 单元测试 45 个文件、600 通过；Web 构建成功 | [pnpm-check.txt](pnpm-check.txt)         |
| `pnpm test:db`   | 退出 0：48 个文件、677 个测试全部通过（阶段 7 的 ABC001 8 月 1,176.60、9 月 −35.20 等依赖种子的测试全部照常通过）                                                           | [pnpm-test-db.txt](pnpm-test-db.txt)     |
| `pnpm test:idor` | 退出 0：1 个文件、35 个测试全部通过                                                                                                                                         | [pnpm-test-idor.txt](pnpm-test-idor.txt) |

改动前的基线（同一台机器，改动了种子之后、加新测试之前）是 43 个文件、613 个测试，其中只有 `audit.db.test.ts` 的完整行断言因多了 `actor_label` 列而失败，已更新。

验收 1 至 3 对应的测试（名字同设计文档「验收标准对应计划测试」）：

- `packages/db/src/unassigned/assign.db.test.ts`：`previews 326 ABC01 rows against ABC001 as 324 assignable, 58.35 and 2 without a rate`、`assigning charges 58.35 and writes one call_charge per assignable row`、`submitting the same batch twice charges once`、`the September statement becomes stale after the assignment and is not regenerated`（这四个在单独的、播过种子的库里跑，不改动共享测试库的种子数字）；`assigns a row once when two admins submit at the same time`、`a second claim of the call uuid fails with call_uuids_pkey`、`a failure in the middle rolls the whole batch back`、`rolls back when the preview figures no longer match`、`leaves rows without a call identity or billing number pending`、`rows answered in a details-deleted month are not assigned`、`creates the missing cdrs partition before assigning an old row`、`caps the default selection at 500 rows, so a larger group is assigned in batches`、`assigns to a disabled tenant like to an active one` 等。
- `packages/db/src/unassigned/ignore.db.test.ts`：`ignores with a reason and restores to pending`、`rejects an empty reason`。
- `packages/db/src/cdr-deletion/delete.db.test.ts`：`rejects the current month and a month without a statement`、`deleting August leaves the ledger, balance, statement header and breakdown unchanged`、`flags the statement and removes the rows in one transaction`、`rejects a month with a charge not yet written`、`rejects a month that is stale or inconsistent`、`deleting the same month twice affects it once`、`delete waits for an in-flight assignment`、`regeneration racing a deletion is rejected by the guard`、`a re-pushed deleted call is a duplicate`、`writes one cdr_delete audit per month ...`、多月份中途失败等。
- 决定 38：`packages/db/src/cdr-intake.db.test.ts`、`apps/worker/src/ingest.db.test.ts` / `parks a call answered in a details-deleted month without charging it and opens a cdr_failed alert`。
- 越权与守卫：`rls.db.test.ts` / `new staff-only tables hide their rows from tenants`、`operation_logs stays append-only with a nullable actor`；`regenerate.db.test.ts` / `the guard rejects rewriting deletion metadata`；`apps/api/src/portal-statements.db.test.ts` 的门户账单原始 JSON 不含 `details_deleted_by / _at / _count`。

## 耗时（PORTALBIG）

原始输出：[ops-timings.txt](ops-timings.txt)（最终一次，N = 326、500、2000、5000，运行时机器负载平均 3.4–4.6）。同一脚本的其他几次运行保留作对照：[ops-timings-busy-machine.txt](ops-timings-busy-machine.txt)（负载平均约 9.8，笔记本上其他进程占用）、[ops-timings-second-run.txt](ops-timings-second-run.txt)（没有 N=500）、[ops-timings-first-run.txt](ops-timings-first-run.txt)（月份列表还是逐行过滤的第一版，已被取代）。脚本 `packages/db/scripts/ops-perf.ts` 会写库，只在 `fs_billing_perf` 的克隆库 `fs_billing_perf_p8pr1` 上运行（`CREATE DATABASE … TEMPLATE fs_billing_perf` 约 30 s，再 `pnpm db:migrate`，三个迁移 0016、0017、0018 合计 1.4–2.1 s）。PORTALBIG 在克隆库里本来没有费率表，脚本写入种子费率表（2025-01-01 起生效）后分配。

| 操作                                                         | 最终一次运行                            | 说明                                                                                                                |
| ------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 分配 326 条                                                  | 1.01 s（3.1 ms/行）                     | 同一个事务；租户锁探针最长排队 1.00 s                                                                               |
| 分配 500 条（`ASSIGN_MAX_ROWS`）                             | 1.17 s（2.35 ms/行）                    | 租户锁探针最长排队 1.17 s；忙碌机器上那次是 2.25 s                                                                  |
| 分配 2000 条                                                 | 4.19 s（2.1 ms/行）                     | 租户锁探针最长排队 4.17 s；忙碌机器上 6.82 s                                                                        |
| 分配 5000 条                                                 | 12.12 s（2.4 ms/行）                    | 租户锁探针最长排队 12.08 s；忙碌机器上 16.27 s                                                                      |
| 分配预览（326 / 500 / 2000 / 5000 条）                       | 约 6–16 / 4.5–8.3 / 约 11 / 约 23 ms    | 只读，不拿租户锁                                                                                                    |
| 删除 PORTALBIG 2026-09（246,574 条话单，其中已接通 234,277） | 0.89 s                                  | 租户锁探针最长排队 0.51 s；删除前后流水 2,858,013 笔、流水合计与余额（105014.1440）逐字相同；前几次运行 1.28–1.58 s |
| 删除月份列表（2026 年 12 个月，含每月话单数与未扣费检查）    | 2.26–3.28 s                             | 耗时与该年话单行数成正比；第一次实现（逐行过滤）为 7.05–9.64 s，见第一次运行                                        |
| 核对 PORTALBIG 全部账单（12 个月）                           | 1.63 s                                  | 删除前置条件需要核对为 ok；本次是 `reconcileTenantStatements`；前几次运行 1.1–2.8 s                                 |
| 未归属列表，10 万行待处理：分组（41 组）                     | 约 21–23 ms                             | `unassigned_cdrs_status_tag`                                                                                        |
| 未归属列表：第 1 页 50 条 / 第 1000 页（offset 49,950）      | 0.6–1.6 ms / 约 25 ms                   | `unassigned_cdrs_status_time`；总数 `count(*)` 约 15–16 ms                                                          |
| 操作日志，100 万行：最近 30 天最新 50 条 / 计数              | 0.5 ms（首次 8 ms）/ 约 7–11 ms         | `operation_logs_created`                                                                                            |
| 操作日志：加租户 / 加操作类型 / 整年 offset 100,000          | 1.6–2.4 ms / 3.3–4.3 ms / 约 190–192 ms | 另有 `operation_logs_tenant_created`、`operation_logs_action_created`                                               |

### ASSIGN_MAX_ROWS 取 500

用户 2026-10-23 确认（设计「已决定」第 45 项）。持租户锁期间，该租户的话单入库与扣费任务排队。FreeSWITCH 的 `json_cdr` 推送超时是 5 秒（`freeswitch/autoload_configs/json_cdr.conf.xml`，`timeout=5 retries=3 delay=5`），持锁超过 5 秒，这个租户的话单推送会超时重试（原文再存一份，登记表挡住重复入账）。每行约 2.1–2.4 ms（机器忙时 3.4–4.5 ms）：

- 500 条在最终一次运行里是 1.17 s，机器忙时 2.25 s，都在 5 秒以内，且留有约一倍以上的余量；
- 2000 条是 4.19 s，机器忙时 6.82 s，已经超过 5 秒；5000 条是 12.12 s（忙时 16.27 s）。

常量是 `packages/db/src/unassigned/types.ts` 的 `ASSIGN_MAX_ROWS`，预览与分配共用，函数参数 `maxRows` 可覆盖；超过时抛 `VALIDATION_ERROR`（「一次最多处理 500 条，请分批处理」），由 `assign.db.test.ts` / `caps the default selection at 500 rows, so a larger group is assigned in batches` 覆盖（501 条被拒、500 条加 1 条分两批成功）。忽略与撤销忽略只是一条 UPDATE，不长时间持租户锁，单独用 `IGNORE_MAX_ROWS = 2000`，不随分配收紧。授权接口不拿租户锁，不受影响（有测试）。

### 局限

- 一台笔记本上的 Docker PostgreSQL，数字只用于比较量级和定上限，不是生产容量承诺；上线前要在目标机器上复测，特别是 `ASSIGN_MAX_ROWS`。同一份脚本在不同时刻的结果可以差一倍（见忙碌机器那次）。
- 未归属列表与操作日志测的是 SQL 形状（设计里的筛选与排序），不含 HTTP；接口在 PR 4，到时再测。
- 操作日志的「按管理员筛选」没有索引，测得很快是因为夹具只有两个管理员、每人一半的行（几乎每行都匹配，扫描很快就凑够 50 条）；管理员很多、某个管理员很少操作时这条查询会扫得更多，数据量大到需要时再加 `(admin_id, created_at)` 索引。
- 迁移 0018 在克隆库上耗时包含在上面的迁移总耗时里；克隆库里 `operation_logs` 是空表（三个索引建在空表上），有历史数据的库上建索引的耗时没有测，上线前迁移演练（阶段 10）要测。
- 归档（PR 3）与接口耗时（PR 4）不在本 PR。

---

# 阶段 8 PR 2 证据：Worker 入库加固与阶段 3 遗留

2026-10-23 至 24，本机 PostgreSQL 17.9（Docker）、Node 24.22.1。设计见 [phase-8-design.md](../../phase-8-design.md)，实现时的偏差见该文末「PR 2 实现时的验证与偏差」。

## 测试结果

| 命令           | 结果                                                                                                                                                                                                                                                                                 | 输出                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `pnpm check`   | 退出 0：lint、格式检查、类型检查全过；根目录单元测试 44 个文件、849 通过 2 跳过；Web 单元测试 45 个文件、600 通过；Web 构建成功。跳过的 2 个是 Lua 测试（`billing-authorize.test.ts`、`dialed-cases.test.ts` 各一个），本机没有 `lua5.3`，CI 必跑（本机另用 Lua 5.5 手动跑过，见下） | [pr2-pnpm-check.txt](pr2-pnpm-check.txt)     |
| `pnpm test:db` | 退出 0：48 个文件、690 个测试全部通过（PR 1 是 677 个，多出的是 `ingest.db.test.ts` 的 13 个新测试，加上 `reliability.db.test.ts` 改了预期、没有增减）                                                                                                                               | [pr2-pnpm-test-db.txt](pr2-pnpm-test-db.txt) |

PR 1 的基线是 42 个文件 777 通过 1 跳过（根目录）和 48 个文件 677 通过（数据库）。本 PR 新增：`packages/shared/src/worker.test.ts`（7 个）、`tests/dialed-cases.test.ts`（11 个，其中 1 个 Lua 测试本机跳过）、`ingest.db.test.ts`（13 个）；`dialed.test.ts` 由 36 个变为 91 个（共用文件 13 + 32 条，每条在几个测试里用到）。

验收 6 至 10 对应的测试：

- 验收 6（简短原因）：`apps/worker/src/ingest.db.test.ts` / `stores a short structured reason for a failed validation`、`stores a validation failure of an empty object without the Zod message`；`packages/shared/src/worker.test.ts` / `summarizes issues to at most five paths` 等 7 个。
- 验收 7（去重，决定 25、42）：`ingest.db.test.ts` / `repeated pushes of one invalid body keep one pending row and count the pushes`、`concurrent pushes of one invalid body keep one row`（8 个并发推送）、`an ignored invalid body does not come back`、`merges only byte-identical bodies`、`a body whose earlier row was resolved starts a new pending row`；`reliability.db.test.ts` 里同一份坏原文推两次的既有测试改为一行。再次推送同一原文不写第二条告警，每个测试里都断言告警条数。
- 验收 8（superseded）：`ingest.db.test.ts` / `a corrected push resolves the earlier invalid row as superseded`、`a corrected push parked as unassigned also resolves it`、`a duplicate of a registered call also resolves a later invalid row`、`an invalid row without a parsable uuid stays pending`、`does not resolve an ignored invalid row or one of another call`。
- `park()` 保存 `hangup_cause`、`unverified`（PR 1 实现）：`ingest.db.test.ts` / `keeps the hangup cause and the unverified flag of a parked call`。
- 验收 9（分区测试）：见 [partition-flake.md](partition-flake.md)。**没有复现、根因未找到、不能说已修复**，修复前后各 200 次的失败计数都是 0。
- 验收 10（共用号码用例）：`freeswitch/tests/dialed-cases.tsv`（13 条合法、32 条非法）；`packages/rating/src/dialed.test.ts` 读它；`freeswitch/tests/billing_authorize_test.lua` 读它并打印条数；`tests/dialed-cases.test.ts` / `the shared case file is well formed and read by both sides`、`the Lua test reads the same number of cases`。往文件里加一条两端结论不一致的用例（例如把合法的 `13800138000` 追加为非法）时，Lua 与 TypeScript 两边都会失败，已手动验证并还原。本机 Lua 5.5 跑 `lua freeswitch/tests/billing_authorize_test.lua` 的输出是 `dialed cases: 13 valid, 32 invalid` 加 `billing_authorize fallback tests passed`。

## 200 次循环

修复前（没有 PR 2 任何改动）单文件 200 次：目标测试失败 0 次，耗时 2025–2113 ms；CPU 满载 200 次：失败 0 次；整套 20 次：目标测试失败 0 次。修复后（加了诊断）单文件 200 次：失败 0 次，耗时 2035–2129 ms；整套 26 次（含重跑）：目标测试失败 0 次。**没有复现，所以这些数字不构成「已修复」的证据**，详见 [partition-flake.md](partition-flake.md) 和原始记录目录 [partition-flake/](partition-flake/)。

---

# 阶段 8 PR 3 证据：原始 JSON 归档与恢复

2026-10-27，本机 PostgreSQL 17.9（Docker，默认配置）、Node 24.22.1、macOS（Docker 虚拟机 10 核 7.8 GiB）。设计见 [phase-8-design.md](../../phase-8-design.md)，实现时的验证与偏差见该文末「PR 3 实现时的验证与偏差」。

## 测试结果

| 命令             | 结果                                                                                                                                                                                                                                                            | 输出                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm check`     | 退出 0：lint、格式检查、类型检查全过；根目录单元测试 46 个文件、890 通过 2 跳过；Web 单元测试 45 个文件、600 通过；Web 构建成功。跳过的 2 个与 PR 2 相同，是 Lua 测试（`billing-authorize.test.ts`、`dialed-cases.test.ts` 各一个），本机没有 `lua5.3`，CI 必跑 | [pr3-pnpm-check.txt](pr3-pnpm-check.txt)         |
| `pnpm test:db`   | 退出 0：51 个文件、734 个测试全部通过（PR 2 是 48 个文件、690 个）                                                                                                                                                                                              | [pr3-pnpm-test-db.txt](pr3-pnpm-test-db.txt)     |
| `pnpm test:idor` | 退出 0：1 个文件、35 个测试全部通过                                                                                                                                                                                                                             | [pr3-pnpm-test-idor.txt](pr3-pnpm-test-idor.txt) |

PR 2 的基线是根目录 44 个文件 849 通过 2 跳过、数据库 48 个文件 690 通过。本 PR 新增：`store.test.ts`（14）、`format.test.ts`（19）、`config.test.ts` 多 8 个（根目录共多 41 个）；数据库测试多 3 个文件 44 个：`archive.db.test.ts`（24）、`functions.db.test.ts`（12）、`apps/worker/src/archive.db.test.ts`（8）。既有测试只改了三处预期：`migrate.db.test.ts` 迁移数 19 → 20、Drizzle 表数 23 → 24，以及「每张业务表都有 tenant_id」的例外名单加入 `raw_cdr_archives`（按月清单，不属于某个租户）；`rls.db.test.ts` 的阶段 8 用例扩到 `raw_cdr_archives`。

验收 5 与相关行为对应的测试（名字同设计文档）：

- `packages/db/src/raw-archive/archive.db.test.ts`：`restores a single raw cdr byte for byte after the partition is dropped`（2305 行，含多字节 UTF-8、4 字节字符与组合字符、行分隔符与 BOM、CRLF 与行尾空白、重复键与键序、看起来像转义的字面文本、非法 JSON、空串、恰好 1 MiB 的正文、微秒 `received_at`；归档并丢弃之后逐行取回，比较**数据库里存的 UTF-8 字节**，不是 JavaScript 字符串；抽样 + 全部特殊行 + 成员边界，再用整月恢复比较整月摘要）、`finds a row whose received_at is shared with rows in the neighbouring member`、`refuses to return a body whose hash does not match`（改压缩字节；连清单一起改、只有行内哈希对不上；不存在的行；缺失的文件）、`restores a whole month with the same ids, times and bodies`（含 `payload`）、`rolls a whole-month restore back when the file no longer matches the recorded fingerprint`、`restores a month inside the grace period by attaching the detached table again`。
- 状态机与崩溃续作：`a crash after export and before detach is resumed`、`a crash after the file is published and before the manifest says verified is resumed`、`a failure after the manifest says verified continues with the detach instead of exporting again`、`a crash between detach and drop waits for the grace period and then drops`，以及分离、丢弃事务内故障时 DDL 与清单一起回滚。
- 校验不过就不分离：`a corrupted partial file blocks the detach and is thrown away`、`a row that changes between the export and the verification blocks the detach`、`a row written after the verification is caught by the database before it detaches, and the month is exported again`、`a lost or damaged archive file blocks the drop and the detached table stays`、`refuses a partition with rows linked to a tenant or a call…`。
- 宽限期：`keeps the detached table during the grace period and drops it afterwards`（差 1 秒不丢，过 1 毫秒丢）；时间窗口：`archives only months whose end plus six months has passed`（边界差 1 毫秒）。
- 重复触发：`a duplicate archive job does not archive twice`、`two runs racing for the detach end in one consistent state without a failure`；队列层面 `registers a daily 04:00 Beijing schedule and allows only one queued or active job at a time`（`exclusive` 策略，第二次 `send` 返回 null）。
- `packages/db/src/raw-archive/functions.db.test.ts`：函数权限与保护（租户身份、无身份、应用角色直接 DETACH / DROP / 读分区都被拒，持租户锁、未校验、指纹不符、内容改变时拒绝分离，未分离不能丢弃）、`raw_cdr_archives` 的状态约束与 RLS、决定 48（`ensure_month_partition gives up after two seconds instead of queueing behind a long transaction`）、DETACH 的锁行为（见下）。
- `apps/worker/src/archive.db.test.ts`：`the scheduled job archives a month older than six months and leaves a younger one alone`、`a crash after export and before detach is resumed`（任务级：失败开一条告警、重试后恢复）、告警每月一条与恢复、清单与分区矛盾只告警；取回命令逐字节输出（含真正的脚本进程）、哈希不符时什么都不输出、整月恢复命令。
- 测试能失败：逐项临时改坏实现，对应测试失败后还原——编码时丢掉原文行尾空白（验收 5 的所有测试失败）、跳过校验步骤（`a corrupted partial file…`、`a row that changes…`）、分离函数不比对指纹（`a row written after the verification…`、`refuses to detach when the partition changed…`）、去掉 `ensure_month_partition` 的 `lock_timeout`（决定 48 的测试等不到结果，20 秒超时失败）、读取时不核对原文哈希（`refuses to return a body…`）、忽略宽限期（3 个宽限期相关测试）。

## 归档一个月（PORTALBIG 量级）

原始输出：[pr3-archive-perf.txt](pr3-archive-perf.txt)（最终一次，第二次运行，全新克隆库）；[pr3-archive-perf-first-run.txt](pr3-archive-perf-first-run.txt) 是第一次运行，场景 (c) 的读者写法有问题（见文件头），其余数字可对照。脚本 `packages/db/scripts/raw-archive-perf.ts` 会写库，只在 `fs_billing_perf` 的克隆库上运行。

**夹具不是真实话单。** 2026-03 分区 246,574 行（PR 1 实测 PORTALBIG 2026-09 的话单数），按 FreeSWITCH `mod_json_cdr` 的形状用 SQL 合成：每行平均 6,696 字节、约 120 个通道变量，其中约一半的值是随机十六进制、端口、UUID，其余是固定字符串；原文共 1,574.5 MB（`design.md` 估算这样一个月约 1.7 GB）。**压缩比取决于真实话单里重复内容的多少，下面的 5.57 倍只对这份合成数据成立。** 分区刚写入，操作系统与 PostgreSQL 缓存是热的；冷分区的读取受磁盘吞吐限制，会更慢。

| 项目                                                      | 第二次运行（最终）                                     | 第一次运行            | 说明                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| 归档文件                                                  | 282.6 MB，453 个 gzip 成员                             | 同                    | 原文 1,574.5 MB，**压缩比 5.57 倍**（文件是原文的 17.9%）；`gzip -t` 1.1 s，`zcat` 整个文件 9.5–9.8 s，行数一致 |
| 导出（含 PostgreSQL 对整个分区按 `received_at, id` 排序） | 29.4 s（53.5 MB/s 原文，8,385 行/s）                   | 30.9 s                | `REPEATABLE READ` 只读事务，游标每次取 100 行，每 1000 行（或 4 MiB）结束一个 gzip 成员，`fsync`                |
| 校验                                                      | 13.3 s                                                 | 13.5 s                | 重算整个临时文件的哈希，逐成员解压、逐行重算 SHA-256，另开快照事务只传哈希，与数据库逐行比对                    |
| 发布 + 记入清单                                           | 约 0 s                                                 | 约 0 s                | `rename` + `fsync` 目录 + 一条条件 UPDATE                                                                       |
| 分离（重新核对文件哈希 + `raw_cdrs_detach_partition`）    | 2.0 s                                                  | 2.0 s                 | 其中函数持有**老分区**的 ACCESS EXCLUSIVE 锁、重算指纹扫整个分区约 1.9 s（热缓存）                              |
| 合计                                                      | 44.7 s                                                 | 46.4 s                | 每天一次的任务体里一次只做一个月                                                                                |
| `raw_cdrs` 父表被 ACCESS EXCLUSIVE 锁住的时间             | 20 ms                                                  | 11 ms                 | 2 ms 间隔轮询 `pg_locks` 看到的窗口，只有 `DETACH` + 改名那一小段                                               |
| Worker 进程                                               | RSS 峰值 338 MB；事件循环延迟 p99 7.3 ms，最大 14.1 ms | 341 MB；7.4 / 18.4 ms | 测量进程是整个脚本（含连接池），分辨率 5 ms；压缩用异步 `zlib`，不在事件循环上阻塞，Worker 与话单入库同进程     |
| 取回一条（分区已丢弃）                                    | 7–16 ms                                                | 8–16 ms               | 6 个分布在文件各处的成员：查清单 + 读一个约 1000 行的成员 + 解压 + 哈希                                         |
| 整月恢复（从文件重建，24.7 万行）                         | 69.6 s                                                 | 69.7 s                | 逐成员校验哈希，保留 `id` 与 `received_at`，用清单里的指纹核对整个分区，不符整体回滚                            |

## DETACH 的锁对并发入库的影响

入库负载在另一个进程里：4 个写入者各自插入 6 KB 原文，每次插入后停 25 ms（实测约 120 次/秒，比真实高峰高得多）。基线（只有入库）：p50 7.8 ms、p99 18.2 ms。

| 情形                                                                                               | 结果（第二次运行）                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 归档 24.7 万行的月份，入库负载同时在跑：导出阶段                                                   | 入库 p50 3.4 ms、p99 8.5 ms、最大 24.4 ms                                                                                                          |
| 同上：校验阶段                                                                                     | p50 3.7 ms、p99 10.0 ms、最大 18.6 ms                                                                                                              |
| 同上：分离这一步（文件哈希、指纹扫描、`DETACH` + 改名）                                            | p50 2.9 ms、p99 7.9 ms、**最大 8.0 ms**（280 次插入）                                                                                              |
| 没有阻塞者，2 万行的月份                                                                           | 分离 262 ms；同时的入库最大 10.2 ms                                                                                                                |
| 一个读**老分区**的长事务（分区锁被占）                                                             | 分离函数等 3 s 后以 55P03 放弃（3,029 ms），数据没动；同时的入库最大 14.1 ms，**不受影响**——函数先等老分区的锁，还没碰 `raw_cdrs` 父表             |
| 一个只读**当前月分区**、但持有 `raw_cdrs` 父表 ACCESS SHARE 的长事务（常量范围，规划时剪掉老分区） | 分离在父表锁上排队 3 s 后以 55P03 放弃（3,261 ms）；排在它后面的入库插入**停到 3,001.6 ms**（窗口内 96 次插入，p99 = 最大 = 3,001.6 ms），然后恢复 |

结论：正常情况下 `DETACH` 对入库的影响在测量噪声以内（最大 8.0 ms）。最坏情况是有一个长事务拿着 `raw_cdrs` 父表的锁：此时入库最多停 `lock_timeout`（3 s），低于 FreeSWITCH `json_cdr` 的 5 秒推送超时（`timeout=5 retries=3 delay=5`），超时的推送会重试，登记表挡住重复入账；分离本身失败、下次再来，不影响业务。分离函数先锁老分区、在没有父表锁的情况下重算指纹（要扫整个分区），最后才请求父表锁，所以排队影响入库的窗口不随分区大小增长。

`DETACH PARTITION … CONCURRENTLY` 在事务块和函数里都不能执行（[pr3-detach-concurrently.txt](pr3-detach-concurrently.txt)：`cannot run inside a transaction block`、`cannot be executed from a function`），普通 `DETACH` 加改名在函数里是事务性的，回滚后分区仍挂着。

## 局限

- 一台笔记本上的 Docker PostgreSQL，数字用来比较量级和定参数，不是生产容量承诺；上线前在目标机器和有真实历史数据的库上演练（阶段 10）。同一份脚本两次运行的差别在 5% 以内，除了第二次运行里的最大入库延迟（第一次导出阶段出现过一次 197.8 ms 的插入，第二次最大 24.4 ms）。
- 合成数据，压缩比与真实话单可能不同；热缓存，冷分区更慢。
- 归档文件在本机临时目录，没有测网络存储。
- 没有测两个 Worker 实例同时运行（`exclusive` 队列策略与清单的条件更新保证安全，有测试，没有压力测试）。

---

# 阶段 8 PR 4 证据：契约与 API

2026-10-28，本机 PostgreSQL 17.9（Docker，默认配置）、Node 24.22.1、macOS。设计见 [phase-8-design.md](../../phase-8-design.md)，实现时的验证与偏差见该文末「PR 4 实现时的验证与偏差」。

## 测试结果

| 命令             | 结果                                                                                                                                                                                          | 输出                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm check`     | 退出 0：lint、格式检查、类型检查全过；根目录单元测试 48 个文件、917 通过 2 跳过（同 PR 2、3，是本机没有 `lua5.3` 而跳过的 Lua 测试，CI 必跑）；Web 单元测试 45 个文件、600 通过；Web 构建成功 | [pr4-pnpm-check.txt](pr4-pnpm-check.txt)         |
| `pnpm test:db`   | 退出 0：55 个文件、770 个测试全部通过（PR 3 是 51 个文件、734 个）                                                                                                                            | [pr4-pnpm-test-db.txt](pr4-pnpm-test-db.txt)     |
| `pnpm test:idor` | 退出 0：1 个文件、36 个测试全部通过（PR 3 是 35 个，多出的一个登记十个新操作为 admin-only）                                                                                                   | [pr4-pnpm-test-idor.txt](pr4-pnpm-test-idor.txt) |

PR 3 的基线是根目录 46 个文件 890 通过 2 跳过、数据库 51 个文件 734 通过、越权 35 个。本 PR 新增：根目录 `operations.test.ts`（13，契约）、`suggest.test.ts`（13，编辑距离）、`cdrs.test.ts` 多 1 个（`deletedMonths`）；数据库 4 个新文件 28 个测试（`admin-unassigned.db.test.ts` 14、`admin-cdr-deletion.db.test.ts` 7、`admin-audit-logs.db.test.ts` 5、`packages/db/src/admin/audit.db.test.ts` 2，后者验证 `writeAudit` 按操作者类型写 `admin_id` 或 `actor_label`），`admin-accounts.db.test.ts` 多 3 个，`bootstrap.db.test.ts` 多 4 个；越权多 1 个。既有测试只改了两处：`cdrs.test.ts` 的后台话单响应夹具带 `deletedMonths`，Web 的 `test/cdr.ts` 夹具同理。

验收标准与延后项对应的测试（名字同设计文档「验收标准对应计划测试」，不同处见设计文档偏差第 15 条）：

- 验收 1（ABC01 → ABC001：预览 ¥58.35、324 条、2 条无费率前缀 1876；余额 −35.20 → −93.55，流水对应）：`admin-unassigned.db.test.ts` / `returns the mockup figures through the preview and assign endpoints`（在单独的、播过种子的库里，经 HTTP 预览与分配；分组里有「相近：ABC001」；分配后 324 笔 `call_charge`、2 条留在待处理）；另有无种子库的同形测试 `assigns with the previewed figures, charges once and writes one audit entry` 与 `previews the figures without writing anything`（预览不落库）。
- 验收 2（重复提交只扣费一次）：同文件 `replays the stored result for the same idempotency key`（种子库，`replayed: true`、余额不变）、`assigns with the previewed figures, charges once…` 里的同键重放、另一个操作人同键 409 `IDEMPOTENCY_CONFLICT`、不同键同一分组 409 `UNASSIGNED_NOTHING_TO_ASSIGN`；`answers 409 when the figures changed since the preview and changes nothing`（`UNASSIGNED_PREVIEW_STALE`，余额、流水、日志都没变）。数据库层的四层幂等与并发测试在 PR 1。
- 验收 3（删除当月的按钮不可用，服务端同样 409；删除 8 月后流水、余额不变）：`admin-cdr-deletion.db.test.ts` / `rejects the current month, a month without a statement, a wrong code and a changed count`（当月、开户前、编码不符 400、条数不符 409，什么都没删）、`deletes August: the ledger is untouched…`（流水条数、余额、流水摘要前后相同）、`marks a month blocked…`。门户导出与重新生成置灰是 PR 1 的数据库测试和 PR 6 的 e2e。
- 验收 4（操作日志能查到删除：谁、何时、哪个租户、哪个月、多少条）：`admin-cdr-deletion.db.test.ts` / `deletes August…`（审计行的操作人、租户、月份、条数、范围、确认编码）与 `writes one cdr_delete entry per month and finds them through the log endpoint`；`admin-audit-logs.db.test.ts` / `lists the deletion with its filters`（按租户 + 标签 + 管理员筛选，其他管理员得到空）。
- 延后项 1：`admin-accounts.db.test.ts` / `a failed audit write rolls the reset back and leaves credentials and sessions unchanged`、`a failed audit write opens one audit_failed alert without secrets`、`a failed alert write only logs: the original error still reaches the caller`。
- 延后项 2：`bootstrap.db.test.ts` / `audits a created and a replaced credential in the same transaction`、`writes the credential, the session revocation and the audit in one transaction`（审计写不进去则凭据也没创建）、`audits a rejected attempt and an unexpected failure with a fixed error code`、`audit details never contain a password, hash or token`，命令行测试里多了对 `actor_label` 的断言。
- 越权：`idor.db.test.ts` / `registers the ten phase 8 operations as admin-only` 与既有的遍历用例（未登录 401、客户会话 403，每个新端点都带合法的探测请求）；`admin-unassigned.db.test.ts` / `a deactivated administrator loses the session at once and cannot assign, ignore, delete or read`。
- 测试能失败：逐项临时改坏实现，对应测试失败后还原——`resetPassword` 不开告警（告警测试 2 个失败）、`writeAudit` 不写 `actor_label`（`packages/db/src/admin/audit.db.test.ts` 失败；`bootstrap.db.test.ts` 不受影响，因为命令行自己用原生 SQL 写审计）、日志列表不按标签展开（`lists the deletion with its filters` 失败）、`deletedMonths` 恒为空（`deletes August…` 失败）、bootstrap 成功时不写审计（`bootstrap.db.test.ts` 4 个失败，含命令行测试）。

## 耗时（经真实回环 HTTP，PORTALBIG 克隆库）

原始输出：[pr4-http-timings.txt](pr4-http-timings.txt)（最终一次）、[pr4-http-timings-second-run.txt](pr4-http-timings-second-run.txt)（同一个库、同一份代码的第二次，看波动）、[pr4-http-timings-first-run.txt](pr4-http-timings-first-run.txt)（查询优化之前的第一次，见下）。脚本 `apps/api/scripts/ops-perf-http.ts` 会写库，只在 `fs_billing_perf` 的克隆库上运行（`CREATE DATABASE fs_billing_perf_p8pr4 TEMPLATE fs_billing_perf` 约 32 s，再 `pnpm db:migrate`，迁移到 0019；白名单拒绝原库、PR 3 库和快照库）。夹具与 PR 1 的 SQL 形状测量相同：`unassigned_cdrs` 补到 10 万行待处理（40 个标签）加 2000 行已忽略，`operation_logs` 补到 100 万行（最近一年，带真实形状的 `details`）。传输方式同阶段 7：进程内 Fastify（`createApi`）监听 127.0.0.1，Node `fetch`，真实 Cookie 网关，业务连接是 `fs_billing_app`，响应整体读完并用契约 schema 解析；2 次预热加 7 次计时。

| 端点                                                                                  | 最终一次（中位数） | 第二次（中位数）   | 说明                                                            |
| ------------------------------------------------------------------------------------- | ------------------ | ------------------ | --------------------------------------------------------------- |
| `GET /api/admin/unassigned-cdrs/summary`                                              | 11.6 ms            | 12.5 ms            | 待处理 / 已忽略条数                                             |
| `GET /api/admin/unassigned-cdrs/groups`（10 万待处理，41 组）                         | 23.2 ms            | 23.8 ms            | 分组、原因分布、相近租户                                        |
| `GET /api/admin/unassigned-cdrs?pageSize=50`（第 1 页）                               | 10.1 ms            | 10.3 ms            | 含 `count(*)` 约 8 ms                                           |
| 同上，第 1000 页（offset 49,950）                                                     | 18.7 ms            | 19.1 ms            |                                                                 |
| 同上，`tag=TAG07`（2500 行）/ `status=ignored`（2000 行）                             | 2.3 ms / 2.2 ms    | 2.8 ms / 2.8 ms    |                                                                 |
| `GET /api/admin/audit-logs`（默认最近 30 天，6.7 万行匹配，50 条）                    | 8.6 ms             | 11.8 ms            | 100 万行表                                                      |
| 加租户 / 加标签 `cdr_delete` / 加租户 + 标签 + 管理员                                 | 6.4 / 5.9 / 5.2 ms | 6.7 / 6.1 / 6.1 ms | 最近 30 天                                                      |
| 整年范围（100 万行）第 1 页                                                           | 88.1 ms            | 87.3 ms            | 计数 100 万行约 85 ms（`operation_logs_created` 仅索引扫描）    |
| 整年范围，`page=2001`（offset 100,000）                                               | 583 ms             | 582 ms             | 计划切换，见下                                                  |
| 整年范围，`label=unassigned_assign`，每页 100 条                                      | 12.3 ms            | 11.5 ms            | 10 万行匹配                                                     |
| `GET /api/admin/tenants/{PORTALBIG}/cdr-deletions?year=2026`（12 个月，340 万行话单） | 2259 ms            | 2347 ms            | 与 PR 1 的数据库层一致（2.26–3.28 s）；页面只在打开对话框时请求 |

### 第一次运行发现的问题与处理

第一版列表查询把 `to_char` 和联接放在 `OFFSET` 之前：深翻页时数据库要先格式化、联接 `OFFSET + LIMIT` 行再丢掉前面的。整年范围 offset 100,000 是 1.3 s，未归属第 1000 页是 48 ms（PR 1 的 SQL 形状分别是 190 ms 和 25 ms）。改成子查询里先排序、分页，外层再联接和格式化后分别是 0.58 s 和 19 ms。

### 操作日志深翻页的计划切换

整年范围下，应用角色（RLS 生效）的查询计划在 `OFFSET` 超过约 2000（第 40 页起）时从 `operation_logs_created` 索引扫描变成全表扫描加磁盘排序：`staff_only` 策略条件让规划器把行数估成 5000，认为全排序更便宜。100 万行约 0.2–0.6 s，线性随表增长，owner 没有这一层所以 PR 1 的测量看不到（[pr4-audit-deep-page-plan.txt](pr4-audit-deep-page-plan.txt)）。默认的最近 30 天范围和前 39 页不受影响。真实数据量远小于 100 万行；增长到这个量级时改成按 `(created_at, id)` 的游标分页，本 PR 不处理。

## 局限

- 一台笔记本上的 Docker PostgreSQL，数字只用于比较量级，不是生产容量承诺；两次运行的差别在 10% 以内（默认日志列表第二次有一次 23.8 ms 的离群值）。
- 夹具的 100 万行操作日志只有 10 种 action、2 个管理员，`details` 是合成的；真实日志按租户、管理员的分布不同。「按管理员筛选」仍然没有专用索引（PR 1 已记录）。
- 删除接口（POST）没有经 HTTP 计时：数据库层 0.89 s 是 PR 1 的测量，本 PR 只测月份格。
- 种子库里的接口测试不测耗时。

---

# 阶段 8 PR 6 证据：验收

## PR 6 验收记录

PR 6 是阶段 8 的验收收尾：补全 e2e、视觉对照、plan 逐项勾选、验收映射表核对。基线是 `main` 的 `c5d0964`（PR #71 合并之后，网页已改用 shadcn/ui），分支 `phase-8-pr6-acceptance`。设计见 [phase-8-design.md](../../phase-8-design.md#pr-6-验收收尾)。没有改动任何产品代码，只有 e2e、文档与证据。

### 完整检查

2026-10-29 依次在本工作区运行，**全部在隔离的 PostgreSQL 17.9 容器**（独立端口，每个阶段新库，用后删除；没有碰共用的开发容器）上。`pnpm test:e2e` 前库刚迁移、播种，`pnpm test:db` 与 `pnpm test:idor` 用该容器里的 `fs_billing_test`。

| 命令                                 | 结果                                                                                                                                                                                                                                             | 记录                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `pnpm check`                         | 退出码 0：lint、format:check、typecheck 通过；根目录 48 个文件 920 项通过、2 项跳过（本机没有 `lua5.3` 的两个 Lua 测试，CI 必跑）；Web 49 个文件 643 项通过；Web build 成功                                                                      | [pr6-pnpm-check.txt](pr6-pnpm-check.txt)             |
| `pnpm test:db --reporter=verbose`    | 退出码 0：56 个文件 771 项通过（每项测试名都在记录里）                                                                                                                                                                                           | [pr6-pnpm-test-db.txt](pr6-pnpm-test-db.txt)         |
| `pnpm test:idor`                     | 退出码 0：1 个文件 36 项通过（`app` 与 `owner` 两条车道，OpenAPI 覆盖检查通过）                                                                                                                                                                  | [pr6-pnpm-test-idor.txt](pr6-pnpm-test-idor.txt)     |
| `pnpm test:e2e`                      | 退出码 0：131 项通过、6 项跳过（跳过的是需要 `FSB_VISUAL=1` 的五个视觉脚本 `admin-visual`、`portal-visual`、`admin-statements-visual`、`portal-statements-visual`、`admin-ops-visual`，和需要 `FSB_ABC01_ASSIGN=1` 的 `admin-unassigned-abc01`） | [pr6-pnpm-test-e2e.txt](pr6-pnpm-test-e2e.txt)       |
| `FSB_ABC01_ASSIGN=1` 的 ABC01 分配   | 退出码 0：1 项通过（刚播种、跑完上面的 e2e 的库上；ABC001 −35.20 → −93.55）                                                                                                                                                                      | [pr6-e2e-abc01-assign.txt](pr6-e2e-abc01-assign.txt) |
| `FSB_VISUAL=1` 的 `admin-ops-visual` | 1 项通过，`index-admin-ops.json` 54 项无 error（刚播种的库）                                                                                                                                                                                     | [visual-diff.md](../phase-8-web/visual-diff.md)      |
| `FSB_VISUAL=1` 的 `portal-visual`    | 1 项通过（修复气泡悬停后，见下）；输出写到临时目录，不覆盖阶段 6 的存档                                                                                                                                                                          | —                                                    |

没有失败。第一次 `pnpm check` 因为我的一个临时调试脚本（`apps/web/tmp-dbg.mjs`，未提交）没过 lint，已删除并重跑，记录是重跑后的结果。基线（PR #71 合并后，加本 PR 之前）的 e2e 是 119 项通过、4 项跳过，本 PR 新增 12 项通过和 2 个默认跳过的脚本（`admin-ops-visual`、`admin-unassigned-abc01`）。

### plan 勾选

plan 阶段 8 的 10 项验收勾选 9 项，**1 项不勾**。每项的依据是本次 `pnpm test:db`、`pnpm test:e2e` 里通过的具名测试（名字已逐个用 grep 核对在 [pr6-pnpm-test-db.txt](pr6-pnpm-test-db.txt) 里，e2e 的在 [pr6-pnpm-test-e2e.txt](pr6-pnpm-test-e2e.txt) 里）。

| plan 阶段 8 验收项                                                                  | 结果                     | 依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 种子数据下把 ABC01 的 326 条分配给 ABC001（¥58.35、324、2）                         | 已勾选                   | `packages/db/src/unassigned/assign.db.test.ts` / `previews 326 ABC01 rows against ABC001 as 324 assignable, 58.35 and 2 without a rate`、`assigning charges 58.35 and writes one call_charge per assignable row`、`the September statement becomes stale after the assignment and is not regenerated`；`apps/api/src/admin-unassigned.db.test.ts` / `returns the mockup figures through the preview and assign endpoints`；e2e `admin-unassigned.spec.ts` / `previews the whole ABC01 group against ABC001 without charging anything`、`assigns a group to the nearest tenant, charges it once and writes the ledger and the audit`；真实种子上的 `admin-unassigned-abc01.spec.ts`（[输出](pr6-e2e-abc01-assign.txt)）                                                                     |
| 同一批重复提交分配，只扣费一次                                                      | 已勾选                   | `assign.db.test.ts` / `submitting the same batch twice charges once`、`assigns a row once when two admins submit at the same time`、`a second claim of the call uuid fails with call_uuids_pkey`；`admin-unassigned.db.test.ts` / `replays the stored result for the same idempotency key`；e2e 同键重放（`replayed: true`）、换新键 409、流水与余额不变；`admin-unassigned-abc01.spec.ts` 在 326 条真实种子上同样重放                                                                                                                                                                                                                                                                                                                                                                     |
| 删除当月话单的按钮不可用；删除 8 月后余额、账单不变，导出提示已删除，重新生成不可用 | 已勾选                   | `packages/db/src/cdr-deletion/delete.db.test.ts` / `rejects the current month and a month without a statement`、`deleting August leaves the ledger, balance, statement header and breakdown unchanged`、`flags the statement and removes the rows in one transaction`；`apps/api/src/admin-cdr-deletion.db.test.ts` / `rejects the current month, a month without a statement, a wrong code and a changed count`、`deletes August: the ledger is untouched, the audit names who, when, which tenant, month and count`；e2e `admin-cdr-deletion.spec.ts` / `disables the current month, deletes August after the typed code, and shows the deleted notices`（前后快照相等、导出明细与重新生成置灰）、`the server refuses the current month and a wrong code even when the page is bypassed` |
| 操作日志能查到删除：谁、何时、哪个租户、哪个月、多少条                              | 已勾选                   | `delete.db.test.ts` / `writes one cdr_delete audit per month with actor, time, tenant, month and count`；`apps/api/src/admin-audit-logs.db.test.ts` / `lists the deletion with its filters`；e2e `admin-audit-logs.spec.ts` / `finds the deletion by admin, type and tenant, and expands the before and after`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 归档后恢复一条原始 JSON，逐字节相同                                                 | 已勾选                   | `packages/db/src/raw-archive/archive.db.test.ts` / `restores a single raw cdr byte for byte after the partition is dropped`、`refuses to return a body whose hash does not match`、`restores a whole month with the same ids, times and bodies`；`apps/worker/src/archive.db.test.ts` / `the scheduled job archives a month older than six months and leaves a younger one alone`、`prints the stored body byte for byte, without a trailing newline, from the archive alone`                                                                                                                                                                                                                                                                                                              |
| 校验失败原因不再保存冗长 Zod 消息                                                   | 已勾选                   | `apps/worker/src/ingest.db.test.ts` / `stores a short structured reason for a failed validation`、`stores a validation failure of an empty object without the Zod message`；`packages/shared/src/worker.test.ts` / `summarizes issues to at most five paths`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 无 UUID 校验失败话单重推去重                                                        | 已勾选                   | `ingest.db.test.ts` / `repeated pushes of one invalid body keep one pending row and count the pushes`、`concurrent pushes of one invalid body keep one row`、`an ignored invalid body does not come back`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 修正重推成功后旧 pending 移除或标记已解决                                           | 已勾选                   | `ingest.db.test.ts` / `a corrected push resolves the earlier invalid row as superseded`、`a corrected push parked as unassigned also resolves it`、`an invalid row without a parsable uuid stays pending`（最后一项是已接受的局限，决定 49）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 分区维护 DB 测试偶发超时：排查根因并修复                                            | **勾选（按未复现关闭）** | 修复前后各 200 次（另有 200 次 CPU 满载、20 次整套）目标测试 0 次失败，此后各次运行也未复现，根因未找到，不能说不稳定已消除，再次出现则重新打开；已加失败时的锁等待快照与测试库的锁等待日志，`ensure_month_partition` 加 `lock_timeout`（决定 48）。本 PR 的整套 `test:db` 里该测试通过。见 [partition-flake.md](partition-flake.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Lua 与 `dialed.test.ts` 共用号码用例                                                | 已勾选                   | `tests/dialed-cases.test.ts` / `the shared case file is well formed and read by both sides`；`packages/rating/src/dialed.test.ts` 读 `freeswitch/tests/dialed-cases.tsv`；`freeswitch/tests/billing_authorize_test.lua` 读同一个文件。本机没有 `lua5.3`，Lua 一侧由 CI 运行（PR 2 记录里本机用 Lua 5.5 手动跑过）                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

第 9 项不勾是 PR 2 就定下的结论（[决定 48](../../phase-8-design.md#已决定)、[partition-flake.md](partition-flake.md)），本 PR 没有新证据可以改变它，只在这里重述；是否把它当作已关闭由用户决定。

### 延后项

| 延后项                                          | 结果   | 依据                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 重置密码的审计写入失败接入 `system_alerts`      | 已完成 | 保持原子（决定 40）：`apps/api/src/admin-accounts.db.test.ts` / `a failed audit write rolls the reset back and leaves credentials and sessions unchanged`、`a failed audit write opens one audit_failed alert without secrets`；plan.md 的延后项文字已更正为「已由阶段 5 原子化，阶段 8 加告警与回归测试」 |
| owner `auth:bootstrap` 补写操作审计             | 已完成 | `apps/api/src/bootstrap.db.test.ts` / `audits a created and a replaced credential in the same transaction`、`audits a rejected attempt and an unexpected failure with a fixed error code`、`audit details never contain a password, hash or token`；`packages/db/src/audit.db.test.ts` 的函数与权限断言    |
| plan 阶段 9「通用无效输入每次重推仍重复写告警」 | 已更正 | 按决定 42 缩成「无效输入告警的合并展示与恢复」（plan.md 阶段 9 验收第 7 项）：阶段 8 已让同一份坏原文再次推送不再写第二条告警                                                                                                                                                                              |

### 新增的 e2e（12 项，另有 2 个默认跳过的脚本）

PR 5 只有「话单页出现删除按钮」一条断言。本 PR 补的覆盖（每个都有自己的租户与标签，不碰 ABC001 和种子的 ABC01 组，日期不依赖运行日）：

| 文件                              | 用例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-unassigned.spec.ts`（5）   | `lists the seeded ABC01 and empty-tag groups and filters the list by group`（分组卡片、相近租户提示、按分组筛选、地址参数）；`previews the whole ABC01 group against ABC001 without charging anything`（324 / ¥58.35 / 2 与无费率说明，取消后余额不变）；`assigns a group to the nearest tenant, charges it once and writes the ledger and the audit`（预览、确认、结果页、受影响月份、导航角标 −3、同键重放与换键 409、流水与余额、操作日志）；`ignores a row with a required reason, lists it under 已忽略, restores it, and keeps the badge in step`；`shows the pending count in the navigation badge and in the tab` |
| `admin-cdr-deletion.spec.ts`（3） | `disables the current month, deletes August after the typed code, and shows the deleted notices`（当月不可选、预览与时间范围、大小写与部分输入的编码确认、完成页、流水与账单前后快照相等、话单标签页已删除提示条、账单页导出明细与重新生成置灰、对话框里 8 月变为已删除、操作日志）；`deletes a two-month range one month at a time and audits each month`；`the server refuses the current month and a wrong code even when the page is bypassed`                                                                                                                                                                        |
| `admin-audit-logs.spec.ts`（4）   | `finds the deletion by admin, type and tenant, and expands the before and after`；`finds the assignment under 归属话单 with its tag, count and balance change`；`restores filters from the address on reload and reset clears them`（含非法筛选值单独丢弃）；`shows the empty state for a filter without matches and clears it`（含日期范围早于所有记录）                                                                                                                                                                                                                                                                 |
| `admin-unassigned-abc01.spec.ts`  | `assigns the ABC01 group to ABC001: 324 rows charged 58.35, 2 without a rate stay, a replay charges nothing`：在刚播种的库上真实改动 ABC001（−35.20 → −93.55），其余 e2e 依赖 ABC001 的种子数字，所以默认跳过，`FSB_ABC01_ASSIGN=1` 且排在其余用例之后才运行，跑完要重建数据库                                                                                                                                                                                                                                                                                                                                            |
| `admin-ops-visual.spec.ts`        | 视觉对照脚本（`FSB_VISUAL=1`），见 [visual-diff.md](../phase-8-web/visual-diff.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

共用夹具在 `apps/web/e2e/ops.ts`（带费率表的租户加「拼写错误」标签的待处理话单、8 月 9 月账单已生成且核对通过的租户），数据库辅助在 `db.ts`（`recordUnassigned`、`tenantBalance`、`callChargeEntries`、`cdrTotals`、`ledgerAndStatementSnapshot`）。`db.ts` 里 `setStatementFlags` 的过期注释（「阶段 8 的删除话单尚未开发」）已更新。

**与日期无关：** 待处理话单的接通时刻取数据库当前时间（租户的费率版本从创建起生效，所以不依赖运行日），补扣费落在运行当月；删除用例用固定的 2026-08、2026-09（这两个月永远是已结束月份），「当月不可选」按运行日算出当月再找格子，年份格先在当前年里看当月、再翻到 2026 年；导航角标与待处理数都从接口读，不写死 338。

**`portal-visual.spec.ts` 的气泡：** 原来悬停固定日期 `2026-09-28` 的柱子，这天已移出 30 天窗口。窗口的日期来自接口（服务端的「今天」），不是浏览器时钟，所以冻结页面时钟（`page.clock`）没有用；改成键盘聚焦图表后气泡默认落在今日柱上（稿 1a 的气泡本来就画在今日柱上），与种子日期、窗口位置无关。PR 5 对 `portal-home.spec.ts` 做过同样的处理。

### 设计里点名的测试与实际名字

用 grep 核对了[验收映射](../../phase-8-design.md#验收标准对应计划测试)原先点名的每个测试名，下面几个没有以原名创建，映射表已改成实际名字：

| 设计里点名                                                                                                | 实际存在的测试                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admin-unassigned.spec.ts` / `assigns the ABC01 group to ABC001`                                          | 夹具租户上的 `assigns a group to the nearest tenant, charges it once and writes the ledger and the audit`；预览 ABC01 → ABC001 的 `previews the whole ABC01 group against ABC001 without charging anything`；改动真实种子的 `admin-unassigned-abc01.spec.ts`（默认跳过） |
| `admin-cdr-deletion.db.test.ts` / `returns 409 for the current month`                                     | `rejects the current month, a month without a statement, a wrong code and a changed count`                                                                                                                                                                               |
| `admin-cdr-deletion.spec.ts` / `disables the current month, deletes August and shows the deleted notices` | `disables the current month, deletes August after the typed code, and shows the deleted notices`（门户一侧的置灰由既有 `portal-statements.spec.ts` 覆盖）                                                                                                                |
| `admin-audit-logs.spec.ts` / `finds the deletion by admin, type and tenant`                               | `finds the deletion by admin, type and tenant, and expands the before and after`                                                                                                                                                                                         |

### 视觉对照

23 个有画框的状态各浅色与深色共 46 张对照图，另存档 8 张，见 [visual-diff.md](../phase-8-web/visual-diff.md)。差异分已接受（12 项）、shadcn 迁移带来的（8 项）和待用户决定（7 项，P1 至 P7）。没有改产品代码。

### 没有做的事

- 没有在 PORTALBIG 上重测耗时（阶段 8 plan 没有性能验收，PR 1、3、4 已记录）。
- 手机端之外的宽度、动画、真实打印没有人工看（见 visual-diff.md「没有被这批截图覆盖的」）。
- 没有改产品代码：发现的差异与产品观察只记录。产品观察：删除完成页的「查看」是 `<a href>`，点击整页刷新，没有走前端路由。
