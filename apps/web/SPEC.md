---
id: web
type: module-design
title: web — 客户门户与管理后台界面
status: draft
parent: architecture
depends-on: [shared]
---

# web — 客户门户与管理后台界面

## 职责

React + Vite 单页应用，用同一份构建提供客户门户与管理后台：路由与会话门禁、API 客户端、格式化（金额、费率、北京时间、时长）、页面与组件。

## 边界

- 只依赖 `shared`；所有数据经 `/api` 获取，不访问数据库，不重复定义契约类型。
- 页面说明见 docs/pages.md，已确认的设计稿在 `design/`；基础组件按 shadcn/ui 方式写在仓库内（Tailwind v4 + Radix）。

## 不变量

- 进入受保护区域时请求 `/api/auth/session`；401 `reauthenticate` 跳区域登录页并记住返回路径，只有 `SESSION_EXPIRED` 才显示「登录已过期」提示。
- 区域由登录响应的 `identity.kind` 决定，与打开哪个登录页无关；已登录用户访问另一区域时跳回自己的首页。
- 返回路径必须是本站单斜杠开头、不是登录页、且属于登录身份的区域；只存在浏览器本地，不发给 API。
- 金额用 decimal.js 按 `ROUND_HALF_UP` 保留 2 位显示，费率固定 4 位，时间一律按北京时间。`apps/web/src` 受 `money/no-number-money` 规则约束。
- 账号停用或身份不可用时清除外壳，只显示提示与退出登录，不自动重新登录。

## 已知限制

- 构建产物是单个 JS 文件（约 600 kB），尚未按路由拆分。
