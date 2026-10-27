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
