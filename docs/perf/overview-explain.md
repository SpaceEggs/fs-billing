# 租户概况 SQL 的 PostgreSQL 17 执行计划

2026-10-17 在 PostgreSQL 17 上实测 `GET /api/admin/tenants/{id}/overview` 背后的 `readTenantUsageOverview`（`packages/db/src/usage.ts`）。

- **索引**：大、小租户的未接通统计都走 migration 0010 的分区子索引 `cdrs_2026_10_tenant_id_started_at_idx`，其他月份分区被裁剪。
- **耗时**：测试中的大租户 60 天有 200 万条 CDR，约合单租户每月 100 万通，修复后函数调用中位数为 428 ms，修复前为 828 ms。小租户约 3.7 ms。
- **结论**：当前全部客户合计每月不到 100 万通，按现有规模满足 200 ms 门槛。耗时大致与单个租户聚合的行数成正比，推算单租户每月约 30 万通以内都能满足（已为月底"本月"数据变多留了余量）。这个上限是推算值，没有实测。超过这个量时再考虑按天汇总，见[剩余差距](#剩余差距)。

| 大租户，ms | 函数调用中位数 | `TIMING OFF` 执行中位数 | 生产形式函数调用 |
| ---------- | -------------- | ----------------------- | ---------------- |
| 修复前     | 828.481        | 860.281                 | 775.792          |
| 修复后     | 428.305        | 438.132                 | 392.119          |

"函数调用"是在 Node 中对 `withAdmin(db, tx => readTenantUsageOverview(...))` 计时的结果，包含事务开关和网络往返，作为验收数字。"`TIMING OFF` 执行"是对同一条 SQL 执行 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)` 得到的服务端时间。带逐节点计时的计划只用来分析各分支耗时，它的计时开销在百万行节点上不可忽略。每轮原始数据见 [修复后 timings.json](overview-explain/timings.json) 和 [修复前 timings.json](overview-explain/baseline/timings.json)。

## 修复内容

`bounds` CTE 被多处引用，因此会被物化。修复前，`daily_spend` 通过 `cross join bounds` 取日期边界，规划器只能把 30 天的日期条件放在 Nested Loop 的 Join Filter 里，没法放进 `ledger_entries_tenant_occurred_at` 的 Index Cond。大租户占这份数据集流水的 99%，所以规划器选了顺序扫描：读取 140 万行，再丢掉其中的 71 万行，这一支约 600 ms。

修复做了两处改动：

1. `daily_spend` 的上下界改为从 `bounds` 取值的非相关标量子查询。它们变成 InitPlan 参数，进入流水索引的 Index Cond，扫描只读取窗口内的 68.8 万行。其他分支和跨月语义不变。
2. 在函数所在事务内执行 `set local jit = off`。psql 中 5 轮对照显示，关闭 JIT 能让修复后的查询再快约 60 ms（约 450 ms 降到约 390 ms）。

修复前后的计划都通过 `fs_billing_app` 角色、`READ ONLY` 事务和 `app.scope=admin` 运行，与接口的 RLS 身份一致，见 [app-identity.json](overview-explain/app-identity.json)。

修复后大租户的 [计划](overview-explain/large-1.txt)：

```text
->  Index Scan using ledger_entries_tenant_occurred_at on ledger_entries l  (actual time=0.023..197.180 rows=688334 loops=1)
      Index Cond: ((tenant_id = '...0001'::uuid) AND (occurred_at >= (InitPlan 2).col1) AND (occurred_at < (InitPlan 3).col1))
...
->  Bitmap Index Scan on cdrs_2026_10_tenant_id_started_at_idx  (actual time=12.242..12.242 rows=550000 loops=1)
      Index Cond: ((tenant_id = '...0001'::uuid) AND (started_at >= b_2.month_start) AND (started_at < b_2.month_end))
```

修复前的 [计划](overview-explain/baseline/large-1.txt)：

```text
->  Nested Loop  (actual time=187.622..553.439 rows=688334 loops=1)
      Join Filter: ((l.occurred_at >= ...) AND (l.occurred_at < ...))
      Rows Removed by Join Filter: 711666
      ->  Seq Scan on ledger_entries l  (actual time=0.010..169.934 rows=1400000 loops=1)
```

8、9 月分区中，未接通分支的 0010 子索引都是 `never executed`，11 月空分区的 `Seq Scan` 也是 `never executed`。已接通分支仍按 `(tenant_id, answered_at)` 统计，它不能加 `started_at >= month_start`，因为上月开始、本月接通的通话也应计入。

被否决的方案：把 `bounds` 改成 `not materialized`。用固定时间测时变快，但生产形式（`statement_timestamp()`）下已接通分支改为顺序扫描 10 月分区，没有收益。原始数据见 [inline-experiment](overview-explain/inline-experiment/timings.json)。

## 剩余差距

修复后的逐节点计划中各分支耗时（含计时开销，不能相加）：30 天每日消费约 230 ms，聚合 68.8 万行流水；已接通约 125 ms，38.5 万行 CDR；本月消费约 60 ms，38.5 万行流水；未接通约 50 ms，扫描 55 万行、计入 16.5 万行。

曾在本库临时建 `ledger_entries (tenant_id, occurred_at) INCLUDE (amount) WHERE kind = 'call_charge'` 覆盖索引测试，两条流水分支都变成 `Heap Fetches: 0` 的 index-only scan，但在 psql 中 5 轮只从约 388 ms 降到约 335 ms。测完已删除该索引，没有写入 migration。瓶颈在逐行做 numeric 求和和时区换算，不在 I/O。所以对每月百万级通话的租户，单条 SQL 实时聚合原始行，很难在 200 ms 内完成。

如果单个租户接近每月 100 万通，还要满足 200 ms，可以选下面一种做法，都需要另行决策：

1. **按天汇总**：增加按 `(tenant_id, 北京日期)` 汇总的消费和话单计数表，扣费和入库时同步累加，或由 Worker 定时补齐。概况改为读取 30 行汇总，再加当天实时增量。这要新增 migration 和写入路径，并改动 `monthConsumption` 的共用定义。
2. **按租户规模分级门槛**：保持现状。每月百万通的租户约 430 ms，后台详情页可以接受。

合并本月消费和每日消费为一次流水扫描，预计能再省约 50 ms，但仍到不了 200 ms，还会让 `monthSpend` 和列表页 `monthConsumption` 不再共用 `tenantMonthSpendSql`，因此未做。

## 数据和环境

测量环境为本地 OrbStack Docker，ARM64 PostgreSQL 17.9，10 个逻辑 CPU，约 8 GiB 内存。服务器使用默认配置：`shared_buffers=128MB`、`work_mem=4MB`、`random_page_cost=4`、`max_parallel_workers_per_gather=2`、`jit=on`（函数内按事务关闭）。完整设置见 [fixture.json](overview-explain/fixture.json)。

数据是合成的，不含客户数据：20 个租户，共 2,019,000 条 CDR、1,413,300 条通话扣费流水、400 条调账。大租户有 200 万条 CDR，其余 19 个租户各 1,000 条。每个租户 70% 接通并扣费 0.02 CNY（计 2 分钟），20% `NO_ANSWER`，10% `CALL_REJECTED`。另有 20 条正负调账，这些调账不应计入消费。CDR 均匀分布在北京时间 2026-08-18 12:00 至 2026-10-17 12:00 之间。固定 `asOf=2026-10-17T04:00:00Z`。

注意：大租户占流水的 99%，所以修复前单靠 `tenant_id` 条件时规划器选了顺序扫描。在真实的多租户分布下，规划器更可能改走 `(tenant_id, occurred_at)` 索引，但日期条件仍只是过滤，大租户全部流水还是要读一遍。表现形式不同，根因相同，本次修复对两种分布都适用。合成数据把拒绝通话的 `unverified` 置为 `true`，本查询不读取该列。

每轮先调用函数，并用独立公式核对本月接通、未接通、计费分钟、消费和 30 天序列，然后在同样的事务设置下（含函数里的 `set local`）解释抓取到的同一条 SQL。生产形式不传 `now`，这一轮会断言返回的 `asOf` 与 `PERF_AS_OF` 在同一个北京自然日，否则数据窗口不可比，脚本直接失败。

这些都是单连接、本地、预热后的测量，不代表冷启动、HTTP 延迟或并发容量。

## 复现

使用独立的本地 PostgreSQL 17 数据库。脚本只允许回环地址和名为 `fs_overview_perf` 的数据库；`seed` 模式要求租户表为空。生产形式那一轮必须在 `PERF_AS_OF` 对应的北京日期当天运行，换日期需要用新的空库重新造数。

```sh
docker run --detach --name fs-overview-perf-pg17 \
  -e POSTGRES_PASSWORD=overview-local-only \
  -e POSTGRES_DB=fs_overview_perf \
  -p 127.0.0.1:55432:5432 postgres:17.9-alpine

export PERF_DATABASE_URL=postgresql://postgres:overview-local-only@127.0.0.1:55432/fs_overview_perf
export PERF_APP_DATABASE_URL=postgresql://fs_billing_app:overview-local-only@127.0.0.1:55432/fs_overview_perf
export PERF_AS_OF=2026-10-17T04:00:00Z

pnpm --filter @fs-billing/db exec tsx scripts/overview-explain.ts seed
pnpm --filter @fs-billing/db exec tsx scripts/overview-explain.ts explain
```

`explain` 默认写入 `docs/perf/overview-explain/`，也可以把输出目录作为第二个参数传入。修复前的数据是用同一脚本对 `8d6359e` 的 `usage.ts` 运行得到的，写入 `baseline/`。

## 仓库验收

2026-10-17 执行 `pnpm check`：根测试 513 项通过、1 项跳过，前端测试 370 项通过。在同一 PostgreSQL 17.9 实例上执行 `pnpm test:db`：24 个文件、386 项通过。
