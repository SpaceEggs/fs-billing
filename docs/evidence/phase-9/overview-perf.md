# 概览与系统告警接口经 HTTP 的耗时（阶段 9 PR 6）

设计「性能」一节要求：`GET /api/admin/overview` 在 PORTALBIG（340 万话单、285 万笔流水）上的耗时，以及 `auth_timeout` 详情按租户统计 `cdrs.unverified` 的耗时。评审后又要求测告警详情里「通知记录」查询（发件箱 5 万行）。

## 方法

独立的 PostgreSQL 17.9 容器（本机、无调优），用 `packages/db/scripts/balance-notice-perf.ts setup` 建 PORTALBIG 形状的库（300 万话单、285 万笔流水、50 个租户），再由 `apps/api/scripts/overview-perf-http.ts` 把 PORTALBIG 的话单与流水补到测量当天（补后约 313 万话单、299 万笔流水，其中 540 条未验证话单）、`system_alerts` 补到 10 万行（31 条进行中，含一条持续 40 天的 `auth_timeout`）、`email_outbox` 补到 5 万行（180 天内，告警通知的快照带告警 id，其中 125 封属于被测告警）。请求经进程内 Fastify（`createApi`）的回环 HTTP，真实 cookie 网关，`fs_billing_app` 业务角色，响应完整读完并按契约 schema 解析；2 次预热加 7 次计时。库名白名单 `fs_billing_perf_*`，不碰其他库。原始输出如下。

```
# Phase 9 PR 6: admin overview and system alerts over real loopback HTTP on a PORTALBIG-shaped perf database
# 2026-10-29T21:05:26.407Z database fs_billing_perf_p9pr6
# PostgreSQL 17.9 on aarch64-unknown-linux-musl
# transport: in-process Fastify app (createApi) on 127.0.0.1, node fetch, real cookie gateway, fs_billing_app business role, response body fully read and parsed with the contract schema; 2 warmups + 7 measured rounds
# data: 3130495 cdrs (540 unverified), 2989284 ledger entries, 51 tenants, 100001 system alerts (31 open)
# email_outbox: 50000 rows (180 days, alert notices carry the alert id; 125 belong to the measured alert)

## Overview
GET /api/admin/overview: n=7 min 203.4 median 212.5 max 230.4 ms, response 4561 bytes, today CNY 133.02, month CNY 18359.030, 3308 minutes, alerts open 31 / 24h 363
  samples ms: 220.1, 220.9, 230.4, 212.5, 211, 204, 203.4

## System alerts
GET /api/admin/system-alerts/summary: n=7 min 11.4 median 11.8 max 13 ms, response 70 bytes, open 31, last24h 363
  samples ms: 11.7, 12.7, 11.4, 11.8, 13, 11.8, 11.9
GET /api/admin/system-alerts?window=24h: n=7 min 21.1 median 22.2 max 23.4 ms, response 8280 bytes, 25 rows of 363
  samples ms: 21.7, 21.1, 21.8, 22.8, 22.9, 23.4, 22.2
GET /api/admin/system-alerts (default: 30d, page 1): n=7 min 39.3 median 40.3 max 41.9 ms, response 8282 bytes, 25 rows of 10803
  samples ms: 41.9, 40.3, 40.1, 39.3, 40.3, 39.5, 41.3
GET /api/admin/system-alerts?window=all&page=2000&pageSize=50 (offset 99,950): n=7 min 60.6 median 62.4 max 67.8 ms, response 18122 bytes, 50 rows of 100001
  samples ms: 65.5, 67.8, 62.4, 61.9, 62.4, 60.6, 62.5
GET /api/admin/system-alerts?window=all&status=open&kind=auth_timeout: n=7 min 2 median 2.2 max 3.1 ms, response 409 bytes, 1 rows of 1
  samples ms: 3.1, 2.8, 2.4, 2.2, 2, 2.2, 2.1
GET /api/admin/system-alerts/{auth_timeout, open 40 days, capped at 30 days}: n=7 min 199 median 202.9 max 205.6 ms, response 5014 bytes, PORTALBIG:540, truncated true, range 2026-10-17..2026-10-30
  samples ms: 205.6, 205.4, 203, 200.2, 202.9, 202.2, 199
GET /api/admin/alert-settings: n=7 min 1.4 median 1.5 max 1.5 ms, response 67 bytes, version 1, mailEnabled true
  samples ms: 1.5, 1.5, 1.5, 1.5, 1.5, 1.4, 1.5
```

## 结论

- **概览中位数约 212 ms（203–230 ms）**：含近 30 天按币种的消费聚合（流水一次扫描）、今日 / 本月聚合、今日分钟（话单）、待收款、租户状态、未归属、告警，全部在一个 `repeatable read` 只读事务内。没有超出预期，所以**不加 `asOf` 缓存**；退路仍是设计里的每分钟缓存。流水没有以 `occurred_at` 开头的索引，聚合是顺序扫描，耗时随流水总量线性增长；未实测更大的数据量。
- **`auth_timeout` 详情约 203 ms**（持续 40 天，只统计最近 30 天，扫当月与上月分区；含通知记录查询）。
- **通知记录查询**（发件箱 5 万行，按快照里的告警 id 匹配，取最新 50 封）：顺序扫描 5 万行加 JSONB 展开，**13.7 ms**（`EXPLAIN ANALYZE`），所以**不加索引、没有迁移 0024**。第一次测详情是 319 ms，原因是 PostgreSQL 对这个查询启用了 JIT 编译（`EXPLAIN` 里 147 ms 的 JIT 开销）；详情事务因此 `set local jit = off`，降到 203 ms。
- 告警列表 24–62 ms（10 万行，深翻页 offset 99,950 为 62 ms）；汇总 13 ms；设置 1.6 ms。
- 未测：真实接通话单的宽行会让话单扫描读更多页；冷缓存；并发请求；发件箱超过 5 万行（180 天保留期内的量）。

## D1–D8 复测（2026-10-30）

同一脚本、PostgreSQL 17.9、隔离容器，3,133,818 条话单、2,992,461 笔流水、51 个租户和 100,001 条告警；2 次预热、7 次经 HTTP 的完整响应和契约解析均成功。概览耗时 665.4–1032.5 ms，中位数 878.2 ms，7 次分别为 1032.5、889.3、776.2、944.7、665.4、775.5、878.2 ms。本次与数据库和浏览器测试并发，机器负载较高，不可与上面的空闲基线直接比较；该数字不能证明性能回归或改进。

最新待处理话单查询在播种后 `ANALYZE`，`EXPLAIN (ANALYZE, BUFFERS)` 显示 `Limit → Index Scan using unassigned_cdrs_status_time`，338 条待处理中的首行读取 3 个共享缓存页，执行 0.065 ms；因此未新增索引。测量不覆盖冷缓存或大量并发。

余额更新微测沿用 PR 3 的 `trigger-per-update.sql`：在 PORTALBIG 的同一缓存余额行，每轮一个回滚事务更新 20,000 次，交替替换 0023 与 0024 触发器函数（均启用），各 5 轮。0023 为 301.23、195.55、299.14、135.05、134.01 µs/次，中位数 195.55；0024 为 199.68、239.01、297.00、125.83、138.31 µs/次，中位数 199.68，差值 +4.13 µs/次。运行时与数据库测试并发，轮次范围高度重叠，差值小于波动，不能认定有可测的性能变化；这一微测是不越线的热路径，不代表越线写状态和入队的成本。

PR 3 的 `balance-notice-perf.ts run` 也已完成（每种状态 5 轮，每轮 4,000 笔、8 个并发工作者，真实扣费事务；未新增余额通知）。停用 / 启用 0024 触发器的吞吐中位数：单租户 234.9 / 223.7 笔/秒，40 租户 513.3 / 564.2 笔/秒。该比较含整个 0023/0024 触发器，不能单独归因于 0024；运行中机器负载变化明显，范围和各轮见 [原始结果](balance-notice-perf/charge-throughput-d1-d8.json)，不据此宣称性能改善或回归。
