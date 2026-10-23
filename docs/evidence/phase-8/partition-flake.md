# 分区维护 DB 测试偶发超时：排查记录（阶段 8 PR 2）

结论先行：**没有复现，根因没有找到，不能说问题已消除。** 修复前后各 200 次的失败计数都是 0。PR 2 只做了能从代码和实测证明的事：失败时输出锁等待快照、测试库打开锁等待日志、评估 `lock_timeout`。plan.md 这一项不勾选，见最后一节。

## 被测对象

`apps/worker/src/app.db.test.ts` 的「启动维护立即建分区，每日北京时间调度可重复运行」。它 `drop table cdrs_<下月>, raw_cdrs_<下月>`，启动分区维护（立即建回分区并注册 pg-boss 工作者和每日调度），再 `boss.send` 一个任务并用 `expect.poll(…, { timeout: 10000 })` 等它 `completed`；整个测试受 `vitest.db.config.ts` 的 `testTimeout` 20 秒限制，`fileParallelism: false`。

## 环境与方法

2026-10-23，PostgreSQL 17.9（OrbStack 里的 Docker，`compose.yaml`）、Node 24.22.1、vitest 5.0.4，一台 10 核 Mac。方法是设计里写的循环：单文件重复运行，逐次记录目标测试的状态与耗时（脚本 [run-loop.sh](partition-flake/run-loop.sh)、[summarize.mjs](partition-flake/summarize.mjs)），每次运行都经过 `global-setup` 在全新的 `fs_billing_test` 上迁移播种。修复前的几组都在没有任何改动的 `main`（PR 1 合并后）的拷贝上运行，库名改成另一个，以免和开发工作冲突；服务器上另设了 `log_lock_waits = on`、`deadlock_timeout = 200ms`（`ALTER SYSTEM`，结束后复原）。

| 组                                         | 次数 | 目标测试失败 | 整次运行有失败 | 目标测试耗时 ms（最小 / 中位 / 最大） | 原始记录                                                                             |
| ------------------------------------------ | ---- | ------------ | -------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| 修复前，单文件，机器空闲                   | 200  | **0**        | 0              | 2025 / 2068 / 2113                    | [before-200-single-file.tsv](partition-flake/before-200-single-file.tsv)             |
| 修复前，单文件，10 个 CPU 满载进程同时运行 | 200  | **0**        | 0              | 2054 / 2107 / 2341                    | [before-200-…-cpu-loaded.tsv](partition-flake/before-200-single-file-cpu-loaded.tsv) |
| 修复前，整套 `test:db`（48 个文件）        | 20   | **0**        | 1（见下）      | 2029 / 2061 / 2101                    | [before-20-full-suite.tsv](partition-flake/before-20-full-suite.tsv)                 |
| 修复后（加了诊断），单文件，机器空闲       | 200  | **0**        | 0              | 2035 / 2060 / 2129                    | [after-200-single-file.tsv](partition-flake/after-200-single-file.tsv)               |
| 修复后（加了诊断），整套 `test:db`         | 20   | **0**        | 3（见下）      | 2053 / 2067 / 2082                    | [after-20-full-suite.tsv](partition-flake/after-20-full-suite.tsv)                   |

「修复前」指没有 PR 2 任何改动；「修复后」的改动只有诊断（见下），没有改变被测行为，所以后两行只能说明加了诊断没有让测试变坏，**不能**说明不稳定已消除。

目标测试每次耗时 2.0–2.3 秒，正好是 pg-boss 工作者默认 2 秒轮询一次加上执行，离 10 秒的等待上限和 20 秒的测试超时都很远；满载 CPU 只把最大值推到 2.3 秒。

### 异常记录

- **整套 20 次里有 1 次整体失败（第 6 次），不是目标测试。** 失败的是 `admin/tenants.db.test.ts` 的「creates entries, CSV and copied initial rates…」（20 秒超时，实际 40.8 秒）以及 `assign.db.test.ts` 的 4 个测试被跳过。这一次运行用了约 12.9 分钟（别的次数约 2 分钟），第 5 次与第 6 次之间有约 11 分钟的空档，PostgreSQL 日志里同一段也没有任何记录，同时 macOS 的备份任务（`backupd`）在跑，可以认为是宿主机/虚拟机整体停顿，不是测试自身的问题；目标测试在这次运行里是通过的（2057 ms）。
- **修复后整套 20 次里第 18 至 20 次整体失败，不是目标测试。** 失败的是 `admin-rates.db.test.ts`、`admin/rates.db.test.ts`、`auth.db.test.ts` 里几个用主机时间对数据库时间的测试（`Date.now() + 1000` 排期、「temporary credential issuance must be a finite, non-future timestamp」等），目标测试每次都通过。原因是 Docker 虚拟机的时钟落后了主机：第 18 次运行用了约 17.5 分钟（别的次数约 2 分钟），PostgreSQL 日志里最后一行的时间比日志文件的写入时间早 15.6 分钟，实测主机减数据库时钟差 936 秒。这与上面修复前第 6 次的停顿是同一类现象（宿主机整体停顿一段时间，虚拟机时钟没有跟上）。我用 `date -s` 把虚拟机时钟对回主机后重跑了 3 次整套（[after-full-suite-rerun-1.tsv](partition-flake/after-full-suite-rerun-1.tsv)），**仍然 3 次都在同一个测试**「maps activation during a tenant lock wait…」失败，我没有查明原因（对时精度只有秒，残余的亚秒偏差就足以让这个用 `Date.now() + 1000` 排期的测试失败，但我没有验证）；之后单独跑该文件和整套 `test:db` 都通过，再重跑 3 次整套（[after-full-suite-rerun-2.tsv](partition-flake/after-full-suite-rerun-2.tsv)）3 次全部通过。目标测试在这 26 次整套运行里都通过，耗时 2037–2082 ms。
- **修复后单文件循环中途被打断。** 跑到第 125 次时 OrbStack 的 Docker 引擎失去响应（`docker ps` 不返回，PostgreSQL 连接超时），第 126 次卡在全局准备里。我退出并重启了 OrbStack，重新启动 PostgreSQL 容器（数据卷完好，崩溃恢复正常），把剩下的 75 次作为第二段重新跑完；合并后的 200 次记录在 `after-200-single-file.tsv`（前 125 次为第一段，后 75 次为第二段）。这与 PR 无关，但说明本机偶发的整体停顿足以制造「偶发超时」，值得在判断 CI 上的真实偶发时先排除。
- 每次运行保存的 PostgreSQL 日志里混有之前运行的内容（`docker logs --since` 的时区没有生效），只能按内容判断：全部循环日志里**唯一**出现过的关系级锁等待（`AccessExclusiveLock on relation … ` 与排在它后面的 `AccessShareLock`）都属于下一节手动演示用的临时库，没有一条来自循环里的测试库；其余锁等待都是 `lock_tenants` 的租户级 advisory lock（并发入库、扣费、分配类测试里本来就会排队，等待 200–1100 ms）。

## 没有复现时能从代码得出什么

设计里列了三个候选原因：

1. **DDL 锁队列效应。** `drop table` 和 `CREATE TABLE … PARTITION OF` 都要 `cdrs`/`raw_cdrs` 的 ACCESS EXCLUSIVE，被任何读过这张表的长事务挡住，之后所有读写都排在它后面。**这个机制是真的**，用临时库实测：一个读过 `cdrs` 的事务持有 6 秒，一次缺分区的 `cdr_ensure_partitions` 排队等待，期间后到的普通 `SELECT count(*) FROM cdrs` 被挡了 4.1 秒，直到长事务提交才一起放行。**但没有证据表明测试里出现过**：修复前后共 600 次单文件运行（含 200 次 CPU 满载）和 40 次整套运行的 PostgreSQL 日志里，没有一条来自测试库的关系级锁等待；我也没有在这个测试之前的测试里找到会长期持有 `cdrs` 的事务，但没有逐个核查过它之前的全部测试。
2. **轮询窗口不够。** 目标测试在全部运行中的耗时最大 2.34 秒，离 10 秒有 4 倍以上余量，没有迹象。
3. **任务被别的测试遗留的同名队列任务抢走。** 代码里往 `maintain-cdr-partitions` 队列入队、注册工作者的只有 `app.db.test.ts` 这个文件（`grep` 全仓库的 `src`）；这个测试之前的一个测试只写了一行随即回滚的调度。别的文件不会往这个队列发任务，所以没有遗留任务可抢；没有迹象。

### `ensure_month_partition` 的 `lock_timeout`

设计要求评估。结论是**该加，但不在 PR 2 改**：在同一个临时库上给函数 `SET lock_timeout = '2s'`，同样的演示里建分区在 2 秒后以 `canceling statement due to lock timeout`（55P03）失败（Worker 会记 `partition_failed` 告警，pg-boss 重试），被挡住的普通读只等了 1.1 秒。不在 PR 2 改是因为这要一个新迁移，而 0019 预留给 PR 3，两个 PR 并行会撞编号；日常维护提前建一个月的分区，命中「已存在」直接返回，不会取锁。建议并进 PR 3 的迁移（它本来要写带 `lock_timeout` 的分离函数），列为待用户确认。

## PR 2 做了什么

- 测试失败时的诊断：等不到 `completed` 时，错误消息里带任务状态、`retry_count`、本库非空闲会话（含等待事件和 `pg_blocking_pids`）和尚未获得的锁（`lockSnapshot`，`apps/worker/src/app.db.test.ts`）。把等待上限临时改成 100 ms 验证过输出格式（任务状态 `created`、会话和等待锁为空），已还原。
- 测试库打开锁等待日志：`packages/db/test/global-setup.ts` 里 `ALTER DATABASE fs_billing_test SET log_lock_waits = on`、`deadlock_timeout = '200ms'`（需要超级用户，开发库和 CI 的 owner 都是）。日志里会有等待者、持有者和语句。
- 没有放宽任何超时，没有改 `ensure_month_partition`，没有改被测的生产代码。

## 下一步（谁来做）

plan.md 的「分区维护 DB 测试偶发超时」不勾选。下次在 CI 或本机真实出现这个测试超时，用失败消息里的快照和 PostgreSQL 日志里的锁等待就能直接看出是谁挡住了谁；到那时再改根因。如果希望提前加固，只有上面的 `lock_timeout` 一项是有实测依据的。
