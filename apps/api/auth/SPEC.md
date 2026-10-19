---
id: api-auth
type: submodule-design
title: api/auth — 登录、会话与账号门禁
status: draft
parent: api
---

# api/auth — 登录、会话与账号门禁

## 职责

Better Auth 包装（`gateway`）与 API 自有的凭据实现：登录、登出、会话、强制改密、临时密码、管理员重置、账号停用，以及解锁与种子脚本。

## 边界

- 登录表在 `auth` schema，走 `AUTH_DATABASE_URL`（`fs_billing_auth` 角色）；业务表只走应用角色。
- 只被 `api` 使用；门户与后台共用同一套身份，进入哪个区域由登录响应的 `identity.kind` 决定。

## 不变量

- 失败计数在 `auth.login_failures`：同一窗口 15 分钟内失败 5 次锁定 15 分钟。窗口用 `window_id` 标识，基础设施失败只递减同一窗口，避免旧请求解除新窗口的锁。
- 临时密码自签发起 72 小时内有效（可配），过期登录被拒绝；首次登录与被重置后必须先改密，除改密与登出外的端点返回 `PASSWORD_CHANGE_REQUIRED`。
- 停用账号即注销其全部会话；重新启用不恢复旧会话；管理员不能停用或重置自己。
- 停用门户账号不影响该租户的呼叫。
