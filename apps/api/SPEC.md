---
id: api
type: module-design
title: api — 门户与管理后台 HTTP 接口
status: draft
parent: architecture
depends-on: [db, shared]
---

# api — 门户与管理后台 HTTP 接口

## 职责

Fastify 服务，对公网提供 `/api` 下的登录、门户与管理后台接口，并生成 OpenAPI。负责请求校验、身份与权限、统一错误形状、限流与请求日志；业务规则交给 `db` 服务。

## 边界

- 依赖 `db` 与 `shared`，并通过 `api-auth` 完成登录与会话。
- 只从登录身份取租户编号，从不读取网址或请求体里传来的租户参数。
- 不自写业务 SQL；只读查询也走 `db` 导出的 schema 与身份事务。

## 不变量

- 每个端点登记在 `shared` 的契约里；OpenAPI 由运行时契约生成，越权测试枚举全部客户端点（`pnpm test:idor`）。
- 错误响应统一为 `apiErrorSchema` 形状（`error.code` 加中文 `message`）；认证、会话、停用与强制改密的区分见 `api-auth`。
- 登录与改密有独立限流；强制改密之前的可达端点由白名单控制。
