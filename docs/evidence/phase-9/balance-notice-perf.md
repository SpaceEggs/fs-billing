# 余额通知触发器对扣费吞吐的影响（阶段 9 PR 3）

2026-10-29，本机 Docker PostgreSQL 17.9（aarch64，`shared_buffers` 默认值）、Node 24.22.1。设计依据：[phase-9-design.md「判定放在哪里」](../../phase-9-design.md#判定放在哪里tenant_balances-的触发器)——触发器在扣费热路径上，PR 3 要在 PORTALBIG 上测加触发器前后的扣费吞吐，影响大时退到「触发器只记待判定表、tick 批量判定」。

**结论：没有可测量的影响，保留触发器，不需要退到延迟判定。** 租户锁串行的最坏情形（PORTALBIG 单租户）扣费吞吐中位数 247.3 → 242.8 笔/秒（−1.8%，在轮间波动之内）；40 个租户并行 776.3 → 772.1 笔/秒（−0.5%）。触发器本身每次余额变化约 +11 微秒，相对一笔约 4 毫秒的扣费事务是 0.3%；越线那一次（写状态行加一封邮件）约 +0.2 毫秒，只发生在通知时。

## 环境与数据

- 数据库：新建的 `fs_billing_perf_p9pr3`（容器 `fsb-p9pr3-pg`，测完已删），迁移到 0023，种子 10 个租户，再用 `packages/db/scripts/balance-notice-perf.ts setup` 灌 PORTALBIG 形状的数据：PORTALBIG 租户 3,000,000 条话单、2,850,000 笔扣费流水（跨 2025-10 至 2026-10，13 个月分区）、一笔 10 亿的预存，另有 40 个小租户（`PERFMT01`–`PERFMT40`，各 100 万预存）。库大小 2296 MB；测量结束时 PORTALBIG 有 3,041,600 条话单、2,891,601 笔流水（测量自己写入的）。[setup.txt](balance-notice-perf/setup.txt)
- **这不是 `fs_billing_perf` 里的那份历史 PORTALBIG**（那份在共享开发库容器的卷里，本 PR 不碰）：行数、分区跨度、索引与那份一致（同一套迁移），话单里的号码、国家等取值是合成的，没有话单登记表 `call_uuids` 的行（扣费路径不读它）。余额 10 亿，所以扣费不会越线，测的是「状态不变」的热路径。
- 数据灌入时用 `session_replication_role = replica` 跳过触发器与外键（超级用户），灌完把缓存余额对齐到流水合计，再按迁移的回填口径补状态行，`ANALYZE`。
- 机器：10 核、8 GB 的 Docker 虚拟机；测量时机器上还有别的开发进程（负载平均 6–9），所以单次读数有噪声，下面用交替顺序加中位数抵消。

## 方法

`packages/db/scripts/balance-notice-perf.ts run`：每一轮先灌 4000 条新的可扣费话单（接通、61 秒、0.05 元/分钟），再用 8 个并发工作者跑**真实的** `chargeCall`（与 Worker 的 `chargeCdr` 相同：`lockTenants` + 读话单费率快照 + 写流水 + 流水触发器 + 缓存余额触发器）。「停用」就是迁移之前的状态：`ALTER TABLE tenant_balances DISABLE TRIGGER tenant_balances_notice`（0023 在扣费路径上只增加这一个触发器；`tenants` 上的那个只在开户时执行）。两种状态每轮交替，先后顺序逐轮对调，每个场景 5 轮、每轮每种状态 4000 笔，另有各 800 笔预热不计。

两个场景：

1. **PORTALBIG 单租户**：全部扣费落在同一个租户，被租户锁串行，所以吞吐就是「一笔事务的耗时」的倒数，触发器的耗时全部落在关键路径上，是最坏情形。p50 约 31 ms 是 8 个工作者在锁上排队，不是单笔耗时（单笔约 1 / 247 ≈ 4 ms）。
2. **40 个租户轮流**：8 个并发工作者，租户锁几乎不排队。

## 结果（5 轮的中位数）

| 场景      | 状态               | 笔/秒 | p50 (ms) | p95 (ms) | p99 (ms) |
| --------- | ------------------ | ----- | -------- | -------- | -------- |
| PORTALBIG | 触发器停用（之前） | 247.3 | 30.94    | 42.56    | 55.25    |
| PORTALBIG | 触发器启用（之后） | 242.8 | 32.93    | 41.42    | 56.59    |
| 40 个租户 | 触发器停用（之前） | 776.3 | 10.12    | 13.39    | 15.56    |
| 40 个租户 | 触发器启用（之后） | 772.1 | 10.04    | 13.94    | 16.92    |

逐轮的笔/秒：

| 场景      | 停用                              | 启用                              |
| --------- | --------------------------------- | --------------------------------- |
| PORTALBIG | 262.1、232.7、243.0、247.3、250.5 | 263.0、256.1、225.6、242.8、152.9 |
| 40 个租户 | 318.0、776.3、778.9、795.4、763.1 | 889.2、757.0、772.1、789.8、697.5 |

读法：同一状态下轮与轮之间的波动（PORTALBIG 232–263，机器忙时有 152.9 和 697.5 这样的离群值；40 个租户的第一轮 318 是冷缓存）比两个状态之间的差大，所以差异不能从这些数据里分辨出来；中位数相差 −1.8% 和 −0.5%。没有丢弃任何样本。全部原始数据：[charge-throughput.json](balance-notice-perf/charge-throughput.json)、标准输出 [charge-throughput.txt](balance-notice-perf/charge-throughput.txt)。测量期间发件箱里没有新增余额通知（`balanceNoticesQueuedDuringRun = 0`），证明测到的确实是不越线的热路径。

## 触发器本身的耗时

吞吐对比受机器噪声影响，所以另测触发器本身：同一事务里对 PORTALBIG 的缓存余额连续 `UPDATE` 20,000 次（回滚，不改库），交替启用与停用，5 轮（脚本 [trigger-per-update.sh](balance-notice-perf/trigger-per-update.sh)，输出 [trigger-per-update.txt](balance-notice-perf/trigger-per-update.txt)；脚本里的 `/tmp/p9pr3-*.sql` 路径指向同目录下同名的 `.sql` 文件）：

| 状态 | 每次 UPDATE（微秒，5 轮）         | 中位数 |
| ---- | --------------------------------- | ------ |
| 停用 | 96.1、101.4、97.0、100.6、102.4   | 100.6  |
| 启用 | 112.1、120.2、109.0、107.1、113.9 | 112.1  |

触发器每次余额变化约多 11.5 µs（`UPDATE` 本身约 100 µs 是在同一行上连续更新的数字，包含元组版本链）。相对一笔扣费事务（约 4 ms，其中读话单、写流水、租户锁、提交）是 0.3%。

**越线路径**（写状态行并入队一封邮件）：同一事务里让一个小租户的余额在阈值上下来回 3,000 次，每个来回越线一次、重新上膛一次（[trigger-crossing.txt](balance-notice-perf/trigger-crossing.txt)）：停用 63.8–68.7 µs，启用 262.7–280.9 µs，每个来回约 +205 µs，其中一封邮件入队加两次状态行 upsert。只发生在通知的那一笔，一个租户一轮低余额一次。

## 复现

```
docker run -d --name fsb-perf-pg -e POSTGRES_DB=fs_billing -e POSTGRES_USER=fs_billing -e POSTGRES_PASSWORD=… -p 127.0.0.1:55443:5432 postgres:17.9-alpine
export PERF_OWNER_URL=postgresql://fs_billing:…@127.0.0.1:55443/fs_billing_perf_p9pr3
export PERF_APP_URL=postgresql://fs_billing_app:local-app-only@127.0.0.1:55443/fs_billing_perf_p9pr3
pnpm --filter @fs-billing/db exec tsx scripts/balance-notice-perf.ts setup                       # 约 72 s
pnpm --filter @fs-billing/db exec tsx scripts/balance-notice-perf.ts run --out result.json      # 约 6 分钟
```

库名必须以 `fs_billing_perf_` 开头，脚本会 `DROP DATABASE` 后重建，只允许回环地址。
