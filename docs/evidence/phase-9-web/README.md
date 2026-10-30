# 阶段 9 PR 8 验收记录：e2e、视觉对照、种子与 plan 勾选

2026-10-30，本机 PostgreSQL 17.9 与 Mailpit v1.31.5（各一个独立端口的 Docker 容器，用后删除）、Node 24.22.1。设计见 [phase-9-design.md](../../phase-9-design.md)，本 PR 对设计的补充见该文「PR 8 实现时对本文的补充与更正」。基线 `main` 的 `8db97d6`（PR #83 之后）。

## 测试结果

| 命令             | 结果                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`     | 退出 0：lint、格式检查、类型检查全过；根目录单元测试 55 个文件、1,074 通过 2 跳过（本机没有 `lua5.3`，Lua 测试跳过，CI 必跑）；Web 单元测试 51 个文件、662 通过；Web 构建成功 |
| `pnpm test:db`   | 退出 0，两次：74 个文件、986 个测试全部通过（第一次 6 分 2 秒；与阶段 8 的依赖种子的测试一并通过，`ledger.db.test.ts` 里种子流水条数随新增的 4 笔赊账更新为 26/27）           |
| `pnpm test:idor` | 退出 0：1 个文件、41 个测试全部通过                                                                                                                                           |
| `pnpm test:e2e`  | 退出 0：147 个通过、7 个跳过（视觉对照脚本只在 `FSB_VISUAL=1` 时运行）；库是刚迁移、刚播种的                                                                                  |

## 本 PR 新增的测试

- **种子与不排邮件：** `packages/db/src/seed-alerts.db.test.ts`（6 个用例，在单独的播过种子的库里跑）：5 条示例告警的形态与 `demo:` 键、「最近 24 小时 2 条、进行中 1 条」、全部 `notify = false` 并标记开始与恢复已通知、播种后与下一次 `notify-tick`（`queueAlertNotices`）之后发件箱为空且静默窗口与 `recipient:*` 窗口都不动示例行、**真实的 `raiseAlert(AlertKeys.authTimeout)` 另开 `notify = true` 的新行且下一次 tick 排出 `alert_start`（评审修复）**、待收款合计 ¥6,300 / $1,700 且重复播种不增行。`seed-legacy.db.test.ts`：旧库（预存金额不同）重新播种不新增赊账、余额不漂移。种子证明：开发库播种后 `email_outbox` 0 行、`balance_alert_deliveries` 0 行、`system_alerts` 5 行（1 条进行中）。
- **API 请求 URL 脱敏：** `apps/api/src/logging.test.ts`（真实 Fastify 加 `createApiLogger`，请求日志打开时断言 URL 里的 `callee`、`search` 号码被掩码、cookie 不出现）、`packages/db/src/log-safe.test.ts`（`redactUrlForLog` 的各种形态与 `maskNumber` 规则）。
- **e2e（`apps/web/e2e`）：**
  - `admin-overview.spec.ts`：`shows the same receivable totals and alert count as their pages`（验收 5 在浏览器里：概览待收款卡片 = 待收款页合计，概览「最近 24 小时 · N 条」点进告警页落在 `?window=24h`、时间选择停在 24 小时、「共 N 条」一致）、`each alert row on the overview opens the 24 hour list`、`lists suspended and low balance tenants in the attention area`、`the daily spend chart is driven by the keyboard and switches currency`（只用键盘，不悬停、不断言具体日期）。
  - `admin-system-alerts.spec.ts`：`shows merged invalid-input alerts`（验收 7）、`lists the seeded alerts, filters them and expands a recovered one`、`an empty filter result offers to clear the filters`、`the nav dot shows while an alert is open and disappears when none is`、`edits the receiving mailboxes with the chips input and saves them`（回车、逗号、分号添加，去重提示，移除、退格、格式错误被拦下、间隔分段与自定义共用一个值、刷新后仍在、经接口核对操作日志有 `alert_settings_update`）、`a stale settings form is rejected with a conflict and reloaded`（409）；原有三个用例保留。设置是全局单行，用例结束经接口还原。
  - `admin-settings.spec.ts`：`the empty recipients note says that disabled tenants are not mailed`（「停用租户不发送」；原有用例的文案断言也已更新为带这句）。
- **视觉对照：** `admin-alerts-visual.spec.ts`（只在 `FSB_VISUAL=1` 时运行），结果见 [visual-diff.md](visual-diff.md)。

e2e 没有时间炸弹：日期都不写死（告警时间相对播种时刻，只断言数量关系与文案），图表只用键盘操作，不悬停带日期的柱子。

## Plan 勾选

[plan.md 阶段 9](../../plan.md#阶段-9通知与告警) 的 10 项验收全部勾选，每项附测试名与 PR 号（#74 设计，#75 告警模型，#76 邮件管线，#77 故障告警邮件，#78 余额提醒，#79 QQ 邮箱实测，#80 契约与 API，#81 Worker 加固，#82 账单算式对齐，#83 页面，本 PR 为 #84）。设计的[验收标准对应计划测试](../../phase-9-design.md#验收标准对应计划测试)两张表逐个核对了计划名与实际名（阶段 8 的做法）：名字或所在文件不同的有 10 余处，对应关系写在表里；有一处计划里的用例没有：验收 8 的「下一个分钟再触发」（计划名 `fires again in the next minute`）没有单列，该用例只等一个分钟边界。plan 里已被阶段 8 缩小的一项（验收 7）的 JSON 解析失败一句已更正为阶段 9 决定 12 的规则，总表状态更新为「代码验收已完成」。

## CI 耗时

只调查，不改 CI。来自 `main` 上最近 4 次 CI 的 `gh run view --json jobs`（步骤起止时间）：

| 运行                     | `check` 总耗时 | `pnpm check` | `pnpm coverage` | `pnpm build` | 空库迁移与播种 | `test:db` | IDOR 证明 | `web-e2e` 总耗时 |
| ------------------------ | -------------- | ------------ | --------------- | ------------ | -------------- | --------- | --------- | ---------------- |
| #82（`80a5e92`）         | 12 分 34 秒    | 160 秒       | 17 秒           | 16 秒        | （未列出）     | 421 秒    | 77 秒     | 3 分 47 秒       |
| #80（`dd74488`）         | 15 分 52 秒    | 204 秒       | 22 秒           | 22 秒        | 21 秒          | 532 秒    | 103 秒    | 3 分 38 秒       |
| #81（`cc49029`）         | 14 分 11 秒    | 193 秒       | 21 秒           | 21 秒        | 21 秒          | 454 秒    | 98 秒     | 3 分 53 秒       |
| #83（`8db97d6`，进行中） | —              | 197 秒       | 21 秒           | 21 秒        | 21 秒          | 462 秒    | —         | 4 分 20 秒       |

`check` 任务 12.5 至 16 分钟，上限 25 分钟，余量约 9 分钟。时间分布：`test:db` 7 至 9 分钟（占 55% 至 58%，其中两个等真实分钟的文件约 4.5 分钟，见设计），`pnpm check`（lint、格式、类型、单元测试、Web 构建）3 至 3.5 分钟，IDOR 证明 1.3 至 1.7 分钟，其余（覆盖率、构建、迁移播种、安装、起 Docker）合计 1.5 至 2 分钟。`web-e2e` 并行，约 4 分钟，不是瓶颈。本机本 PR 的 `test:db` 为 5.7 分钟（984 个测试）。

**建议（不在本 PR 做）：** 把 `check` 拆成两个并行任务。

1. `check`：lint、格式、类型、单元测试、覆盖率、构建、两个类型/浮点拒绝实验，不需要 Docker。约 4 至 5 分钟。
2. `db`：`docker compose up`（PostgreSQL 与 Mailpit）、迁移与播种、`pnpm test:db`、IDOR 证明与上传。约 10 至 11 分钟。

墙钟从 12.5–16 分钟降到约 10–11 分钟，省 3 至 5 分钟，代价是多一份依赖安装与缓存恢复（约 30 至 60 秒的运行器时间，不增加墙钟）。要再省：用 `vitest --shard=1/2`、`2/2` 把 `test:db` 拆成两个任务（每个任务自己的 PostgreSQL，`global-setup` 每次重建 `fs_billing_test`，互不干扰；`vitest.db.config.ts` 是 `fileParallelism: false`，文件间不并行，分片后各任务内仍串行），把两个等真实分钟的文件（`cron.db.test.ts`、`multi-instance.db.test.ts`）放进分片较少的一边，墙钟可到约 6 至 7 分钟。要先确认各测试文件在「只跑一半文件」时不依赖别的文件留下的数据（目前按文件名顺序跑，没有这样的保证，需要分片后跑两三次验证）。如果只想要一个最小、肯定安全的改动：把 IDOR 证明步骤与 `test:db` 并行不行（共用数据库），所以拆任务是最直接的一刀。
