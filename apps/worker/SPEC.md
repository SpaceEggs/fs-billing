---
id: worker
type: module-design
title: worker — FreeSWITCH 接口与扣费任务
status: draft
parent: architecture
depends-on: [db, rating, shared]
---

# worker — FreeSWITCH 接口与扣费任务

## 职责

面向 FreeSWITCH 的内网服务（`/authorize`、`/cdr`）与后台任务：话单去重与入库、扣费入账、扣费对账补投、话单分区维护。

## 边界

- 依赖 `db`、`rating`、`shared`；不使用 `api` 的会话身份，写路径一律 `withSystem` 事务加租户锁。
- 与 `freeswitch` 之间只有 HTTP 契约；不对外网开放，只监听回环或内网地址，并校验来源 IP 白名单与 `X-Billing-Key`。
- 计费号码归一化调用 `rating` 的 `resolveBillingNumber`，不另写一套。

## 不变量

- 收到的正文原样写入 `raw_cdrs` 后再解析；解析失败也保留原文。坏话单返回 200 并停放，不返回 400，避免 FreeSWITCH 丢弃话单。
- 去重键是 `call_uuids` 里的通话 UUID；登记与事务级 `app.cdr_ingest` 标记保证并发插入只有一条成功，重推返回 `duplicate`。
- 话单插入与 `charge-cdr` 入队在同一事务提交；队列失败时两者与 UUID 登记全部回滚，返回 503 供重推。
- 号码投影不一致的话单以「计费号码不一致」停放，不写正式话单、不入队、不记账；每个 UUID 只写一条告警。
- 授权与话单都先转大写再匹配租户编码（`upper(tenants.code)`），`abc001` 与 `ABC001` 等价。
- 扣费按已保存的计价快照与 `call:<UUID>` 幂等键入账；对账任务只补应有流水而缺失的话单，一通话最多告警一次。
- 分区维护在启动时与每日北京时间零点执行；入库时缺分区记录告警并返回 503，不在写入事务里建分区。

## 已知限制

- Worker 故障或授权超时时由 `freeswitch` 侧放行 1800 秒并标记 `billing_unverified`；这些话单照常计费，计费系统不会主动断开已放行的通话。
- 未归属话单只落库，没有自动重放，也还没有后台认领界面。
