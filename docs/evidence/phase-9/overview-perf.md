# 概览与系统告警接口经 HTTP 的耗时（阶段 9 PR 6）

设计「性能」一节要求：`GET /api/admin/overview` 在 PORTALBIG（340 万话单、285 万笔流水）上的耗时，以及 `auth_timeout` 详情按租户统计 `cdrs.unverified` 的耗时。

## 方法

独立的 PostgreSQL 17.9 容器（本机、无调优），用 `packages/db/scripts/balance-notice-perf.ts setup` 建 PORTALBIG 形状的库（300 万话单、285 万笔流水、50 个租户），再由 `apps/api/scripts/overview-perf-http.ts` 把 PORTALBIG 的话单与流水补到测量当天（补后 313 万话单、299 万笔流水，其中 538 条未验证话单）、`system_alerts` 补到 10 万行（31 条进行中，含一条持续 40 天的 `auth_timeout`）。请求经进程内 Fastify（`createApi`）的回环 HTTP，真实 cookie 网关，`fs_billing_app` 业务角色，响应完整读完并按契约 schema 解析；2 次预热加 7 次计时。库名白名单 `fs_billing_perf_*`，不碰其他库。原始输出如下。

```
# Phase 9 PR 6: admin overview and system alerts over real loopback HTTP on a PORTALBIG-shaped perf database
# 2026-10-29T20:05:41.486Z database fs_billing_perf_p9pr6
# PostgreSQL 17.9 on aarch64-unknown-linux-musl
# transport: in-process Fastify app (createApi) on 127.0.0.1, node fetch, real cookie gateway, fs_billing_app business role, response body fully read and parsed with the contract schema; 2 warmups + 7 measured rounds
# data: 3130156 cdrs (538 unverified), 2988960 ledger entries, 51 tenants, 100001 system alerts (31 open)

## Overview
GET /api/admin/overview: n=7 min 191.6 median 194.7 max 205.7 ms, response 4560 bytes, today CNY 107.05, month CNY 18333.060, 2664 minutes, alerts open 31 / 24h 363
  samples ms: 197.5, 194.2, 191.6, 194.7, 193.5, 194.7, 205.7

## System alerts
GET /api/admin/system-alerts/summary: n=7 min 11 median 11.4 max 12.5 ms, response 70 bytes, open 31, last24h 363
  samples ms: 11.4, 11, 11.6, 12.5, 11.9, 11.3, 11.4
GET /api/admin/system-alerts?window=24h: n=7 min 20.6 median 21.4 max 22.9 ms, response 8279 bytes, 25 rows of 363
  samples ms: 20.8, 20.6, 21.1, 21.8, 22.9, 21.5, 21.4
GET /api/admin/system-alerts (default: 30d, page 1): n=7 min 39 median 39.7 max 40.5 ms, response 8281 bytes, 25 rows of 10803
  samples ms: 39, 40.5, 39.7, 39, 39.7, 39.7, 39.3
GET /api/admin/system-alerts?window=all&page=2000&pageSize=50 (offset 99,950): n=7 min 59.6 median 60.5 max 65.1 ms, response 18122 bytes, 50 rows of 100001
  samples ms: 61.1, 60.5, 59.6, 60.2, 65.1, 65, 60.4
GET /api/admin/system-alerts?window=all&status=open&kind=auth_timeout: n=7 min 2 median 2 max 2.1 ms, response 409 bytes, 1 rows of 1
  samples ms: 2.1, 2.1, 2, 2, 2, 2.1, 2
GET /api/admin/system-alerts/{auth_timeout, open 40 days, capped at 30 days}: n=7 min 282.6 median 293.7 max 453.3 ms, response 657 bytes, PORTALBIG:538, truncated true, range 2026-10-17..2026-10-30
  samples ms: 322.2, 293.7, 453.3, 282.6, 292.6, 305.2, 283
GET /api/admin/alert-settings: n=7 min 1.4 median 1.6 max 1.7 ms, response 67 bytes, version 1, mailEnabled true
  samples ms: 1.6, 1.5, 1.7, 1.6, 1.4, 1.6, 1.7
```

## 结论

- **概览中位数约 195 ms（191.6–205.7 ms）**：含近 30 天按币种的消费聚合（流水一次扫描）、今日 / 本月聚合、今日分钟（话单）、待收款、租户状态、未归属、告警，全部在一个 `repeatable read` 只读事务内。没有超出预期，所以**不加 `asOf` 缓存**；退路仍是设计里的每分钟缓存。流水没有以 `occurred_at` 开头的索引，聚合是顺序扫描，耗时随流水总量线性增长；未实测更大的数据量。
- **`auth_timeout` 详情约 290 ms**（持续 40 天，只统计最近 30 天，扫当月与上月分区）；一次扫描同时得到前 5 个租户和话单时间范围。冷首次最大 453 ms。
- 告警列表 20–60 ms（10 万行，深翻页 offset 99,950 为 60 ms）；汇总 11 ms；设置 1.6 ms。
- 未测：真实接通话单的宽行会让话单扫描读更多页；冷缓存；并发请求。
