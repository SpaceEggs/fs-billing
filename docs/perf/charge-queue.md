# 扣费队列吞吐（阶段 10）

2026-11-04 在本机开发笔记本、独立的 PostgreSQL 17.9（项目 `p10-charge` 的容器，端口 55437，不是共享开发库）上实测。对象是 Worker 的 `charge-cdr` 队列：修复前 pg-boss 默认每次只领取 1 个任务、每 2 秒轮询一次，单实例上限约 0.5 个/秒；阶段 10 设计要求每秒 10 通、30 分钟 18,000 通，并要求压测结束后 10 分钟内排空。

**结论：** 单实例从 **0.5 个/秒** 提到 **191 个/秒**，两个实例 **460.6 个/秒**；18,000 条积压按实测速率约 94 秒（一个实例）或 39 秒（两个实例）排空，对 10 分钟静置窗口分别约有 6.4 倍和 15 倍余量。空队列时仍按 pg-boss 默认 2 秒轮询，空闲数据库负载与修复前相同。

## 环境与方法

- 机器：Darwin 27.0.0，10 个逻辑 CPU，16 GiB 内存；测量时没有刻意停掉其他开发进程。
- 数据库：`fs_billing_perf_charge_queue`，由脚本 `setup` 删除重建后执行与 `pnpm db:migrate` 相同的迁移，并安装 pg-boss 队列。只允许回环地址和 `fs_billing_perf_*` 库。
- 数据：每次 `run` 新建 6 个租户，每个租户一条 `447` 前缀、0.048 元/分钟的费率版本；再插入 N 条真实 `cdrs` 行（接通、190 秒、4 个计费分钟），任务数据只有 `{tenantId, callUuid}`，与生产一致。扣费走真实的 `chargeCdr`（租户锁 + 读费率快照 + `appendLedgerEntry` + 余额触发器）。
- 队列：真实 pg-boss 12.37.1 与 `createBoss`；每个实例有独立的业务连接池（`WORKER_DB_POOL_MAX=10`）和队列池（`WORKER_QUEUE_POOL_MAX=2`）。入队使用生产的 `chargeQueue` 与调用方事务。
- 计时：先把 N 个任务全部入队，记录时间后注册 `boss.work`；等到本批任务全部 `completed` 且没有 `created`/`retry`/`active` 结束。入队时间不计入排空时间。
- 修复前（`before`）：`batchSize: 1`、无 burst、无 `perJobResults`，任务抛错让整批失败，即修复前的行为。
- 修复后（`after`）：`WORKER_CHARGE_BATCH_SIZE` 默认 10、`burstWhenBatchFull: true`、`perJobResults: true`。
- 脚本：[apps/worker/scripts/charge-queue-perf.ts](../../apps/worker/scripts/charge-queue-perf.ts)。原始结果：[before-1](charge-queue-before-1.json)、[before-2](charge-queue-before-2.json)、[after-1](charge-queue-after-1.json)、[after-2](charge-queue-after-2.json)。

## 结果

| 变体   | 实例 | 任务数 |   排空用时 | 吞吐（个/秒） | 余额 = 流水合计 |
| ------ | ---: | -----: | ---------: | ------------: | --------------- |
| 修复前 |    1 |    180 | 358,265 ms |           0.5 | 是              |
| 修复前 |    2 |    180 | 178,179 ms |           1.0 | 是              |
| 修复后 |    1 |  5,000 |  26,179 ms |         191.0 | 是              |
| 修复后 |    2 |  5,000 |  10,856 ms |         460.6 | 是              |

修复前的 0.5 个/秒与冒烟测试「360 条约 10 分钟」是同一量级（按 0.5 个/秒推算 360 条约 12 分钟）。修复后单实例是设计要求的约 19 倍，两个实例约 46 倍；两个实例不是简单翻倍，因为租户锁和数据库 CPU 开始成为限制。

按这些速率推算 18,000 条积压：修复前单实例约 10 小时、两个实例约 5 小时；修复后单实例约 94 秒、两个实例约 39 秒。10 分钟静置窗口对修复后的余量约 6.4 倍与 15 倍。

## 为什么选这个改法

pg-boss 的 `work` 默认 `batchSize = 1`、`pollingIntervalSeconds = 2`，每轮只取一个任务，所以 0.6 个/秒不是数据库慢，而是轮询节奏。一次领取 10 个任务后，单个 Worker 串行处理它们，数据库仍只占用 1 个业务连接；取满一批时 `burstWhenBatchFull` 立即继续取，直到一次取不满才回到 2 秒轮询。空闲时没有额外查询，活跃时把「每个任务一次轮询」变成「每 10 个任务一次轮询」。

没有采用的替代：

- **只把 `pollingIntervalSeconds` 降到 0.5**：空闲时每个实例每秒多出 2 次空查询；单实例最多约 2 个/秒，仍不够 10 个/秒的余量。
- **只加 `localConcurrency`**：每个并发 Worker 都独立轮询并占用一个业务连接。10 个 Worker 在空闲时每秒 5 次查询，且会挤压 `/authorize`、`/cdr` 共用的 10 连接池；本次单实例批处理已经 191 个/秒，不需要。
- **`burstWhenReadyExceeds`**：它依赖队列统计缓存（默认 60 秒刷新），从空队列突然起量时反应慢；`burstWhenBatchFull` 只看上一次 fetch 是否取满，立即生效。
- **`transactional: true`**：会把整批扣费和任务确认放在一个长事务里，一个坏任务回滚整批，且长时间占用连接；与「单个坏任务不影响邻居」相反，不采用。

重试次数、`retryDelay`、死信行为没有改动：队列仍是 `retryLimit: 3`、`retryDelay: 0`，只是每个任务独立结算。

## 失败与一致性

- 批内逐单结算：`chargeJobs` 捕获每个任务的异常，成功返回 `completed`，失败返回 `failed`，pg-boss 分别确认/重试。一个毒任务不会让同批已成功的任务重跑。
- 幂等：流水唯一键仍是 `call:<UUID>`，任务重投读回同一笔流水；余额触发器与流水在同一事务提交。
- 并发：每个任务先 `lockTenants` 再写流水，同一租户按同一把 advisory 锁串行，不同租户可并行；多租户一次加锁的既有规则未变。
- 测试：`apps/worker/src/charge-batch.db.test.ts` 覆盖同批毒任务、重投不重扣、同租户并发加多租户无死锁、两个 pg-boss 实例同时消费，以及排空期间 `/authorize` 仍返回成功。测试中的 `/authorize` p95 断言为小于 2 秒，实际运行在本机通过。

## 复现

```sh
# 只在本机独立 PostgreSQL 上运行，会删除并重建 fs_billing_perf_charge_queue。
pnpm --filter @fs-billing/worker perf:charge-queue setup

pnpm --filter @fs-billing/worker perf:charge-queue run -- \
  --variant before --instances 1 --jobs 180
pnpm --filter @fs-billing/worker perf:charge-queue run -- \
  --variant after --instances 1 --jobs 5000
```

`--variant before` 保留修复前的领取方式用于对照；`--instances` 可设为 2。`PERF_OWNER_URL` / `PERF_APP_URL` 可覆盖默认派生的性能库地址，但必须仍指向 `fs_billing_perf_*` 且在本机回环地址。

## 没有覆盖的部分

- 不是生产服务器，也不是 30 分钟 SIPp 压测；没有 FreeSWITCH、SIPp、nginx 和真实运营商流量。
- 两个实例是同一进程内两个独立的 `PgBoss` 与连接池，不是两个独立操作系统进程；跨机器/跨进程的领取竞争由现有 `multi-instance.db.test.ts` 和 pg-boss 的 `SKIP LOCKED` 语义覆盖，但本报告没有重复做跨主机测量。
- 没有做数小时长稳、数据库重启、网络分区或磁盘冷缓存。
