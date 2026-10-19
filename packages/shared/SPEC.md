---
id: shared
type: module-design
title: shared — 共享契约与 Zod 类型
status: draft
parent: architecture
---

# shared — 共享契约与 Zod 类型

## 职责

为 HTTP 与 Worker 契约提供唯一的 Zod 定义与推断类型：Worker 的授权/话单请求与响应、门户与管理后台各端点 schema、统一错误码、金额与导出格式、北京时间与日范围工具、hangup cause 映射。

## 边界

- 只依赖 zod；不依赖数据库、Web 框架或 DOM。API 与 Web 都从它取类型。
- 契约就是网络边界：API 用同一 schema 校验请求并生成 OpenAPI，Web 用同一 schema 解析响应，别处不重复定义请求/响应类型。

## 不变量

- 端点契约由 `apiContract`、`portalLedgerApiContract`、`createAdminApiContract` 组合而成；`path` 只接受 `/api/...`。
- 错误响应（`apiErrorSchemas`）是 API 与 Web 共同的错误依据；Web 只按 `error.code` 分支，不解析文案。
- 面向用户的时间按北京时间格式化；日范围按自然日校验，最长一个月。
- 改契约要同时满足 API 的越权枚举测试与 Web 的契约解析测试，否则 `pnpm check` 失败。
