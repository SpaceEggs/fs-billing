# verify-fs-billing 证据摘要

完整证据（截图、ARIA 快照、HTTP/SQL 记录、Codex 评审日志）保存在仓库外：`/workspace/fsb-evidence/verify-fs-billing/`（box 上）。运行目录 `docs/evidence/verify-fs-billing/<RUN_ID>/` 已 gitignore，不再提交。

## 最终运行 20261014T091128Z-5c13b2

从空库 `launch → doctor → drive.mjs all → cleanup`，8/8 PASS；cleanup 后仅剩用户自己的 `fs-billing-postgres-1`，证据保留。

| 功能             | 结果   | 要点                                                                                                                                                                             |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| customer-login   | PASS   | 门户显示 `-¥35.20` 与 DB 一致；USD 显示 `-$15.02`；auth.session 行存在                                                                                                           |
| admin-login      | PASS   | 进入后台；客户在后台登录页按账号类型进门户                                                                                                                                       |
| login-errors     | PASS   | 未知邮箱/错误密码同为 401 INVALID_CREDENTIALS；5 次失败后 429 ACCOUNT_LOCKED（retry 900s，倒计时），计数行 failed_count=5；`auth:unlock` 删除计数行后可登录；停用账号 403 无会话 |
| session-expiry   | PASS   | 过期/撤销 → 登录 → 回到原 URL（含查询参数）；跨区路径回落首页                                                                                                                    |
| cross-tenant     | PASS   | A/B 仅见本租户；客户→后台 API 403 且无副作用；管理员→门户 403；匿名 401；test:idor 15/15                                                                                         |
| logout           | PASS   | 会话行删除；同一签名 cookie 退出前 200、退出后 401；移动端会话 3→2                                                                                                               |
| theme-and-mobile | PASS   | 深色持久化；跟随系统；375px 无横向溢出；账号面板、导航抽屉                                                                                                                       |
| not-found        | PASS   | 两区登录前后 404；API JSON 404                                                                                                                                                   |
| freeswitch-sipp  | 未运行 | 独立表面，见 features/freeswitch-sipp.md                                                                                                                                         |

## 说明

- 限流：首次运行 20261014T083714Z-b9fa00 中 not-found 因 API 凭据路由 30 次/分钟/IP 限流返回 429 RATE_LIMITED（技能连跑未等待）。API 未改，技能改为每个功能前等待限流窗口。
- 未验证：FreeSWITCH/SIPp（会使用用户 compose 的 Postgres，未在此运行）；停用管理员提示（种子无数据）；过期/撤销会话以 DB 修改模拟，回到标签页以 visibilitychange 模拟；cleanup 失败分支仅代码审查。
- Codex(codex2) 只读评审 3 轮（技能）+ 2 轮（lint 修复），最终 APPROVE/PASS；日志在 `/workspace/fsb-evidence/verify-fs-billing/codex-review-*.txt`。
