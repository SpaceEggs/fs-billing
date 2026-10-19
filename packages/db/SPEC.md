---
id: db
type: module-design
title: db — 数据库、身份与账本
status: draft
parent: architecture
depends-on: [rating, shared]
---

# db — 数据库、身份与账本

## 职责

PostgreSQL 访问层：手写 SQL 迁移与对应的 Drizzle 描述、RLS 会话身份、账本与余额缓存、费率版本读写、管理后台服务、门户读模型、统计口径、话单分区维护、重试与不可用映射、种子数据。

## 边界

- 依赖 `rating`（金额与费率类型、计算）与 `shared`（契约类型）；不依赖 Fastify、React 或任何服务代码。
- API 与 Worker 通过导出的服务函数与 `schema` 访问数据；业务写入必须发生在 `withTenant` / `withAdmin` / `withSystem` 事务内。
- 管理后台的写入服务是 `db-admin`；`portal/` 只提供只读读模型，没有写入口。

## 不变量

- 每个业务表带 `tenant_id`；RLS 策略在未声明 `app.scope` 时一律拒绝。应用角色 `fs_billing_app` 没有 BYPASSRLS；`auth` schema 用 `fs_billing_auth` 角色单独连接。
- 写业务行前取租户锁（`lockTenants`）；余额由流水触发器维护，`appendLedgerEntry` 用幂等键（通话扣费为 `call:<UUID>`）保证重投不重复扣费。
- 流水只追加，改错用反向调账冲正。
- 费率是整表版本快照，历史版本不可修改，只能追加新版本；同一租户同一时间最多一个排定的未来版本。
- `cdrs` 与 `raw_cdrs` 按月分区，只在维护路径创建；持有租户锁的事务里建分区会报 SQLSTATE 55000。
- 基础设施失败与业务错误分开映射：`DatabaseUnavailableError` 只表示数据库不可用，调用方据此返回 503。
