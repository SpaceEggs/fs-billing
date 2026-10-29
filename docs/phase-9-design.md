# 阶段 9 设计：通知与告警

## 范围与依据

本文档只是设计，没有实现代码，没有迁移，没有向 `liveApiContract` 注册任何端点，也不表示阶段 9 已验收。范围取自 [plan.md 阶段 9](plan.md#阶段-9通知与告警)（`docs/plan.md:328-350`），包含四项范围、十条验收标准（其中六条来自阶段 1、3 评审，一条是阶段 8 缩小后的版本）。

- 邮件发送任务（SMTP），失败重试并记入系统告警。
- 余额提醒：降到阈值以下发一封，回到阈值以上后才会再次触发；余额 + 透支用完发停机通知。
- 系统故障告警：开始时一封，持续期间每 N 分钟汇总一封，恢复后一封。
- 系统告警页面、概览页面。

业务规则依据 [design.md §8](design.md#8-通知与告警)（`docs/design.md:323-343`）、[§4.2](design.md#42-呼叫前授权)（授权超时放行 1800 秒并标记未经验证，`docs/design.md:150-170`）、[pages.md](pages.md) §3.2 概览、§3.11 系统告警（`docs/pages.md:203-211、326-333`）、[worker-api.md](worker-api.md)（告警写入点与对账，`docs/worker-api.md:92-123、171`），以及设计稿 `design/设计系统规范确认/管理后台 第三批 · 运营.dc.html`（概览第 29-145 行、手机概览第 146-200 行附近，系统告警第 496-600 行，数据脚本第 725-760、820-835 行）。账本与余额缓存取自 [phase-2-db.md](phase-2-db.md)，队列与定时任务取自 [phase-3-worker.md](phase-3-worker.md)、`apps/worker/src`，告警类型、对账告警取自 [phase-7-design.md](phase-7-design.md)、[phase-8-design.md](phase-8-design.md)，租户设置取自 [phase-5-design.md](phase-5-design.md)。结构、深度和写法沿用 [phase-8-design.md](phase-8-design.md)（提交 `4f25e22`）。

plan 阶段 9 验收里有一条（`plan.md:347`）已被阶段 8 缩小（[phase-8 决定 42](phase-8-design.md#已决定)）：同一份坏原文再次推送不再写第二条告警，修正稿入库后旧行标为 `superseded`。本阶段只做告警页面上的合并展示和恢复，见[告警模型](#告警模型)。

产品问题（阈值来源、收件人、N 的默认值、停机通知的边界等）已由用户于 2026-10-29 全部按推荐项确认，记在[已决定](#已决定)（决定 24–37）。技术选择（发件箱、触发器、告警键等）写在[已决定](#已决定)，附理由，用户可以推翻。

## 现状核对

### 仓库里已经有什么

| 事实                                                                                                                                                                                                                                                                                                                                                            | 出处                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system_alerts` 只有 `id / tenant_id / kind / description / started_at / recovered_at / affected_calls`。`kind` 允许 7 种：`auth_timeout`、`cdr_failed`、`email_failed`、`partition_failed`、`statement_mismatch`、`audit_failed`、`raw_archive_failed`。`email_failed` 从 0000 起就在，但没有任何代码写它。RLS `staff_only`，应用角色 `SELECT, INSERT, UPDATE` | `packages/db/migrations/0000_init.sql:620-629、691-694`、`0017_monthly_statements.sql:129-134`、`0018_cdr_operations.sql:205-209`、`packages/db/src/schema.ts:444-463`                                                     |
| 告警写入点共 10 处，写法各异：入库停放（每个 UUID 一条 `cdr_failed`）、校验失败（`ingest.ts` 里 `raw.id` 为键，同原文再推不重复）、JSON 损坏（只写告警）、未验证话单（每条一条 `auth_timeout`）、HTTP 503 保存失败（`recordAlert`）、分区维护失败、扣费对账持续失败、月账单核对、原始话单归档、重置密码审计失败                                                 | `apps/worker/src/ingest.ts:40-67、130-185`、`app.ts:136-156`、`maintenance.ts`、`reconcile.ts:55-58`、`archive.ts:40-90`、`packages/db/src/statements/reconcile.ts:165-230`、`apps/api/src/auth/admin-accounts.ts:105-125` |
| **没有结构化的告警标识。** 月账单核对和归档告警靠 `description LIKE '<前缀>%'` 找到「同一条」告警再更新或恢复；其余告警是一事件一行，从不恢复。`recovered_at` 只有这两处会写                                                                                                                                                                                    | `statements/reconcile.ts:165-215`、`archive.ts:50-90`                                                                                                                                                                      |
| 没有邮件代码、没有 SMTP 依赖（`grep nodemailer` 在所有 `package.json` 与锁文件里无结果）、没有 Mailpit。CI 靠 `docker compose up -d --wait` 起服务，所以往 `compose.yaml` 加服务 CI 自动拿到                                                                                                                                                                    | `compose.yaml`、`.github/workflows/ci.yml:68、110`                                                                                                                                                                         |
| 余额提醒的表已在 0000 建好但无人使用：`balance_alert_settings (tenant_id, threshold, emails[])`，创建租户时写入；`balance_alert_deliveries (tenant_id, kind ∈ {low_balance, suspended}, balance, recipients[], sent_at)`，只增，RLS 允许租户读自己的行（`0015` 改写了策略）。门户与后台只读 settings，没有任何代码写 deliveries                                 | `0000_init.sql:631-644`、`0015_rls_initplan.sql:51`、`packages/db/src/admin/tenants.ts:288、454`、`packages/db/src/tenant-health.ts`                                                                                       |
| 租户设置的邮箱规则已实现：小写、去重、最多 20 个、允许为空（设置页提示无法送达）；阈值不能为负、最多 2 位小数                                                                                                                                                                                                                                                   | `packages/shared/src/api/admin/tenants.ts:15-40`、`docs/design.md:325-332`                                                                                                                                                 |
| 余额是 `tenant_balances` 的缓存列，只由 `ledger_entries` 的 `AFTER INSERT` 触发器更新（`SECURITY DEFINER`）；`rebuild_tenant_balances` 也会更新它。流水触发器要求持租户锁，所以对同一租户的余额变动天然串行                                                                                                                                                     | `0000_init.sql:293-300、337-362、376-410`                                                                                                                                                                                  |
| 「已停机」的现有定义是 `balance + overdraft_limit <= 0`（手动停用优先），「透支」是 `balance < 0`，「余额不足」是 `balance < threshold`。授权拒绝「余额不足」的条件是 `floor((余额 + 透支) ÷ 该号码当前费率) <= 0`，也就是可用额度不足**该号码一分钟的费用**，所以比「已停机」宽                                                                                | `packages/db/src/tenant-health.ts:14-22`、`packages/rating/src/authorize.ts:31-59`                                                                                                                                         |
| Worker 的队列模式：`createBoss` 把 pg-boss 的每条 SQL 包进 `withSystem` 事务，`noAdvisoryLocks: true`，`supervise: true`、`schedule: true`；队列由部署时的 `queue:migrate`（`installQueue`）预建；定时任务 `boss.schedule(name, cron, null, { tz: 'Asia/Shanghai', missed: 'once' })`；每个实例启动时都会调用 `schedule`                                        | `apps/worker/src/queue.ts:17-120`、`main.ts`、`statements.ts:288-305`、`maintenance.ts`                                                                                                                                    |
| pg-boss 补丁只做两件事：增加 `noAdvisoryLocks` 配置，并在 `fromDrizzle` 适配器里去掉 `BEGIN;…COMMIT;`（调用方已在事务里）。关闭 advisory 锁的原因在 0000：迁移撤销了应用角色对 `pg_advisory_*` 的 `EXECUTE`，pg-boss 默认的 `pg_advisory_xact_lock` 会被拒绝                                                                                                    | `patches/pg-boss@12.37.1.patch`、`0000_init.sql:705-722`                                                                                                                                                                   |
| 授权超时的告警随话单到达，不是实时：Worker 收不到超时信号，首次有效的未验证话单入库时累加全局告警 `auth_timeout`（键 `fs-authorize`，`tenant_id` 为空；各租户的受影响数从 `cdrs` 的 `unverified` 取。PR 1 之前的代码是每通话一条、带该通话的租户）。话单在通话结束后才推送，单通最长 4 小时                                                                     | `docs/worker-api.md:106`、`apps/worker/src/ingest.ts:171-185`、`packages/rating/src/authorize.ts:10`                                                                                                                       |
| 计费号码不一致的错误日志包含原始拨号、被叫、Lua 投影和 Worker 计算的计费号码四个号码；API 的 pino 只脱敏 cookie、authorization、请求体，Worker 没有任何脱敏配置                                                                                                                                                                                                 | `apps/worker/src/app.ts:77-92`、`apps/api/src/logging.ts`、`apps/worker/src/main.ts`                                                                                                                                       |
| 后台概览现在是占位页，导航里没有「系统告警」（文件头注释写着随本阶段加入）；管理员邮箱不在 `admins` 表，在 `auth.user`，经 `auth.lookup_user_emails(user_ids)` 读取（仅管理员作用域可调用）                                                                                                                                                                     | `apps/web/src/pages/home.tsx:22-52`、`apps/web/src/components/app-shell.tsx:34-46`、`0013_admin_email_lookup.sql`                                                                                                          |
| 待收款合计已由 `/api/admin/receivables` 的 `totals`（CNY、USD 分开）提供；未归属条数由阶段 8 的 `adminUnassignedSummary.pending` 提供；租户状态由 `tenantHealth` 一份 SQL 给出，列表、详情、门户首页共用                                                                                                                                                        | `packages/shared/src/api/admin/receivables.ts:26-30、85`、`packages/db/src/tenant-health.ts`                                                                                                                               |
| 迁移已到 0019（阶段 8 用了 0018、0019）；本阶段从 0020 起，编号以合并时为准                                                                                                                                                                                                                                                                                     | `packages/db/migrations/`                                                                                                                                                                                                  |

### 种子数据核对

本步没有查询数据库，下面来自 `packages/db/src/seed.ts` 的源码（`TENANTS`，约 `:63-175`、`:640-656`）。

- 10 个租户（CNY 6、USD 4），与设计稿概览的「CNY 6 · USD 4」一致。已停机 2 个：HZX014（−100.36，透支 100）、GLB009（−15.02，透支 15）；余额不足（含透支中）4 个：ABC001（−35.20）、XYZ002（−4.82）、GZT007（86.50，阈值 100）、SGN011（12.30，阈值 20）；CDT018 已停用。分类与设计稿一致。
- 提醒阈值：CNY 100.00、USD 20.00；邮箱全部是 `billing-ops@example.com`。设计稿 SGN011 的文案是「低于提醒阈值 $15.00」，种子是 $20.00，差异记入[出入](#设计稿与文档的出入)。
- 种子里的待收款只有 ABC001 的 500.00 与 GZT007 的 1000.00（均 CNY），合计 ¥1,500.00 / $0.00；设计稿概览是 ¥6,300.00 / $1,700.00。视觉对照的数字对不上，只影响截图，不影响「概览与待收款页一致」的验收。是否补种子见 PR 8。
- 种子里**没有** `system_alerts`、没有 `email_outbox`。设计稿的 5 条告警（授权超时进行中、话单推送延迟、两条邮件发送失败等）要由 PR 8 补种子才能对照。
- 种子没有「余额降到阈值以下」的过程，验收 1、2 的场景用测试夹具造（新建租户 + 人工流水），不改种子。

### 设计稿与文档的出入

| #   | 出入                                                                                                                                                                    | 本设计的处理                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | pages.md §3.11 只列三种类型（授权超时、话单处理失败、邮件发送失败），数据库有 7 种                                                                                      | 页面为另外 4 种加标签：分区维护失败、账单核对异常、审计写入失败、原始话单归档失败；类型筛选列全部 7 种      |
| 2   | 设计稿有「话单推送延迟，队列积压 1,204 条，02:31 自动重试完成」。现有代码没有检测队列积压的地方，plan 范围也没写                                                        | 不实现，种子里改用「话单处理失败」的真实形态（[决定 36](#已决定)）                                          |
| 3   | 设计稿「邮件发送失败」示例是 GZT007 的提醒邮件被退信、地址不存在。SMTP 只能在发送时得到同步拒收；退信（DSN）是之后发回发件邮箱 pbx3cx@qq.com 的另一封邮件，本阶段不解析 | 只记录 SMTP 同步拒收（收件人 5xx）；文案按同步拒收写；退信解析列入风险                                      |
| 4   | 设计稿授权超时示例「计费授权接口响应超时（>2 秒）」。实际是 Lua 1.5 秒超时或返回 503 后放行（`worker-api.md:69`），告警随话单到达，不是实时                             | 描述按实际写；「开始时间」是第一条未验证话单入库的时间，页面和邮件注明「按话单到达时间记录」                |
| 5   | 设计稿概览「系统告警 · 最近 24 小时 · 2 条」包含进行中的一条（13:52 开始）和已恢复的一条（02:14）                                                                       | 口径见[两个页面的数字](#两个页面的数字)：进行中的告警不论开始多久都算，已恢复的按开始或恢复落在 24 小时内算 |
| 6   | 设计稿告警设置页只有「告警接收邮箱」和「汇总邮件间隔（默认 15 分钟）」；plan 验收 4 的示例是 N = 10                                                                     | 默认 15 分钟（[决定 31](#已决定)）；验收测试显式设 N = 10                                                   |
| 7   | 设计稿手机概览把告警放在「需要关注」卡片里，桌面是三栏列表；没有写 `email_failed` 是否进概览                                                                            | 概览与页面同一口径，`email_failed` 也算                                                                     |
| 8   | 设计稿没有租户邮件的版式，也没有任何收件人为空时的画面                                                                                                                  | 租户设置页已有「无法送达」提示，不新增页面；空收件人的处理见[决定 26](#已决定)                              |

## 告警模型

### 为什么要改

验收里有三条（对账告警恢复、无效输入告警合并展示与恢复、JSON 损坏的规则）加上「开始、汇总、恢复」三种邮件，都要求先回答一个问题：**「同一条告警」是什么**。现状没有答案：入库路径一事件一行、从不恢复，核对与归档靠描述前缀字符串匹配。邮件的开始、汇总、恢复要有稳定的告警身份才能做，所以先把告警收口，邮件建立在它上面。

### 新增列与约束（迁移 0020）

`system_alerts` 增加：

| 列                      | 类型与约束                                                                   | 用途                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `subject_key`           | `text`                                                                       | 告警身份，同一 `kind` 内同一时刻只有一条未恢复。旧行可空                                    |
| `last_seen_at`          | `timestamptz NOT NULL`                                                       | 最近一次事件的数据库时间。回填 `coalesce(recovered_at, started_at)`                         |
| `occurrences`           | `integer NOT NULL DEFAULT 1`                                                 | 事件次数，汇总邮件的「新增」靠它。`affected_calls` 保持原义（影响的通话数，页面显示）       |
| `notify`                | `boolean NOT NULL DEFAULT false`                                             | 开启时按 kind 策略定下是否发邮件（[决定 32](#已决定)）；以后改策略不会回头给旧告警发邮件    |
| `notified_start_at`     | `timestamptz`                                                                | 开始邮件入发件箱的时间；`notify` 为真且为空表示还没发                                       |
| `last_digest_at`        | `timestamptz`                                                                | 上一封汇总邮件入发件箱的时间                                                                |
| `digest_cursor`         | `integer NOT NULL DEFAULT 0`                                                 | 上一封开始或汇总邮件时的 `occurrences`，下一封汇总的「新增」= `occurrences − digest_cursor` |
| `notified_recovered_at` | `timestamptz`                                                                | 恢复邮件入发件箱的时间                                                                      |
| 局部唯一索引            | `(kind, subject_key) WHERE recovered_at IS NULL AND subject_key IS NOT NULL` | 保证一个身份同时只有一条进行中，并发写入走 `ON CONFLICT`                                    |
| 索引                    | `(started_at DESC)`、`(recovered_at) WHERE recovered_at IS NULL`             | 页面列表与「进行中」红点                                                                    |

**迁移不能给历史告警发邮件。** 回填时现有行全部 `notify = false`、`notified_start_at = started_at`、`notified_recovered_at = recovered_at`。未恢复的 `statement_mismatch`、`raw_archive_failed` 按已有的描述前缀格式回填 `subject_key`（`statement:<租户 id>:<YYYY-MM>`、`archive:<YYYY-MM>`），之后沿用新逻辑恢复；其余未恢复的旧行 `subject_key` 保持空，不参与合并和自动恢复，随时间落出页面的 30 天窗口（风险一节记录）。已恢复的旧行不回填。

### 统一的写入与恢复函数

新增 `packages/db/src/alerts.ts`：

- `raiseAlert(tx, { kind, subjectKey, tenantId?, description, calls?, at? })`：`INSERT … ON CONFLICT (kind, subject_key) WHERE recovered_at IS NULL DO UPDATE SET occurrences = occurrences + 1, affected_calls = affected_calls + $calls, last_seen_at = $at, description = $description`。`at` 默认数据库 `now()`，测试传入以推进时钟。新行的 `notify` 由 `kind` 与子类型决定（见下表）。
- `recoverAlert(tx, { kind, subjectKey })` 与 `recoverAlertsWhere(tx, 条件)`：置 `recovered_at = now()`，已恢复的不动。

全部 10 个写入点改用这两个函数，不再有 `LIKE '<前缀>%'` 找告警的写法。每个写入点的键与恢复规则：

| 写入点                                                                           | kind                 | `subject_key`                                                                              | 合并方式                                                                                              | 恢复条件                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未验证话单入库                                                                   | `auth_timeout`       | `fs-authorize`（全局一条，`tenant_id` 空）                                                 | 事件累加：`affected_calls`、`occurrences`；各租户的受影响数从 `cdrs` 的 `unverified` 取               | 静默窗口：`ALERT_QUIET_MINUTES`（默认 10）内没有新事件（[决定 35](#已决定)）                                                                                                                                                              |
| 停放到未归属（租户不存在、缺标签、无费率、号码不一致、号码格式错误、月份已删除） | `cdr_failed`         | `unassigned:<原因>`，原因是「租户不存在」时再加标签：`unassigned:租户不存在:ABC01`         | 同原因同标签合并；`affected_calls` 为条数                                                             | 同键的 `pending` 未归属行清零（分配、忽略都算）：在改动待处理行的同一事务里恢复，tick 全量扫描兜底                                                                                                                                        |
| 话单校验失败（有 JSON、结构不对）                                                | `cdr_failed`         | `invalid-cdr:<结构化原因>`，即阶段 8 的 `话单校验失败: 路径(错误码), …` 全文（≤ 200 字符） | **合并展示**：同一种校验失败无论多少份不同原文、多少次重推，只有一条；`affected_calls` = 不同原文份数 | 同原因的 `pending` 行清零（`superseded`、忽略、分配都算），在改动待处理行的同一事务里恢复，tick 全量扫描兜底；这就是「原文修正后相应告警标记为已恢复」                                                                                    |
| JSON 语法损坏                                                                    | `cdr_failed`         | `invalid-json`（全局一条）                                                                 | 每次推送 `occurrences + 1`，`affected_calls` 同；描述只写最近一次的原文 id                            | 静默窗口（同上）。理由：没有 UUID、没有待处理行，没有可对上的修正；原文在 `raw_cdrs` 里，按原文 id 排查                                                                                                                                   |
| HTTP 503 保存话单失败                                                            | `cdr_failed`         | `cdr-save`                                                                                 | 累加                                                                                                  | 静默窗口                                                                                                                                                                                                                                  |
| 分区缺失（入库路径 23514）                                                       | `partition_failed`   | `partition-missing`                                                                        | 累加                                                                                                  | 静默窗口。**不随分区维护成功恢复**（PR 1 实现时更正）：`ensureCdrPartitions` 只建当月和下一个月，缺的若是被归档分离的旧月或更远的将来月，维护照常成功而入库继续 23514，维护恢复会让告警与下一条话单来回开关，PR 4 起变成开/恢复邮件的往返 |
| 分区维护失败                                                                     | `partition_failed`   | `partition-maintenance`                                                                    | 累加                                                                                                  | 下一次分区维护成功（`maintainPartitions` 末尾调用 `recoverAlert`，只恢复这一条）                                                                                                                                                          |
| 扣费对账持续失败                                                                 | `cdr_failed`         | `charge-reconcile:<通话 UUID>`                                                             | 一通话一条（保持现有「一通话只告警一次」）                                                            | 该租户出现 `call:<UUID>` 流水：`chargeCall` 在写完流水的同一事务里 `recoverAlert`；tick 另扫一遍兜底（流水由人工补记的情况）                                                                                                              |
| 月账单核对                                                                       | `statement_mismatch` | `statement:<租户 id>:<YYYY-MM>`                                                            | 沿用阶段 7 的开、更新、恢复，改用键代替描述前缀                                                       | 沿用阶段 7（核对通过）                                                                                                                                                                                                                    |
| 原始话单归档                                                                     | `raw_archive_failed` | `archive:<YYYY-MM>`                                                                        | 沿用阶段 8，改用键                                                                                    | 沿用阶段 8（该月成功或已丢弃）                                                                                                                                                                                                            |
| 重置密码审计失败                                                                 | `audit_failed`       | `audit:reset-password`                                                                     | 累加                                                                                                  | 静默窗口；描述仍只有动作与对象 id，不含密码和邮箱；租户为空（全局键）                                                                                                                                                                     |
| 邮件发送失败                                                                     | `email_failed`       | `smtp`（传输层）、`recipient:<租户 id>`（收件人被拒）                                      | 累加                                                                                                  | `smtp`：下一封邮件发送成功；`recipient:*`：静默窗口 7 天无新拒收，或租户邮箱列表被修改                                                                                                                                                    |

**PR 1 实现时对本节的补充与更正：**

- `raiseAlert` 多一个可选参数 `callsMode: 'add' | 'set'`（默认 `add`）：账单核对告警的 `affected_calls` 是「当前状态」（迟到流水笔数），覆盖而不累加。`recoverAlert` 多一个可选的 `at`（与 `raiseAlert` 的 `at` 一样用于推进测试时钟，`recovered_at` 取 `greatest(started_at, at)` 以满足 `recovered_at >= started_at`）。`ON CONFLICT` 的推断谓词必须写全 `recovered_at IS NULL AND subject_key IS NOT NULL` 才能匹配局部唯一索引。
- **恢复在事务内完成，tick 扫描作后备。** 设计原写「未归属、校验失败键由 tick 检查」。PR 1 没有 tick，且事务内恢复更及时：修正稿 `superseded`（入库）、`ignoreUnassigned`、`assignUnassigned` 在改动待处理行的同一事务里调用 `recoverClearedUnassignedAlerts(tx, rows)`；PR 4 的 tick 仍调用不带参数的全量版本兜底，并调用 `recoverQuietAlerts`（静默窗口）和 `recoverPaidChargeReconcileAlerts`（人工补记流水的对账告警）。`chargeCall` 只在该通话 `reconcile_alerted = true` 时才恢复，免得扣费热路径每笔多一次 `UPDATE`。
- **`partition-missing` 走静默窗口**，不随分区维护成功恢复，理由见上表。分区维护成功只恢复 `partition-maintenance`。
- **全局键的 `tenant_id` 为空。** 只有按租户分的键（`charge-reconcile:*`、`statement:*`，以及 PR 2 的 `recipient:*`）带租户；`fs-authorize`、`invalid-json`、`cdr-save`、`partition-*`、`audit:reset-password`、`unassigned:*`、`invalid-cdr:*`、`archive:*` 都不带，因为合并多个租户的事件之后保留第一次的租户没有意义。重置密码审计失败的对象 id 写在描述里。
- **未归属 / 校验失败这一族告警的事务级互斥。** 入库停放与修正稿、`ignoreUnassigned`、`assignUnassigned`、恢复扫描会同时锁待处理行和多条告警行，告警 id 是随机 UUID，`ORDER BY id` 不能让各路径的加锁顺序一致，会成环（一次忽略同时选中两个原因的行、另一个事务修正一条校验失败行又停放一条，已用测试复现）。所以它们先拿同一把锁：迁移 0020 的 `lock_alert_family()`（`SECURITY DEFINER`，因为应用角色没有 `pg_advisory_*` 的 `EXECUTE`；键 `hashtextextended('alerts:unassigned', 0)`，写法同租户锁和分区锁），封装为 `lockUnassignedAlerts(tx)`。顺序约定：先 `lockTenants`（它要求事务里还没有别的锁），再拿这把锁，再碰待处理行 / 告警行。**正常入库（入队扣费）不拿**：只有停放、校验失败、以及确实存在要修正的待处理行时的修正稿才拿。未验证话单的 `auth_timeout` 告警移到入库事务的最后写，使所有路径的告警锁顺序都是「未归属族 → fs-authorize」。代价：停放、校验失败、忽略、分配在这一把锁上串行，这些都是错误路径或人工操作，量小。
- **历史告警与 `notify`。** 回填后未恢复的旧告警是 `notify = false`、`notified_start_at` 有值、`notified_recovered_at` 为空。PR 4 的 `notify-tick` 的开始、汇总、恢复通知三条查询**都必须带 `notify = true`**，否则这些旧告警在升级后第一次恢复时会发出一封恢复邮件。

**对账（补投）告警的恢复**（验收 6）就是表里 `charge-reconcile` 一行：现在 `reconcile.ts` 在补投达到 `WORKER_RECONCILE_ALERT_ATTEMPTS` 次后写告警并置 `reconcile_alerted`，之后补投成功也没有人把告警标恢复。改后 `chargeCall` 写完 `call:<UUID>` 流水时，同一事务内恢复对应告警。

**无效输入告警的合并展示**（验收 7）：键取阶段 8 的结构化原因，所以「每次推送一份不同原文、同样缺 `billsec`」这种 FreeSWITCH 配置错误只产生一条告警，不是几千条。代价：键的粒度是「原因」，一条告警里混着不同通话；排查靠告警详情里的链接跳到未归属话单页并按原因筛选（PR 6 给未归属列表加 `reason` 筛选）。

**JSON 损坏的规则**（验收 7 末句）：见表。不增加 pending 行（沿用 worker-api 约定）；告警只计数。

**邮件策略（`notify`）。** 开启时按 `kind` 与子类型：`email_failed` 恒为假（发邮件的通道坏了，再用它发邮件没有意义，也避免循环）；其余的按[决定 32](#已决定)为真。

### 事件时间的取法

告警的「开始」「最近事件」用数据库时间（处理这条事件的时刻），不用话单里的 `started_at`。原因：`auth_timeout` 随话单到达，话单可能晚到最长 4 小时（单通上限）甚至几天（Worker 停机后 FreeSWITCH 补推），按话单时间会让告警「开始」落到过去、已恢复的告警被迟到的话单重新打开。详情里另给「涉及话单的时间范围」（从 `cdrs` 取最早和最晚的 `started_at`），页面写「按话单到达时间记录」。

> **本设计管不了的情形：** Worker 或数据库整体不可用时，没有进程能写告警，更发不了邮件。授权超时放行的故障会在服务恢复、FreeSWITCH 补推话单后才被记录，邮件是「事后」的。实时发现 Worker 宕机需要外部监测，属于阶段 10（NTP 与存活监测）。

## 邮件发送管线

### 方案：发件箱表，不直接发送

三种做法的比较：

| 做法                                                    | 问题                                                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 在业务代码里直接 `sendMail`                             | 余额变动由数据库触发器和 API、Worker 多条路径引发，`ledger` 提交与 SMTP 不能原子：提交后进程崩溃会丢通知，先发后提交会发出没有发生的通知；SMTP 变慢会占住业务连接（持租户锁） |
| 只用 pg-boss 作为发件队列（`boss.send` 带事务）         | 余额的判定在数据库触发器里（见下节），触发器不能调 `boss.send`；任务载荷里放收件人和正文不利于排查，重试策略与去重键也都得自己在队列选项上拼                                  |
| **发件箱表 `email_outbox` + Worker 定时分发（本设计）** | 判定与「要发这封邮件」在**同一事务**提交，之后的发送是可重试、可观察的单独步骤；任何进程（API、Worker、触发器）都能写发件箱；去重、状态、失败原因在表里，页面和测试可直接查   |

结论（决定 1）：发件箱。分发由 Worker 的 `notify-tick` 任务完成，见[定时任务](#定时任务真实-cron-与多实例)；API 进程不发邮件、不持有 SMTP 凭据。

### 配置

沿用 Worker 现有的 `WORKER_*`、`RAW_CDR_ARCHIVE_*` 命名和 zod 校验风格（`apps/worker/src/config.ts`），键只由 Worker 读取：

| 键                       | 默认    | 说明                                                                                                                                                   |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SMTP_HOST`              | 无      | 不设置则邮件发送未启用：Worker 启动时记 `warn`（同 `RAW_CDR_ARCHIVE_DIR` 的写法），发件箱照常入队，页面提示「邮件发送未配置」                          |
| `SMTP_PORT`              | `465`   | 整数 1–65535                                                                                                                                           |
| `SMTP_SECURE`            | `true`  | `true` = 隐式 TLS（465）。`false` 时必须 STARTTLS（`requireTLS`）；仅当 `SMTP_HOST` 是回环地址（Mailpit）才允许不加密，写法同 `WORKER_HOST` 的内网校验 |
| `SMTP_USER`、`SMTP_PASS` | 无      | 两者同有或同无；无则不认证（只有回环主机允许）。`SMTP_PASS` 在 QQ 邮箱是授权码                                                                         |
| `MAIL_FROM`              | 无      | 设置了 `SMTP_HOST` 就必填；只放地址，显示名固定为「FS-Billing 计费系统」。`SMTP_HOST` 以 `qq.com` 结尾时要求与 `SMTP_USER` 相同，否则启动失败          |
| `SMTP_TIMEOUT_MS`        | `15000` | 连接、问候、套接字三个超时共用                                                                                                                         |
| `MAIL_RATE_PER_MINUTE`   | `20`    | 每次 tick 最多发送的封数上限（见下）                                                                                                                   |
| `MAIL_MAX_ATTEMPTS`      | `6`     | 单封邮件的最大尝试次数                                                                                                                                 |
| `ALERT_QUIET_MINUTES`    | `10`    | 事件型告警的静默恢复窗口（[决定 35](#已决定)）                                                                                                         |
| `APP_PUBLIC_URL`         | 无      | 邮件里链接的站点根地址（`https://…`；本地可为 `http://127.0.0.1:5173`）；没有则邮件不含链接                                                            |

秘密只放运行环境：开发在 `.env`（已在 `.gitignore`），测试与生产服务器在 `/etc/fs-billing.env`（systemd `EnvironmentFile`，建议权限 600、属主为服务用户，部署步骤随阶段 10 运维手册）。`.env.example` 只放 Mailpit 的本地值（`SMTP_HOST=127.0.0.1`、`SMTP_PORT=1025`、`SMTP_SECURE=false`、`MAIL_FROM=billing@example.test`），**仓库中不出现任何真实密码或授权码**，本文也不含。`SMTP_PASS` 不进日志：配置错误信息不回显取值，nodemailer 的 `debug` 与 `logger` 选项保持关闭（它们会打印认证过程），pino 对 `config` 对象不做整体输出。

**QQ 邮箱账号（`smtp.qq.com`，465，隐式 TLS，发件账号 pbx3cx@qq.com）要在 PR 2 用真实发送逐项核实，下面是设计时需要考虑的点，不当作已知事实：**

1. 密码字段填的是 QQ 邮箱设置里开启 SMTP 服务后生成的**授权码**，不是账号登录密码；授权码可以被重新生成或失效，轮换步骤要写进运维手册。
2. 发件人地址必须等于认证账号。配置校验按上表强制，避免上线才发现被拒或被改写。
3. 发送频率和每日总量有上限（具体数值未知，要测）。设计上：`notify-tick` 每次最多发 `MAIL_RATE_PER_MINUTE` 封、串行、单连接；汇总邮件把多条告警并成一封；触发限流的响应（4xx 或特定 5xx）按「可重试」处理并退避。若每日上限小于预期的邮件量，需要回到[决定 32](#已决定)收窄范围。
4. 单封邮件的收件人数上限、自动化邮件内容被判定为垃圾邮件而 5xx 拒收（QQ 对群发内容较敏感）的情况要用真实收件箱（QQ 邮箱和一个外部邮箱各一个）实测，包括垃圾箱。
5. 空闲连接会被服务器断开：每个 tick 内按需建连、发完关闭，不做长连接池。
6. 证书校验保持默认开启，不写 `rejectUnauthorized: false`。
7. 退信（DSN）回到发件邮箱，不在本阶段解析（[出入 3](#设计稿与文档的出入)）。

### 表 `email_outbox`

| 列                      | 类型与约束                                                                                                                         | 用途                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`                    | `uuid PRIMARY KEY DEFAULT gen_random_uuid()`                                                                                       | 也用作邮件头 `Message-ID` 的一部分，重发同一封时不变                                                             |
| `dedupe_key`            | `text NOT NULL UNIQUE`                                                                                                             | 幂等键，见下                                                                                                     |
| `template`              | `text NOT NULL CHECK (template IN ('balance_low', 'balance_suspended', 'alert_start', 'alert_digest', 'alert_recovered', 'test'))` | 模板名                                                                                                           |
| `params`                | `jsonb NOT NULL`                                                                                                                   | 渲染所需的快照（租户编码和名称、币种、余额、阈值、告警清单与计数等）。**不存渲染后的正文**，发送时由模板函数渲染 |
| `recipients`            | `text[] NOT NULL`                                                                                                                  | 入队时的收件人快照；之后改设置不影响已入队的邮件                                                                 |
| `tenant_id`             | `uuid REFERENCES tenants`                                                                                                          | 租户通知有值                                                                                                     |
| `status`                | `text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped'))`                                              | `skipped`：入队时没有收件人，或停用租户被静默（[决定 26](#已决定)、[决定 27](#已决定)）                          |
| `skip_reason`           | `text`                                                                                                                             | `no_recipients` 等                                                                                               |
| `attempts`              | `integer NOT NULL DEFAULT 0`                                                                                                       |                                                                                                                  |
| `next_attempt_at`       | `timestamptz NOT NULL DEFAULT now()`                                                                                               | 退避                                                                                                             |
| `locked_until`          | `timestamptz`                                                                                                                      | 认领租约，进程崩溃后到期自动释放                                                                                 |
| `last_error`            | `text`                                                                                                                             | SMTP 响应码与首行，截断到 300 字符；不含收件人地址和正文                                                         |
| `accepted`、`rejected`  | `text[]`                                                                                                                           | SMTP 返回的收件人分类                                                                                            |
| `created_at`、`sent_at` | `timestamptz`                                                                                                                      |                                                                                                                  |

索引：`(status, next_attempt_at) WHERE status IN ('pending','sending')`。RLS `staff_only`；应用角色 `SELECT, INSERT, UPDATE`，无 `DELETE`；发送成功满 180 天的行由维护用的 `SECURITY DEFINER` 函数 `email_outbox_purge()` 清理（决定 6，避免收件人地址长期堆积）。`balance_alert_deliveries` 加列 `outbox_id uuid UNIQUE REFERENCES email_outbox`，由分发器在标记 `sent` 的同一事务里插入一行，记录实际发出的余额类通知（`sent_at` 保持「真实发送时间」的含义，`recipients` 为 SMTP 实际接收的地址）。

**幂等键。** 余额类：`balance_low:<租户>:<序号>`、`balance_suspended:<租户>:<序号>`，序号取自下节的状态行，每次「触发」加一；告警类：`alert_start:<tick 内最小告警 id>`、`alert_digest:<告警 id>:<digest 序号>`、`alert_recovered:<告警 id>`。入队一律 `INSERT … ON CONFLICT (dedupe_key) DO NOTHING`，重跑同一事务、重复 tick 都不会产生第二封。

### 分发、重试、退避

`notify-tick` 的发送步骤：

1. 认领：`UPDATE email_outbox SET status = 'sending', locked_until = now() + interval '2 minutes', attempts = attempts + 1 WHERE id IN (SELECT id FROM email_outbox WHERE (status = 'pending' AND next_attempt_at <= now()) OR (status = 'sending' AND locked_until < now()) ORDER BY next_attempt_at LIMIT $rate FOR UPDATE SKIP LOCKED) RETURNING …`。多实例各认领不同的行（[多实例](#定时任务真实-cron-与多实例)）。
2. 逐封串行发送。成功：`status = 'sent'`、`sent_at`、`accepted/rejected`，余额类同事务插 `balance_alert_deliveries`；并 `recoverAlert('email_failed', 'smtp')`。
3. 失败分三类，**不在失败时丢弃邮件**：
   - **可重试**：连接错误、超时、4xx、限流。`status = 'pending'`，`next_attempt_at = now() + 退避[attempts]`，退避 1 分钟、5 分钟、15 分钟、1 小时、3 小时（累计约 4 小时 20 分钟，`MAIL_MAX_ATTEMPTS = 6`）。
   - **配置类**：认证失败（535 等）。同样按退避重试，因为管理员可能正在改环境变量；同时 `raiseAlert('email_failed', 'smtp', …)`，描述写「SMTP 认证失败，请检查 SMTP_USER / SMTP_PASS」，不写任何凭据。
   - **永久**：全部收件人被 5xx 拒绝，或超过最大尝试次数。`status = 'failed'`，`raiseAlert('email_failed', 'smtp' 或 'recipient:<租户>', …)`。部分收件人被拒、其余接受：整封算 `sent`，被拒地址写 `rejected`，并为该租户开 `recipient:<租户>` 告警。
4. `failed` 的邮件不自动再试；运维 CLI `pnpm --filter @fs-billing/worker mail:requeue -- --id <uuid>`（或 `--since <时间>`）把它们重新置为 `pending`（用于 QQ 每日额度恢复后补发）。

**至少一次，不是恰好一次。** SMTP 接受邮件后、`sent` 提交前进程崩溃，租约到期后会重发一封。`Message-ID` 取 `<outbox id>@fs-billing`，在重发时不变，让邮件客户端有机会折叠；不能完全避免。这个概率极低，换来的是「宁可多发一封，不丢通知」，符合通知的目的（决定 3）。

**发送失败的告警不再发邮件**：`email_failed` 的 `notify` 恒为假，它只出现在页面和概览（红点、计数）。

### 收件人与空收件人

| 邮件                 | 收件人                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| 余额提醒、停机通知   | 租户设置里的通知邮箱（`balance_alert_settings.emails`，已小写、去重、≤ 20）；不抄送管理员（[决定 25](#已决定)） |
| 告警开始、汇总、恢复 | 告警设置里的接收邮箱；为空时的处理见[决定 33](#已决定)                                                          |

入队时取快照写入 `recipients`。**收件人为空时：** 状态机仍然前进（见下节，不能因为没有人收就反复重新触发），入队一行 `status = 'skipped'`、`skip_reason = 'no_recipients'`，不发邮件，不重试，不开 `email_failed` 告警（这是配置状态不是故障）。后台租户设置页已有「无法送达」提示；不设其他兜底（[决定 26](#已决定)）。一封租户邮件的多个收件人放在同一封邮件里（`To`），由一次 SMTP 事务发出，收件人互相看得到地址：它们是同一租户自己填写的通知邮箱，与告警邮件的管理员邮箱不混合。

### 模板

中文，纯文本加简单 HTML 两个部分（`multipart/alternative`），UTF-8，主题 RFC 2047 编码由 nodemailer 处理。时间一律显示北京时间（`2026-10-29 14:03`，后缀「北京时间」）。模板是纯函数 `render(template, params) → { subject, text, html }`，放在 `packages/shared/src/mail/`，Worker 和测试共用，不依赖数据库。

| 模板                | 主题                                     | 内容要点                                                                                                      |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `balance_low`       | `【余额不足】{租户名} 余额 {币种}{余额}` | 租户编码与名称、当前余额、提醒阈值、透支额度、可用额度；说明「充值后恢复；可用额度用完后将无法呼出」          |
| `balance_suspended` | `【已停机】{租户名} 可用额度已用完`      | 余额、透支额度；说明新呼叫将被拒绝（SIP 拒绝，原因「余额不足」），进行中的通话不受影响，充值后自动恢复        |
| `alert_start`       | `【故障告警】{n} 项告警开始：{类型…}`    | 本次 tick 新开的告警清单：类型、说明、开始时间、站点链接                                                      |
| `alert_digest`      | `【故障汇总】{K} 项告警仍在进行`         | 每条：类型、持续时长、距上次汇总新增 {x}、累计 {y}；受影响最多的 5 个租户（编码）；链接（[决定 34](#已决定)） |
| `alert_recovered`   | `【故障恢复】{类型} 已恢复，持续 {时长}` | 开始与恢复时间、累计次数、影响的通话数                                                                        |
| `test`              | `【测试邮件】FS-Billing`                 | 仅 `mail:test` 命令使用，用来验证 SMTP 配置                                                                   |

**内容边界：** 邮件正文不含主叫、被叫、计费号码、原始话单、门户账号邮箱；告警只写 UUID 数量与类型，通话 UUID 不列入汇总（需要时去页面查）。租户名称与编码来自管理员输入，HTML 部分一律转义，主题里去掉换行（防头部注入），都有单元测试。租户邮件只含该租户自己的数据（IDOR 用例见[越权](#越权用例idor)）。具体措辞在 PR 3、4 以渲染后的样张（Mailpit 截图）提交评审。

### 本地与 CI 测试

- `compose.yaml` 增加 `mailpit` 服务（镜像和固定版本在 PR 2 选定并核对；SMTP 绑定 `127.0.0.1:1025`，网页与 HTTP API 绑定 `127.0.0.1:8025`），健康检查沿用 `--wait`。CI 的两个作业都是 `docker compose up -d --wait`，自动带上它；`.env.example` 与 CI 环境变量加 `SMTP_*` 的 Mailpit 值。
- 验收测试用 Mailpit 的 HTTP API（`/api/v1/messages`，PR 2 核对接口）清空、读取、断言收到的封数、主题、收件人与正文，不 mock SMTP：这正是验收 1、2、4 要求的「用本地邮件测试工具接收」。
- 单元层另测：退避序列、失败分类（用一个会返回指定 SMTP 响应的假服务）、模板转义、配置校验（含 QQ 发件人等于认证账号）。
- 真实 QQ 账号的发送不进 CI；PR 2 做一次手工核实（`mail:test --to <地址>`），结果与上面 7 点的实测结论写入 `docs/evidence/phase-9/`，不含授权码。

**PR 2 实现时对本章的补充与更正：**

- **`notify-tick` 的壳先在 PR 2 建好。** 队列 `notify-tick`（`exclusive`，不重试，每分钟，`Asia/Shanghai`）由 `queue:migrate` 预建；PR 2 的处理函数 `runNotifyTick` 依次做：事件型告警静默恢复（`recoverQuietAlerts`，窗口取 `ALERT_QUIET_MINUTES`）→ `recipient:*` 告警 7 天窗口恢复 → 分发发件箱。PR 4 在分发之前加上告警的开始、汇总、恢复通知，不再新增定时任务。`SMTP_HOST` 未设置时前两步照常运行，只是不分发。发件箱满 180 天的清理（`email_outbox_purge()`）由这个任务每天（北京时间）调用一次。
- **配置校验比上表多几条。** 端口与 TLS 要一致（465 必须 `SMTP_SECURE=true`；25、587、2525 不能配隐式 TLS）；只设置了 `SMTP_USER` 或 `SMTP_PASS` 而没有 `SMTP_HOST` 直接报错（多半是主机名拼错，不要悄悄关掉邮件）；非回环主机必须认证；`APP_PUBLIC_URL` 必须是 `https://` 站点根（本机回环可用 `http://`），不含路径、账号、查询串。校验信息是固定文字，不回显取值。`SMTP_SECURE=false` 时传输层对非回环主机强制 `requireTLS`，所以不存在「非回环明文」的配置。
- **失败分类。** 认证失败（`EAUTH`、530/534/535/538）退避重试并每次累加 `smtp` 告警；连接、超时、DNS、TLS 握手、4xx、421 可重试；RCPT TO 阶段全部 5xx、地址格式错误、MAIL FROM 被拒、DATA 命令或 DATA 之后的 5xx、nodemailer 本地拒绝的超大/空邮件（`EMESSAGE` 无响应码）是永久失败，而 DATA 命令被 4xx 拒绝（nodemailer 抛 `EENVELOPE`、`command: 'DATA'`）按响应码先判为可重试。5xx 但响应文字是明确的限流措辞（`frequen`、`too many`、`rate limit`、`throttl`、`try again later`、`频繁`、`频率`、`发送过快`、`请稍后再试`）按可重试处理；**不**含 `exceed`、`超过`、`限制`，它们会误伤 552「size exceeds」「mailbox full」这类永久失败。QQ 的限流用哪些码和文字未知，由手工核实补充（[运行手册](evidence/phase-9/qq-smtp-check.md)）。没见过的错误一律重试，不丢通知。`last_error` 里的邮箱地址一律抹成 `<地址>`，EENVELOPE 错误上的被拒收件人写进 `rejected` 列。
- **`email_failed` 告警的归属。** 租户邮件的收件人被拒记到 `recipient:<租户 id>`（带租户）；**管理员告警邮件（没有租户）的收件人被拒记到 `recipient:admin`**（`tenant_id` 为空，`notify = false`，整封被拒或部分被拒都开）；认证失败、整封被拒、渲染失败、连接用尽记到 `smtp`。管理员邮件不能挂在 `smtp` 上：下一封成功的邮件会把 `smtp` 告警恢复，下一次拒收又重开，来回开关。部分收件人被拒、其余接受时整封算 `sent`，被拒地址写 `rejected`。`recipient:*` 恢复：最近一次拒收满 7 天（分发任务内，含 `recipient:admin`），或租户邮箱列表被修改（`recoverRecipientAlert`，**PR 3 保存租户设置时必须调用**）。`recoverSmtpAlert` 只恢复 `smtp`，不碰 `recipient:*`。保存管理员告警设置（`alert_settings`）时 `saveAlertSettings` 在接收邮箱列表变化时调用 `recoverAdminRecipientAlert`（PR 4 完成）。
- **清理函数不删被 `balance_alert_deliveries` 引用的行。** `balance_alert_deliveries` 只增不改（触发器拒绝 `UPDATE`、`DELETE`），外键 `outbox_id` 不能悬空，也不能 `ON DELETE SET NULL`。这些行的收件人本来就永久保存在 `balance_alert_deliveries.recipients`，不清理它们不增加长期保留的地址。
- **`mail:test` 不经过发件箱。** 它用 `SMTP_*` 直接发一封 `test` 模板邮件并打印响应码与分类，不写数据库、不碰告警，因为它的用途是核实 SMTP 配置本身（数据库不可用时也能用）。`test` 模板仍在发件箱的模板白名单里。
- **租约、运行时间与停止。** 一封邮件最坏的发送时间由连接、问候、套接字三个超时决定，记作预算 3 × `SMTP_TIMEOUT_MS`。租约取 `max(2 分钟, 预算 + 60 秒)`（默认 2 分钟，超时设到上限 120 秒时 7 分钟，小于 `notify-tick` 任务的 10 分钟过期）；每封发送前检查「现在 + 预算 < 租约到期」，不满足就停止发送，把没发的释放回 `pending`（次数退回，没有真的尝试）。所以发送一旦开始就在租约到期前结束，整个 tick 的运行时间受租约约束，`MAIL_RATE_PER_MINUTE` 最大 1000 也不需要在配置里另加限制。Worker 收到 SIGTERM/SIGINT 时同样在两封之间停下并释放，不会发出一封却让完成写入撞上关闭中的连接池。
- **结果写入带认领守卫。** 完成、重试、失败、释放都要求行仍是 `sending` 且 `attempts` 等于认领时的值；租约到期后被别人重新认领（attempts + 1）时，迟到的旧处理者什么也写不进去，也不写告警。代价是旧处理者已经发出的那封邮件以新认领的结果为准（至少一次）。
- **认领查询。** 选行放在 `MATERIALIZED` 的 CTE 里（`LIMIT … FOR UPDATE SKIP LOCKED`），再 `UPDATE … FROM`，避免计划器把带 LIMIT 的 SKIP LOCKED 子查询并入外层语句。
- **收件人校验。** `enqueueEmail` 要求每个收件人是单个纯邮箱地址（zod email，小写、去重）；带逗号、显示名（`A <a@b.c>`）、尖括号、空格的条目丢弃。丢弃而不是抛错：入队通常和余额变动在同一个事务里，抛错会回滚业务事务，违背决定 26「状态照常前进」。全部被丢弃时入队为 `skipped`，原因 `invalid_recipients`（原本就没有收件人仍是 `no_recipients`）；返回值的 `droppedRecipients` 给调用方记日志。
- **邮件内容的取舍。** 汇总邮件（决定 34）**不含**告警的自由文本说明，参数里也不收，只有类型、持续时长、距上次新增数、累计数、受影响最多的 5 个租户编码和站点链接。开始邮件保留经过净化的说明（折成单行，并抹掉通话 UUID：整个含 UUID 的子句，如「，最近一通 <uuid>」，一起去掉，不留悬空的省略号）；恢复邮件没有说明。开始邮件里「（按话单到达时间记录）」只对 `auth_timeout` 加，其余类型的开始时间就是事件发生的时间。
- **给 PR 3 的提醒。** 触发器写入 `email_outbox.params` 的金额必须是字符串（模板用 `moneyAmountSchema` 校验，数字类型会被拒绝并导致邮件渲染失败）；保存租户设置（通知邮箱变化）时要调用 `recoverRecipientAlert`；余额类邮件用 `balance_low` / `balance_suspended` 的 params 形状（租户编码、名称、币种、余额、阈值、透支额度、可用额度）。
- **测试不读 `SMTP_*`。** 开发机的 `.env` 可能是真实邮箱，测试只认 `MAILPIT_SMTP_HOST`、`MAILPIT_SMTP_PORT`、`MAILPIT_API_URL`（默认就是 compose 的端口），且必须是回环地址。Mailpit 固定为 `axllent/mailpit:v1.31.5`（镜像是 scratch 构建，健康检查用 `/mailpit readyz`）；`nodemailer` 固定 `10.1.1`，自带类型。

## 余额提醒与停机通知

### 状态与滞回

新表 `balance_notice_state (tenant_id PK, low_active boolean, low_seq integer, suspended_active boolean, suspended_seq integer, updated_at)`，RLS `staff_only`。`low_active = true` 表示「已为这一轮低余额发过通知，在回到阈值之上之前不再发」。

对一次余额变化，记 `b` 为新余额，`T` 为租户阈值，`O` 为透支额度，`a = b + O` 为可用额度：

| 条件                                 | 动作                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `T > 0 且 b < T 且 not low_active`   | `low_active := true`，`low_seq + 1`，入队 `balance_low`                   |
| `b >= T 且 low_active`（或 `T = 0`） | `low_active := false`（重新上膛，不发邮件）                               |
| `a <= 0 且 not suspended_active`     | `suspended_active := true`，`suspended_seq + 1`，入队 `balance_suspended` |
| `a > 0 且 suspended_active`          | `suspended_active := false`                                               |

阈值 0 的含义是「不做低余额提醒」（与 `tenantHealth` 一致：阈值为 0 时 `b < 0` 已是「透支」状态，不会再出现「余额不足」），见[决定 24](#已决定)。同一次变化同时满足第 1、3 行时只发停机通知（[决定 28](#已决定)），`low_active` 仍置真，避免随后立刻再补一封。

**验收 1 的场景（阈值 100）：**

| 步骤     | 余额 | `low_active` 前 → 后 | 入队             | Mailpit 累计 |
| -------- | ---- | -------------------- | ---------------- | ------------ |
| 初始     | 120  | 假 → 假              | 无               | 0            |
| 通话扣费 | 80   | 假 → 真              | `balance_low` #1 | 1            |
| 通话扣费 | 50   | 真 → 真              | 无               | 1            |
| 充值     | 150  | 真 → 假              | 无               | 1            |
| 通话扣费 | 90   | 假 → 真              | `balance_low` #2 | 2            |

边界另有测试：余额恰好等于阈值（100）不触发，99.99 触发；回到恰好 100 重新上膛。**验收 2：** 透支额度 100 的租户余额降到 −100（可用额度 0）收到 1 封停机通知；之后在途通话继续扣费到 −101 不重发；充值使可用额度 > 0 后再降到 ≤ 0，才发第二封。

### 判定放在哪里：`tenant_balances` 的触发器

选择在 `tenant_balances` 上加 `AFTER UPDATE OF balance` 触发器（`SECURITY DEFINER`，与 `ledger_entries_apply_balance` 同写法），在同一事务里读取阈值、透支额度、状态行，按上表更新状态并插入发件箱（决定 2）。理由：

- **所有改变余额的路径都被覆盖**：Worker 扣费、API 的充值、赠送、调账、阶段 8 的分配补扣费、`rebuild_tenant_balances` 重算，都是同一条 `UPDATE`；放在应用代码里会漏路径。
- **与流水原子**：流水提交则判定提交，回滚则一起回滚；不会「通知发了而余额没变」。
- **串行**：流水触发器要求持租户锁，同一租户的判定不会并发，状态行不需要额外锁。
- **不会漏掉快速来回**：定时扫描会漏掉两次扫描之间 150 → 90 的来回（滞回的重新上膛被跳过），触发器逐次变化判定。

代价和待测：每次余额变化多读一行设置和一行状态（主键查找，只在状态变化时写）。扣费是热路径，PR 3 在 PORTALBIG 上测加触发器前后的扣费吞吐，结果写入证据；若影响超过可接受范围，退路是把判定改为「触发器只记录 `tenant_id` 到待判定表、tick 里批量判定」（仍然是事务内的，只是延迟不超过一分钟，且按序号逐笔回放可以不漏来回）。

**阈值或透支额度被改（设置保存）** 时，同一事务内调用 `sync_balance_notice_state(tenant_id)`：按当前余额重新计算 `low_active`、`suspended_active`，**不发邮件**（[决定 29](#已决定)）。新建租户同理（状态行随租户创建初始化，不会因为余额为 0 而在开户当刻发一封）。停用租户（`status = 'disabled'`）：状态照常维护，邮件入队为 `skipped`（`skip_reason = 'tenant_disabled'`，[决定 27](#已决定)）。

### 停机通知与授权「余额不足」的关系（验收 3）

授权拒绝「余额不足」的条件是可用额度不足**所拨号码一分钟的费用**（`callableMinutes = floor(a ÷ 费率) <= 0`），而「已停机」是 `a <= 0`。于是存在一个窗口：`0 < a < 某号码的每分钟费率`，对那个号码授权已经拒绝，但租户状态仍是「透支中」或「余额不足」，也不发停机通知。

规则（[决定 30](#已决定)）：**停机通知只在 `a <= 0` 时发。** 理由：

- 「一分钟的费用」随号码而变（同一租户的费率从 0.01 到 2.5 不等，零费率号码始终放行），没有一个单一的金额可以当作「停机线」；
- `a <= 0` 与后台状态「已停机」、概览「已停机租户」、plan 验收 2 的「余额 + 透支降到 0」是同一个定义，页面、邮件、测试对得上；
- 这个窗口通常很窄（数分以内），并且低余额提醒通常早就发过。

写入的测试：费率 0.05/分钟，`a = 0.03` 时 `authorize` 返回 `余额不足`，但发件箱没有 `balance_suspended`；`a = 0` 时有。窗口里的提醒完全靠低余额通知，所以[决定 24](#已决定)的阈值为 0（关闭提醒）的租户在这个窗口里没有任何通知——写入风险。

**PR 3 实现时对本章的补充与更正：**

- **迁移 0023 的构成。** 表 `balance_notice_state`；`tenant_balances` 上的 `AFTER UPDATE OF balance … WHEN (OLD.balance IS DISTINCT FROM NEW.balance)` 触发器 `tenant_balances_notice`（`SECURITY DEFINER`，`search_path = public, pg_temp`）；它在越线时调用内部函数 `enqueue_balance_notice`（写发件箱）和 `balance_notice_recipients`（收件人规范化）；`tenants` 上的 `AFTER INSERT` 触发器 `tenants_open_balance_notice`（开户时按余额 0 初始化状态行）；对外的 `sync_balance_notice_state(tenant_id)`。内部函数和两个触发器函数都 `REVOKE ALL … FROM PUBLIC` 且没有授予应用角色，只有 `sync_balance_notice_state` 授予 `fs_billing_app`，并在函数里要求 `app_is_operator()`（它绕过状态表的 RLS，所以不能让租户身份调用）。触发器函数不做操作员检查：`rebuild_tenant_balances` 由 owner 无作用域地执行，同样要走判定。
- **状态判定的写法。** 两个标志每次都按新余额重算（`low_now = T > 0 且 b < T`，`suspended_now = b + O <= 0`），与状态行里的值比较：相同就什么都不写（热路径上只多一次 `tenants ⨝ balance_alert_settings ⨝ balance_notice_state` 的主键连接读）；不同才 upsert 状态行，并且仅在「由假变真」时发邮件。这与设计表里四行的写法等价，但把「重新上膛」和「保持」合成同一个赋值，没有漏掉的组合。两条线同时被越过时只入队 `balance_suspended`，`low_active` 置真，`low_seq` 不加（决定 28）。
- **没有状态行的租户。** 正常路径不会出现（开户触发器与迁移回填保证每个租户一行）；手工插入的旧数据兜底：把变化前的余额当作上一次状态来推，补写状态行。
- **收件人在 SQL 里规范化。** 触发器直接写发件箱，不经过 `enqueueEmail`，所以 `balance_notice_recipients` 在 SQL 里复刻同样的规则：去空白、小写、去重（保持顺序）、只留单个纯邮箱地址（正则取自 zod 的 `z.email()` 默认规则，测试 `the SQL recipient filter agrees with the settings validation` 用一组正反例与 `z.email()` 逐条对照）。全部被丢弃入队为 `skipped / invalid_recipients`，原本为空是 `no_recipients`，停用租户是 `tenant_disabled`（优先）。丢弃而不是抛错，理由同 PR 2：抛错会回滚扣费。
- **params 的形状。** `balance_low`：`tenantCode / tenantName / currency / balance / overdraftLimit / threshold / available`；`balance_suspended`：前五个，没有 `threshold`、`available`（模板的 strict 校验会拒绝多余字段）。金额全部 `numeric::text`，保持库里的小数位数（与 `tenantBalanceText` 一致，所以邮件和页面是同一个数字）；`completeEmail` 据此写 `balance_alert_deliveries.balance`。幂等键 `balance_low:<租户>:<序号>`、`balance_suspended:<租户>:<序号>`（TS 侧 `balanceNoticeDedupeKey`）。
- **同步函数锁余额行。** `sync_balance_notice_state` 在保存设置的事务里（已持租户锁）先对 `tenant_balances` 行 `FOR UPDATE` 再读写状态行：流水路径持租户锁，同步路径同样持租户锁，所以它们已经串行；多出来的这一把行锁是为了与只持余额行锁的 `rebuild_tenant_balances` 串行。加锁顺序「租户锁 → 余额行」与流水路径一致，重算只拿余额行，不会成环。
- **谁调用同步。** `createTenant`（写完 `balance_alert_settings` 之后：开户余额 0，阈值大于 0 时 `low_active` 置真，不发邮件）、`updateTenantSettings`（有任何设置变化时；通知邮箱有变化时另调 `recoverRecipientAlert`，恢复该租户的 `recipient:<租户>` 告警）。停用、启用租户不碰状态：状态始终按余额维护，所以重新启用不补发（决定 27）。
- **迁移顺序与回填。** 先建触发器（`CREATE TRIGGER` 取 `SHARE ROW EXCLUSIVE`，等在途写入提交并挡住新写入，直到迁移提交），再回填：已有租户按当前余额写状态行，`low_active` / `suspended_active` 取真值，序号为 0，**不写 `email_outbox`**。测试在一个迁到 0023 之前（即 PR 4 的 0022 已应用，与合并后的 main 一致）的、灌了种子的库上执行 0023，断言发件箱仍为空、每个租户一行、标志与口径逐租户一致（`balance-notices-backfill.db.test.ts`）。
- **种子不排邮件。** 种子的流水是历史，不是事件，但 owner 连接写流水同样会触发判定。`seedDatabase` 在写完流水的同一事务末尾删除本事务排进发件箱的余额通知（开始写流水前先取发件箱现有行的 id 快照，只删快照之外、模板为 `balance_*`、租户为种子租户的行，不依赖事务开始时间），状态行保留（标志已跟上最终余额）。否则 Worker 起来后会把种子租户的「余额不足」邮件真的发到 `billing-ops@example.com`。
- **并发测试。** 租户锁已经让两笔扣费互相串行，所以光测「两笔扣费并发」对触发器是否正确没有区分力。真正会交错的是只持余额行锁的 `rebuild_tenant_balances`（以及保存设置时的 `sync_balance_notice_state`）与流水路径：测试用 `pg_blocking_pids` 轮询确认被堵的后端，再放行，断言标志与最终余额、设置一致，邮件数符合预期。
- **测试位置。** 设计把 Mailpit 的验收测试（1、2）写在 `notify.db.test.ts`，但那个文件属于 PR 4（`notify-tick`），避免两个 PR 同时改它，PR 3 的 Worker 测试放在 `apps/worker/src/balance-notices.db.test.ts`，测试名沿用设计里的计划名。
- **吞吐。** 见 [`docs/evidence/phase-9/balance-notice-perf.md`](evidence/phase-9/balance-notice-perf.md)。

## 故障告警邮件：开始、汇总、恢复

### 告警设置

新表 `alert_settings`（单行，`CHECK (id)`）：`recipients text[]`（规则同租户邮箱：小写、去重、≤ 20，允许为空）、`digest_minutes integer`（1–1440，默认 15，[决定 31](#已决定)）、`version integer`（乐观并发，保存带 `expectedVersion`）、`updated_at`、`updated_by uuid REFERENCES admins`。RLS `staff_only`。设置页对应设计稿 6c，读写走 `PUT /api/admin/alert-settings`，写 `alert_settings_update` 操作日志（同事务）。

### `notify-tick`

每分钟一次的 Worker 任务（[定时任务](#定时任务真实-cron-与多实例)），一个事务内按序做：

1. **恢复**：对进行中的告警按[恢复条件](#统一的写入与恢复函数)置 `recovered_at`：事件型告警 `last_seen_at <= now − ALERT_QUIET_MINUTES`；未归属键与校验失败键检查对应 `pending` 行是否清零；`charge-reconcile` 检查流水；`partition-maintenance` 由维护任务自己恢复，`partition-missing` 走静默窗口（见[告警模型](#告警模型)）。未归属 / 校验失败键在 PR 1 已在事务内恢复，这里只是全量扫描兜底。
2. **开始**：`UPDATE system_alerts SET notified_start_at = now(), digest_cursor = occurrences, last_digest_at = now() WHERE notify AND notified_start_at IS NULL AND recovered_at IS NULL RETURNING …`。**开始、汇总、恢复通知三条查询都必须带 `notify = true`**：迁移回填后未恢复的旧告警是 `notify = false`、`notified_start_at` 有值、`notified_recovered_at` 为空，漏掉这个过滤，它们升级后第一次恢复就会发一封恢复邮件。同一 tick 新开的所有告警合并为**一封** `alert_start`。开始即恢复的（还没来得及发开始邮件就恢复了）不发开始也不发恢复，只留在页面。
3. **汇总**：到期的告警 = `notified_start_at IS NOT NULL AND recovered_at IS NULL AND now >= greatest(notified_start_at, last_digest_at) + N AND occurrences > digest_cursor`。每条告警有**自己的**汇总节拍（从开始邮件或上一封汇总算起 N 分钟），同一 tick 内到期的合并成**一封** `alert_digest`，随后 `last_digest_at := now()`、`digest_cursor := occurrences`。**没有新增事件就不发汇总**（等恢复）。
4. **恢复通知**：本 tick 刚恢复且已发过开始邮件的告警（`notified_recovered_at IS NULL`）合并为一封 `alert_recovered`。同一 tick 既到期汇总又恢复的，只发恢复（含累计）。
5. 发件箱入队与上面各列的更新在同一事务，所以每个状态变化恰好产生一封邮件；随后是[分发](#分发重试退避)。

N 取自 `alert_settings.digest_minutes`。函数 `runNotifyTick(db, { now })` 和 `raiseAlert` 都接受显式时间，所以验收 4 的 20 分钟场景用假时钟在毫秒内跑完，不真的等 20 分钟；真实时钟只在[真实 cron 测试](#定时任务真实-cron-与多实例)里出现。

### 验收 4 的时间线（N = 10，`ALERT_QUIET_MINUTES` = 10）

授权超时持续 20 分钟，每分钟一条未验证话单入库（分钟 0–19），tick 每分钟一次：

| 分钟  | 发生的事                                           | `occurrences` / `digest_cursor` | 发出的邮件             |
| ----- | -------------------------------------------------- | ------------------------------- | ---------------------- |
| 0     | 第一条未验证话单，开告警；tick 认领                | 1 / 1                           | **开始 #1**            |
| 1–9   | 事件累加；tick 判断未到 `0 + 10`                   | 10 / 1                          | 无                     |
| 10    | tick：`now ≥ 0 + 10`，`10 > 1`                     | 11 / 11                         | **汇总 #1**（新增 10） |
| 11–19 | 事件累加                                           | 20 / 11                         | 无                     |
| 20    | tick：`now ≥ 10 + 10`，`20 > 11`                   | 20 / 20                         | **汇总 #2**（新增 9）  |
| 21–28 | 故障结束，无新事件；`last_seen_at` = 19            | 20 / 20                         | 无                     |
| 29    | tick：`29 − 19 ≥ 10`，恢复                         | —                               | **恢复 #1**            |
| 30    | 已恢复；即便没恢复，`20 > 20` 不成立也不会再发汇总 | —                               | 无                     |

合计 1 + 2 + 1 = 4 封。若静默窗口改大（例如 15 分钟）恢复推迟到分钟 34，结果相同——这是「无新增不发汇总」规则的作用。测试同时断言各封的主题与正文要点，以及收件人等于设置的接收邮箱。

**PR 4 实现时对本章的补充与更正：**

- **迁移 0022 自成一体**：`alert_settings`（单行，`id boolean PRIMARY KEY DEFAULT true CHECK (id)`，`recipients text[]` 最多 20 个，`digest_minutes` 1–1440 默认 15，`version`，`updated_at`，`updated_by uuid REFERENCES admins`，RLS `staff_only`，应用角色 `SELECT, INSERT, UPDATE`）、迁移里插入默认行（Worker 读设置不会读空）、SECURITY DEFINER 函数 `alert_admin_emails()`、局部索引 `system_alerts_recovery_notice`。库函数在 `packages/db/src/alert-notify.ts`：`readAlertSettings`、`saveAlertSettings`（带 `expectedVersion`，不符抛 `AlertSettingsVersionConflictError`，API 的 409 与审计日志在 PR 6）、`resolveAlertRecipients`、`queueAlertNotices`。
- **管理员邮箱的读取（回答「本步验证」里的未决项）**：`admins` 的 RLS 只放行 `admin` 作用域，`auth.lookup_user_emails` 同样只允许 `admin` 作用域，而 Worker 是 `system` 作用域，两者都读不了。所以决定 33 的兜底经新函数 `alert_admin_emails()`（SECURITY DEFINER，要求 `app_is_operator()`，只返回 `active` 管理员的小写登录邮箱，不返回姓名和 id）。
- **保存收件人时恢复 `recipient:admin`**：`saveAlertSettings` 在接收邮箱列表**变化**时同事务调用 `recoverAdminRecipientAlert`（只改汇总间隔不动它，让它按 7 天窗口恢复）。PR 2 里的 TODO 到此完成。
- **`runNotifyTick` 重构为一个事务加分发。** `queueNotifications(db, { quietMinutes, now })` 是 `withSystem` 的单个事务，顺序：`recoverClearedUnassignedAlerts`（全量兜底）→ `recoverPaidChargeReconcileAlerts` → `recoverQuietAlerts` → `recoverStaleRecipientAlerts` → `queueAlertNotices`（开始 → 汇总 → 恢复通知，各自入发件箱）。两个兜底函数加了可选的 `at`，用 tick 的注入时钟。**加锁顺序**：未归属族的互斥锁（`lock_alert_family()`，`recoverClearedUnassignedAlerts` 内部拿）必须是事务里第一个动告警行的操作，因为入库事务的顺序是「未归属族 → fs-authorize」，而静默窗口恢复会改 `fs-authorize` 那一行；先改行再拿锁会与入库事务成环。分发（SMTP）留在事务之外，租约与停止信号的逻辑不变。通知入队失败时 `runNotifyTick` 仍然分发发件箱里已有的邮件（余额提醒不该被告警通知的故障拖住），分发完再抛出，让任务在 pg-boss 里可见地失败；恢复的各步骤与入队互相隔离，见下面的「一个步骤失败不拖住别的」。代码在 `apps/worker/src/notify.ts`（`runNotifyTick`、`startNotifyJobs` 从 `mail.ts` 移来，`mail.ts` 只留传输与分发）。
- **汇总的幂等键**：设计原写 `alert_digest:<告警 id>:<digest 序号>`，但表里没有序号列，而一封汇总邮件合并了多条告警。实现取这一批里最小的告警 id，序号用这条告警上一封开始或汇总邮件时的 `digest_cursor`（每发一封汇总它就前进，所以键不会重复）：`alert_digest:<最小告警 id>:<上一次的 cursor>`。开始邮件 `alert_start:<最小告警 id>`；恢复邮件同样合并，`alert_recovered:<最小告警 id>`（单条恢复时就是 `alert_recovered:<告警 id>`）。一封邮件最多列 200 条告警（模板上限），超出的按 id 排序拆成多封，各用各自的最小 id。
- **汇总里的「受影响最多的租户」（评审后修订）**：`auth_timeout` 取**距上次开始/汇总邮件以来**入库（`cdrs.received_at`，区间 `[greatest(开始时间, 上次邮件时间), 本次 tick]`）的未验证话单按租户计数的前 5 个编码；`started_at` 取 `[since − 7 天, until + 1 天]`，只为分区剪枝。带租户的告警（对账、账单核对）给那个租户的编码；其余没有租户，空列表。参数里没有自由文本说明。**这个统计在 tick 的事务和锁之外**：`previewDigestTopTenants` 在加锁之前用独立事务（`SET LOCAL statement_timeout = 3s`）为到期的 `auth_timeout` 告警算好，结果传给 `queueAlertNotices`；失败或超时降级为空列表（汇总不带租户编码）并记日志，结果是近似的（加锁时到期的集合可能已变，没有预算到的按空列表）。PORTALBIG 形状（340 万行）上 35–51 ms、只扫当月分区，不加索引，见 [notify-tick-perf.md](evidence/phase-9/notify-tick-perf.md)。
- **没有收件人时**：设置为空且没有 `active` 管理员，邮件入队为 `skipped`（`no_recipients`），告警上的通知列照常前进，不会每分钟重试。
- **三条认领查询**都先 `SELECT … ORDER BY id FOR UPDATE SKIP LOCKED` 再 `UPDATE`，全部带 `notify = true`；两个 tick 同时跑，后到的跳过先到的锁着的行，什么也不认领。耗时见 [notify-tick-perf.md](evidence/phase-9/notify-tick-perf.md)。
- **tick 不为告警行等锁（评审后修订）。** 别的写入路径逐行加锁的顺序各不相同：账单核对按 `started_at, id` 逐行改 `statement:*`，对账告警按通话逐条，而 tick 的认领按 `id` 顺序，会和它们成环。选择让 tick 一律 `FOR UPDATE SKIP LOCKED`（认领的三条查询，加上静默窗口、对账补记、收件人 7 天窗口三个多行恢复，经 `recoverAlertsWhere` 的 `skipLocked` 选项：先按 id 顺序锁住要改的行再 UPDATE）：被别人锁着的行这一分钟跳过、下一分钟再处理。理由：不等锁就不会成为任何环的一部分，与其他路径的加锁顺序无关，也不必改账单核对等 PR 1 的代码；代价只是被占用的行晚一分钟处理，对每分钟一次的通知任务无所谓。各写入点自己的恢复（`chargeCall`、核对、归档）仍是普通的等锁 UPDATE，必须恢复成功。
- **一个步骤失败不拖住别的（评审后修订）。** 事务里的恢复每一步各在一个保存点（`tx.transaction`）里：失败只回滚这一步并记日志，其余照常；认领与入队（开始、汇总、恢复通知）合为一个保存点，失败则这一轮的认领整体回滚（不会出现状态前进而没有邮件），恢复仍然提交，错误在提交之后抛出（分发之后任务可见地失败）。互斥锁 `lock_alert_family()` 在任何保存点之外取，因为保存点回滚会释放在其中取得的咨询锁。此前的「恢复与认领一起回滚」改为这样，是因为一个持续失败的步骤（例如入队）会让告警永远恢复不了、开始邮件每分钟重试同一个失败。
- **汇总节拍的取整（评审后修订）。** `notified_start_at`、`last_digest_at`、`notified_recovered_at` 和到期比较都用向下取整到分钟的 tick 时间（`noticeSlot`）。否则 tick 每次启动的秒数有抖动（上一次 12:00:03，这一次 12:15:01.8 差 1.2 秒不到 N = 15），汇总会无端推迟一分钟。发件箱行和持续时长仍用原始时间。
- **`recipient:admin` 的恢复按集合比较**：只是调换接收邮箱的顺序不算改了，不恢复。

**PR 6 实现时对「系统告警页与概览页」「端点与契约」的补充与更正：**

- **契约方法加 `PUT`。** `ApiOperation.method` 原只有 `GET`、`POST`；设置写入按设计用 `PUT /api/admin/alert-settings`，所以加上 `PUT`，来源检查（`Origin` / `Sec-Fetch-Site`）从「仅 POST」改为「所有非 GET」。`web/src/lib/api.ts` 的契约登记留给 PR 7。
- **口径。** 告警窗口谓词 `alertWindowPredicate`（`packages/db/src/alert-list.ts`）：`recovered_at IS NULL OR started_at >= T − 窗口 OR recovered_at >= T − 窗口`，`T` 默认事务的 `now()`；列表的 `total`、概览的 `last24h`、汇总的 `last24h` 都经 `countAlertsInWindow`。进行中条数 `countOpenAlerts`（列表 `openCount`、汇总 `open`、概览 `open`）。概览的待收款是 `readReceivableTotals`（`listReceivables` 也改用它），已停机 / 余额不足是 `readTenantsByHealth`（与列表同一个 `tenantHealth` 片段和排序），未归属是 `readUnassignedSummary`。概览整体在一个 `repeatable read` 只读事务里（`getAdminOverview`）。
- **消费与分钟的聚合。** 流水一次扫描（本月 1 日与 29 天前较早者起），按北京日、币种分组，今日 / 本月 / 近 30 天都从这一组取；今日分钟按接通时间，`started_at` 下界取今天零点前一天，只为分区剪枝。租户总数含已停用租户（PR 7 的指标卡片标签写「含已停用」）。
- **`lastOpenedAt`** 取进行中告警里最近一条的开始时间（没有进行中的为 null）。
- **详情。** `auth_timeout` 的受影响租户与话单时间范围取 `received_at` 在 [开始, 恢复或现在] 的未验证话单，一次扫描；30 天上限从告警的结束往前数（`hi` = 恢复时间或现在，`lo = max(开始, hi − 30 天)`，`truncated = hi − 开始 > 30 天`），所以很久以前恢复的短告警照样统计得到；`cdrRange` 给最早、最晚 `started_at` 及其北京日，页面据此拼租户话单标签页的链接。`cdr_failed` 的未归属 / 校验失败类由告警键反推 `unassignedFilter`（`reason`，租户不存在时再加 `tag`），未归属列表因此加了精确匹配的 `reason` 筛选。通知记录按发件箱快照里的告警 `id` 关联（PR 6 起 `queueAlertNotices` 把告警 id 写进快照的每个告警对象；模板 schema 接受它，从不渲染）；此前入队、没有 id 的行退回 `(kind, startedAt)`。返回最新的 50 封，从旧到新显示；响应不含收件人地址。5 万行发件箱上 13.7 ms，不加索引。
- **设置。** `updateAlertSettings`（`packages/db/src/admin/alert-settings.ts`）调用 `saveAlertSettings`，同一事务写 `alert_settings_update`；版本不符的 `AlertSettingsVersionConflictError` 经 `mapBusinessErrors` 变成 409。内容没变（接收邮箱按集合比较，汇总间隔相同）的保存什么也不做：`expectedVersion` 仍要匹配（否则 409），但不加版本、不写日志，返回当前设置和 `auditId: null`（同 `updateTenantSettings`）。操作日志标签新增 `settings`（「修改设置」），对象类型 `alert_settings`（全局单行没有 uuid，对象取审计自身的 id），变更字段 `alertRecipients`、`digestMinutes`。邮箱规则同租户邮箱：不去空白，带空白的地址按格式错误拒绝。
- **`mailEnabled` 不另设开关（评审后修订）。** 原设计加一个 `MAIL_ENABLED`，但两个开关会各说各话：Worker 看 `SMTP_HOST` 与 `MAIL_FROM`，页面却看另一个键，忘了同步时设置页会说谎。所以 API 直接读与 Worker 同一个信号：`SMTP_HOST` 与 `MAIL_FROM` 都已设置（空串等同于没设置，同 `apps/worker/src/config.ts`）。API 只读这两个非秘密的键，不读也不校验 `SMTP_USER` / `SMTP_PASS`。没有新的环境变量。
- **web 的最小改动。** 新的冲突码、审计字段和对象类型让 web 里的穷尽映射无法通过类型检查，所以 `lib/api-problem.ts`、`pages/admin/audit-logs.tsx` 各补了中文文案；页面本身留给 PR 7。
- **性能。** 见 [overview-perf.md](evidence/phase-9/overview-perf.md)：PORTALBIG 形状的库上概览中位数约 195 ms，`auth_timeout` 详情约 290 ms，没有加缓存或索引。

## 定时任务：真实 cron 与多实例

### 真实每分钟 cron 触发测试（验收 8）

现有测试检查调度元数据后手动 `boss.send()`（[phase-7 记录](evidence/phase-7/README.md)），没有证明时钟触发。新测试 `apps/worker/src/cron.db.test.ts`：

1. 起一个真实 `createBoss`（与 `main.ts` 同样的配置：`schedule: true`、`noAdvisoryLocks`、队列预建），注册 `notify-tick` 的真实处理函数，`boss.schedule('notify-tick', '* * * * *', null, { tz: 'Asia/Shanghai' })`，**不调用 `boss.send`**。
2. 轮询任务表，最多等 150 秒，断言出现一个由调度创建的任务（`singleton_key` 带调度标识、`created_on` 落在分钟边界后 `cronMonitorIntervalSeconds`（pg-boss 默认 30 秒）以内），且处理函数被调用一次、任务进入 `completed`。
3. 延伸（同一文件，标 `slow`）：继续等下一个分钟，断言又有且只有一个新任务——证明不是一次性。

这个文件单测约 1.5–3 分钟，进 `pnpm test:db`，CI 多花的时间在 PR 5 实测后写入证据；`vitest.db.config.ts` 的 `testTimeout`（20 秒）对该文件单独放宽，不改其他文件。同样的测试对 `archive-raw-cdrs`、账单任务不再重复，调度元数据测试保留。

### pg-boss 关闭 advisory 锁与多实例（验收 9）

**读源码得到的结论（本步读了 `pg-boss@12.37.1` 打补丁后的 `dist`，没有运行任何多实例测试）：**

- `noAdvisoryLocks` 去掉的是 `locked()` 里包在维护语句前的 `pg_advisory_xact_lock`（建删队列、`failJobsByTimeout`、`failJobsByHeartbeat`、过期任务删除 `deletion`、`cleanupDependencies`、队列统计写入）和队列统计聚合里的 `pg_try_advisory_xact_lock`。我们的 `persistQueueStats: false`，统计相关的两项不适用。
- 去掉它们**不改变**这些机制的跨实例排他：定时触发靠 `trySetCronTime` 的数据库侧「认领」加上转发任务的 `singletonKey`（`occurrenceKey`）与 60 秒节流，保证同一次触发只落一个任务；队列维护靠 `trySetQueueDeletionTime` 的认领（带 `SKIP LOCKED` 选项）；取任务是 `FOR UPDATE SKIP LOCKED`（取任务的 SQL 本步未逐行核对，PR 5 核对）。advisory 锁在这里是「避免两个实例做重复的维护 SQL」的优化与串行化，不是正确性的唯一来源。
- 去掉后的新情形：两个实例同时执行同样的 `UPDATE … failJobs` 或 `DELETE`，会互相等行锁或在极端顺序下 `40P01`。`createBoss` 的每条 SQL 都走 `withSystem`，它对 `40P01`/`40001` 自动重试（`packages/db/src/client.ts:155-208`），维护语句幂等，所以结论是「可能多等锁，不应出错」——**这是推断，要测**。
- 补丁的前提不是「只有一个 Worker」，而是「应用角色不能调 `pg_advisory_*`」（0000 撤销）。plan 里「补丁假设单实例」是对原因的误读，但仍要证明多实例安全。

**验证方式（PR 5）：** 测试里起两个 `PgBoss` 实例（各自独立连接池，配置同 `main.ts`），同一个库、同一批队列和调度：

1. 两实例都注册 `notify-tick` 的 `* * * * *`，真实时钟下一个分钟只有一个任务、只执行一次（扩展验收 8 的测试）。
2. 入队 N 个扣费任务（`singletonKey` = UUID），两实例并发处理，每个任务恰好执行一次，`call:<UUID>` 流水无重复，余额等于流水合计。
3. 两实例同时执行 `supervise`（把一批已过期的 `active` 任务置超时），重试计数每个任务只加一次，没有未处理的 `error` 事件。
4. 发件箱：向 Mailpit 发 K 封邮件，两个分发器并发，Mailpit 收到恰好 K 封（`FOR UPDATE SKIP LOCKED` 认领）。
5. 归档队列的 `exclusive` 策略：两个实例同时触发，只有一个任务运行。

任何一项失败，退路按序：(a) 用 `WORKER_RUN_SCHEDULER=false` 之类的开关让只有一个实例注册调度和维护，其余实例只处理任务（运维层面的单调度器）；(b) 改补丁，用 `SECURITY DEFINER` 包装函数给应用角色提供受限的 advisory 锁，不放开 `pg_advisory_*`。最终以测试结果为准，不在本设计里预设结论；plan 的措辞是「验证多实例安全性或修改实现，必须在多实例部署前完成」，生产在阶段 10 是单个 Worker 实例，所以此项不阻塞阶段 10，但阻塞多实例部署。

## 计费号码不一致日志的脱敏（验收 10）

现状（`app.ts:77-92`）：`request.log.error` 带 `uuid`、`tenant`、`dialedNumber`、`callee`、`luaBillingNumber`、`billingNumber`。四个号码是客户的被叫号码，属于个人信息；日志由 pino 写到标准输出，进 systemd journal，没有脱敏、访问和保留约定。这个日志只在 Lua 与 Worker 的归一化规则不一致（即部署或版本错配）时出现，需要的信息是**哪里不一致**，而不是号码本身。

规则（[决定 37](#已决定)）：

1. 新增 `maskNumber(value)`：`+` 前缀保留，保留前 4 位和后 2 位，中间以 `*` 代替，附总长度；长度 ≤ 6 的整体替换为 `*` 加长度。例：`8613800138000` → `8613*******00(13)`。
2. 日志只含 `uuid`、`tenant`，四个号码用 `maskNumber`，另加结构性对比字段：`calleeEqualsDialed`、`luaEqualsWorker`、各号码的长度与是否以 `+` 或 `00` 开头、`reason`（`only-lua-differs` / `callee-differs`）。排查归一化规则差异靠这些字段和 `freeswitch/tests/dialed-cases.tsv` 的用例，不需要完整号码。
3. 完整号码仍在数据库：对应话单的 `unassigned_cdrs`（原因「计费号码不一致」）和原始 `raw_cdrs` 保存完整值，受 RLS 与后台权限保护；需要完整号码的人从后台查，这才是有访问控制和操作日志的路径。
4. **访问与保留策略：** Worker/API 日志只写标准输出，由 systemd journal 保存；保留 14 天（`journald.conf` 的 `MaxRetentionSec`，阶段 10 运维手册落实），只有 root 与运维组可读，不上传外部日志服务。本阶段把这个约定写进 `docs/development.md` 与阶段 10 清单，部署配置属于阶段 10。
5. 同时给 Worker 的 pino 加 `redact`（与 API 对齐）：`req.headers['x-billing-key']`、`req.headers.authorization`，以及 `err.detail`（PostgreSQL 唯一冲突的 `detail` 会带键值，例如 `Key (…)=(…)`，可能含号码或邮箱）。

测试：一个断言对 `request.log` 的输出做 JSON 解析，确认不含完整号码、含掩码和对比字段；另一个断言 Lua 与 Worker 一致的正常请求不产生该日志。风险：掩码保留的 6 位仍可能在小号段里识别个人，若要更严格，可改为日志完全不含号码（只留 UUID、租户、长度、对比字段）。

## 系统告警页与概览页

### 两个页面的数字

验收 5 要求「概览页的待收款合计、告警数与对应页面数字一致」。实现方式是**同源**而不是事后比对：

| 概览上的数字                   | 来源（与对应页面共用同一函数/SQL）                                                                                 | 页面                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 待收款总额（CNY、USD 分开）    | `readReceivableTotals(tx, { status: 'pending' })`，即 `adminReceivables` 的 `totals`；不重写聚合                   | 待收款页的 `totals`                           |
| 系统告警（最近 24 小时）条数   | `alertsInWindow(tx, { window: '24h' })` 的计数，与 `GET /api/admin/system-alerts?window=24h` 的 `total` 同一个谓词 | 系统告警页，筛选「最近 24 小时」，「共 N 条」 |
| 进行中的告警（红点、概览红色） | `count(*) WHERE recovered_at IS NULL`，与告警汇总端点同一函数                                                      | 导航红点、告警页「进行中 N」                  |
| 未归属话单数                   | `adminUnassignedSummary.pending` 的函数                                                                            | 未归属话单页                                  |
| 已停机、余额不足租户           | `tenantHealth` 的 `suspended`、`overdraft + low_balance`（「含透支中」）                                           | 租户列表按状态筛选的 `total`                  |

**「最近 24 小时」的口径：** 进行中的告警不论开始多久都算；已恢复的告警 `started_at` 或 `recovered_at` 落在最近 24 小时内算。谓词写一份（`alertWindowPredicate`），页面的两个窗口（24 小时、30 天，设计稿 6d「最近 30 天没有系统告警」）和概览共用。概览响应带 `asOf`（设计稿「数据截至 … · 每分钟刷新」，前端每 60 秒重取）；页面与概览是两个请求，数字在静止数据下相同，之间有写入时可以差一个事件，所以测试在静止库上断言相等，另加一个测试：同一事务快照内两个函数得到相同的结果（保证没有口径差，不是时间差）。

概览其余指标（租户总数、今日通话分钟、今日消费、本月消费、近 30 天每日消费）沿用 [design.md §7.7](design.md#77-消费与通话量的统计口径) 的口径：消费只算通话扣费的绝对值、分钟取计费分钟、已接通按接通时间、日期按北京时间、CNY 与 USD 分开不相加；SQL 在 `packages/db/src/usage.ts` 的租户口径基础上改为按币种聚合所有租户（决定 9）。聚合一个事务内用 `repeatable read` 取一致快照。大表聚合的耗时在 PORTALBIG 上测（[性能](#性能)）。

### 系统告警页

设计稿 6a-6d：表格列时间（开始）、类型、说明、状态（进行中红底 / 已恢复灰）；点行展开详情（6b：开始、恢复、持续时长、影响的通话数「期间放行 23 通未经验证话单」）；「告警列表 / 设置」两个页签（6c 设置：告警接收邮箱 + 汇总间隔）；没有告警的空状态（6d）；导航「系统告警」旁的红点（有进行中的告警时）。手机端卡片和详情底部面板。

- 列表端点：`status`（`all` 默认 / `open` / `recovered`）、`kind`、`window`（`24h` / `30d` / `all`，默认 `30d`）、`page`、`pageSize`（沿用 `adminPageQuerySchema`）。排序：进行中在前，然后按 `started_at DESC`。
- 详情：基础字段加上 (1) 涉及时间范围；(2) `auth_timeout`：受影响最多的 5 个租户（编码、条数）和跳转到该租户话单标签页、筛选「仅看未经验证」加时间范围的链接（设计稿「可跳转查看」）；(3) `cdr_failed` 的未归属类：跳转未归属话单页并带 `reason` 筛选；(4) 通知记录：这条告警相关的开始、汇总、恢复邮件的时间与状态（取自 `email_outbox`，不显示收件人地址）。
- `auth_timeout` 的受影响租户统计从 `cdrs` 取（`unverified = true` 且 `started_at` 在告警涉及时间范围内，分区剪枝）；范围上限 30 天，更长的进行中告警只统计最近 30 天并注明。性能待测。
- 设置页：接收邮箱（≤ 20，规则同租户邮箱）与汇总间隔；保存带 `expectedVersion`；未配置接收邮箱时的提示见[决定 33](#已决定)。邮件发送是否启用由 Worker 读取 `SMTP_HOST` 决定，API 没有 SMTP 凭据；页面要显示「邮件发送未配置，告警和提醒不会发出」，所以 API 读与 Worker 同一个信号（`SMTP_HOST` 与 `MAIL_FROM` 都已设置，不读凭据；PR 6 评审后不再另设 `MAIL_ENABLED`），`adminAlertSettings` 的 `mailEnabled` 取自它。

## 端点与契约

后台操作 `access: 'admin'`、`isolationCase: 'admin-only'`，契约放 `packages/shared/src/api/admin/{overview,system-alerts}.ts`，随 PR 6 路由登记（方式同阶段 7、8）。本阶段没有门户端点。

| operationId                | method path                              | 请求                                                 | 200 响应                                                                    | 说明                                     |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| `adminOverview`            | `GET /api/admin/overview`                | 无                                                   | 指标卡片、需要关注（各项条数与前 5 条）、近 30 天每日消费（按币种）、`asOf` | 只读                                     |
| `adminSystemAlertsSummary` | `GET /api/admin/system-alerts/summary`   | 无                                                   | `{ open, last24h, lastOpenedAt }`                                           | 导航红点，前端 60 秒刷新                 |
| `adminSystemAlerts`        | `GET /api/admin/system-alerts`           | query `status`、`kind`、`window`、`page`、`pageSize` | 分页列表 + `openCount`                                                      |                                          |
| `adminSystemAlertDetail`   | `GET /api/admin/system-alerts/{alertId}` | 路径 id                                              | 详情（见上）                                                                | 不存在 404                               |
| `adminAlertSettings`       | `GET /api/admin/alert-settings`          | 无                                                   | `{ recipients, digestMinutes, version, mailEnabled }`                       |                                          |
| `adminAlertSettingsUpdate` | `PUT /api/admin/alert-settings`          | `{ recipients, digestMinutes, expectedVersion }`     | 同上 + `auditId`                                                            | 写 `alert_settings_update`；版本不符 409 |

新增 409：`ALERT_SETTINGS_VERSION_CONFLICT`（加入 `adminConflictCodeSchema`，`packages/shared/src/api/admin/errors.ts`）。操作日志新增 action `alert_settings_update`（标签「修改设置」，`target.kind = 'alert_settings'`，`changes` 含接收邮箱与间隔的前后值；邮箱是管理员自己的运营邮箱，写入日志可接受）。租户设置里的阈值、邮箱保存沿用现有端点，不新增。

### 越权用例（IDOR）

1. 客户会话调用上表六个操作中的任一个，得 403；未登录得 401（`generateOpenApi` 强制覆盖，`apps/api/src/idor.db.test.ts`）。
2. 数据库层：以租户身份直接 `SELECT`/`INSERT`/`UPDATE`/`DELETE` `email_outbox`、`balance_notice_state`、`alert_settings`、`system_alerts` 都读不到或被策略拒绝（`rls.db.test.ts` 同形）。`balance_alert_deliveries` 本来允许租户读自己的行：测试断言只读到自己的、读不到别人的；门户的任何响应都不含 `recipients`。
3. 门户首页、账单、流水的响应对象是 strict schema，对原始 `response.body` 断言不含 `lowBalance` 之外的任何通知字段（沿用阶段 7、8 的做法）。
4. 邮件内容：租户 A 的 `balance_low` 渲染结果不含租户 B 的编码或金额（单元测试，用两个租户的快照）。
5. 管理员停用后会话立即失效，保存告警设置被拒（沿用既有机制，加一个用例）。
6. 注入：租户名称含 `<script>`、含 `\r\nBcc:` 的主题，渲染结果转义且主题无换行。

## 迁移

| 迁移                       | PR  | 内容                                                                                                                                  |
| -------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `0020_system_alerts.sql`   | 1   | `system_alerts` 新列、索引、回填；`lock_alert_family()` 互斥锁函数                                                                    |
| `0021_email_outbox.sql`    | 2   | `email_outbox`、`email_outbox_purge()`、`balance_alert_deliveries.outbox_id`                                                          |
| `0022_alert_settings.sql`  | 4   | `alert_settings`                                                                                                                      |
| `0023_balance_notices.sql` | 3   | `balance_notice_state`、判定函数、`tenant_balances` 触发器、`sync_balance_notice_state`、为已有租户初始化状态行（按当前余额静默同步） |

已合并的迁移不能再改，所以每个 PR 各带自己的迁移。PR 3 与 PR 4 可并行，实际编号按合并顺序重排。迁移约束：**不得在有历史数据的库上因回填而发邮件**（上节已述）；初始化状态行时 `low_active`/`suspended_active` 取当前余额的真值，所以升级当天已经低于阈值的租户不会收到补发邮件（与[决定 29](#已决定)一致）。迁移要在阶段 10 的有历史数据库上演练锁时长（`system_alerts` 行数不大，触发器创建需要对 `tenant_balances` 短暂的 `SHARE ROW EXCLUSIVE`）。

## Web 页面

页面细节以设计稿为准，下表只列新增或改动的文件。

| 文件                                       | 动作                                                                                                                                         | PR  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `components/app-shell.tsx`                 | 后台导航加「系统告警」（位置：账单之后、操作日志之前，对照设计稿 `items` 顺序），有进行中告警时显示红点；更新文件头注释                      | 7   |
| `router.tsx`                               | `/admin/system-alerts`                                                                                                                       | 7   |
| `pages/home.tsx`（`AdminHome`）            | 换成概览：六个指标卡片、需要关注（已停机、余额不足、未归属、系统告警）、近 30 天消费图（CNY/USD 切换）、加载与「一切正常」状态；手机两列卡片 | 7   |
| `pages/admin/system-alerts.tsx`（新）      | 页签「告警列表 / 设置」；筛选（状态、类型、窗口）；行展开详情；空状态；手机卡片与底部面板；设置表单                                          | 7   |
| `lib/api-problem.ts`                       | `ALERT_SETTINGS_VERSION_CONFLICT` 的中文提示                                                                                                 | 7   |
| `pages/admin/tenant-tabs/settings-tab.tsx` | 通知邮箱为空时的「无法送达」提示保留；文案补「停用租户不发送」（[决定 27](#已决定)）                                                         | 7   |

主题、手机宽度、深浅色的视觉对照在 PR 8 做，沿用阶段 6、7、8 的形式。

## 并发与幂等小结

| 场景                                 | 对策                                                                   | 测试                                                         |
| ------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| 同一次余额变化被重复处理（事务重跑） | 状态更新与发件箱插入同事务；`dedupe_key` 唯一                          | `a rerun of the same transaction queues one notice`          |
| 两笔扣费并发使余额先后越过阈值       | 租户锁串行；第二笔看到 `low_active = true`                             | `concurrent charges crossing the threshold queue one notice` |
| 两个事件同时开同一条告警             | 局部唯一索引加 `ON CONFLICT DO UPDATE`                                 | `concurrent events keep one open alert`                      |
| 重复 tick / 两个实例同时 tick        | tick 内 `UPDATE … RETURNING` 认领开始、汇总、恢复；发件箱 `dedupe_key` | `two ticks at the same instant queue each notice once`       |
| 两个分发器认领同一封邮件             | `FOR UPDATE SKIP LOCKED` 加租约                                        | `two dispatchers send each message once`（Mailpit 计数）     |
| 分发器在 SMTP 接受后崩溃             | 租约到期重发，`Message-ID` 不变；至少一次                              | `a crashed dispatcher's message is resent after the lease`   |
| SMTP 不可用                          | 退避重试；最终 `failed` 加 `email_failed` 告警；恢复后 `mail:requeue`  | `retries with backoff and opens an email_failed alert`       |
| 保存告警设置时另一个管理员也在改     | `expectedVersion`                                                      | `alert settings reject a stale version`                      |

## 性能

plan 阶段 9 没有性能验收。本步没有做任何测量，下面是 PR 里要测的项目，沿用 `fs_billing_perf`（PORTALBIG）上的做法：

- 加 `tenant_balances` 触发器前后，扣费任务的吞吐和单笔事务耗时（PR 3）。
- `GET /api/admin/overview` 在 PORTALBIG（340 万话单、285 万笔流水）上的耗时，含近 30 天按币种的消费聚合和今日/本月聚合（PR 6）；超出预期时的退路是给概览加 `asOf` 缓存（每分钟刷新，设计稿本来如此）。
- `auth_timeout` 详情按租户统计 `cdrs.unverified` 的耗时（PR 6）。
- `notify-tick` 在 10 万行 `system_alerts`、5 万行 `email_outbox` 下的耗时（PR 4）。
- 真实 cron 测试的墙钟耗时对 CI 的影响（PR 5）。

结果写入 `docs/evidence/phase-9/`。

## 已决定

下表是既有文档已定的规则、从仓库推出的约束，以及本设计的技术方案。「本设计」表示技术选择，用户可以推翻，但不是产品问题。产品问题的答复也记在此表（决定 24–37，用户 2026-10-29 确认）。

| #   | 决定                                                                                                                                                                                                                      | 来源                                         | 落实                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| 1   | 邮件走发件箱表 `email_outbox`，由 Worker 定时分发；API 不发邮件、不持 SMTP 凭据                                                                                                                                           | 本设计                                       | [方案](#方案发件箱表不直接发送)；PR 2                       |
| 2   | 余额提醒的判定放在 `tenant_balances` 的触发器里，与流水同事务；设置变更时静默同步状态                                                                                                                                     | 本设计；`0000_init.sql:337-362`              | [判定放在哪里](#判定放在哪里tenant_balances-的触发器)；PR 3 |
| 3   | 发送至少一次：SMTP 接受后崩溃会重发，`Message-ID` 稳定；不追求恰好一次                                                                                                                                                    | 本设计                                       | [分发](#分发重试退避)；PR 2                                 |
| 4   | 重试 5 次（1 分、5 分、15 分、1 小时、3 小时），共 6 次尝试后 `failed`；认证类错误同样退避并开 `email_failed` 告警；`failed` 不自动再试，`mail:requeue` 人工重发                                                          | plan 范围「失败重试并记入系统告警」；本设计  | 同上                                                        |
| 5   | 告警身份用结构化的 `subject_key`，去掉 `LIKE '<前缀>%'` 的写法；全部 10 个写入点收口到 `raiseAlert` / `recoverAlert`                                                                                                      | 本设计；`reconcile.ts`、`archive.ts` 现状    | [告警模型](#告警模型)；PR 1                                 |
| 6   | `email_outbox` 发送成功满 180 天清理；`failed`、`skipped` 同样；应用角色无 `DELETE`，清理走 `SECURITY DEFINER` 函数                                                                                                       | 本设计                                       | [表](#表-email_outbox)；PR 2                                |
| 7   | 告警事件时间取数据库处理时间，不取话单时间；详情另给话单时间范围                                                                                                                                                          | 本设计；`worker-api.md:106`                  | [事件时间的取法](#事件时间的取法)；PR 1                     |
| 8   | 迁移回填使历史告警不发邮件：旧行 `notify = false` 并标记已通知                                                                                                                                                            | 本设计                                       | 迁移 0020；PR 1                                             |
| 9   | 概览同源于对应页面的函数/SQL，不重写聚合；统计口径沿用 design.md §7.7                                                                                                                                                     | plan 验收 5；`design.md §7.7`                | [两个页面的数字](#两个页面的数字)；PR 6                     |
| 10  | 无新增事件不发汇总邮件；同一 tick 内同类邮件合并为一封；开始即恢复不发邮件                                                                                                                                                | plan 验收 4；本设计                          | [`notify-tick`](#notify-tick)；PR 4                         |
| 11  | `email_failed` 不发邮件，只在页面和概览显示                                                                                                                                                                               | 本设计（循环与通道不可用）                   | [模板](#模板)；PR 2                                         |
| 12  | JSON 损坏告警合并为全局一条 `invalid-json`，静默窗口恢复，不新增 pending 行                                                                                                                                               | plan 验收 7 末句；`worker-api.md:103`        | [告警模型](#告警模型)；PR 1                                 |
| 13  | 无效输入告警按阶段 8 的结构化原因合并；原文修正（`superseded`）或忽略使该原因的 pending 清零时恢复                                                                                                                        | plan 验收 7；phase-8 决定 24、26、42         | 同上                                                        |
| 14  | 对账告警在 `chargeCall` 写出流水的同一事务里恢复                                                                                                                                                                          | plan 验收 6                                  | 同上                                                        |
| 15  | 定时任务只有一个：`notify-tick`，每分钟，恢复 → 开始 → 汇总 → 恢复通知 → 分发；`exclusive` 策略                                                                                                                           | 本设计；phase-8 `archive-raw-cdrs` 先例      | [定时任务](#定时任务真实-cron-与多实例)；PR 4               |
| 16  | 多实例安全用「两个 PgBoss 实例」的测试证明；失败时退路是单调度器开关，再次是受限 advisory 锁包装函数                                                                                                                      | plan 验收 9                                  | 同上；PR 5                                                  |
| 17  | 真实 cron 测试：不调用 `boss.send`，等真实时钟触发，进 `pnpm test:db`                                                                                                                                                     | plan 验收 8                                  | 同上；PR 5                                                  |
| 18  | 日志脱敏：号码掩码 + 结构性对比字段；完整号码留在数据库；日志保留 14 天、仅运维可读（掩码强度见决定 37）                                                                                                                  | plan 验收 10                                 | [日志脱敏](#计费号码不一致日志的脱敏验收-10)；PR 5          |
| 19  | 邮件模板为中文纯函数，放 `packages/shared`；纯文本加 HTML；北京时间；不含号码；HTML 转义；主题去换行                                                                                                                      | 用户指定中文模板；本设计                     | [模板](#模板)；PR 2                                         |
| 20  | SMTP 配置键 `SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / MAIL_FROM` 加 `SMTP_TIMEOUT_MS`、`MAIL_RATE_PER_MINUTE`、`MAIL_MAX_ATTEMPTS`、`ALERT_QUIET_MINUTES`、`APP_PUBLIC_URL`；秘密只在环境文件        | 用户给定账号信息；`config.ts` 风格           | [配置](#配置)；PR 2                                         |
| 21  | 本地与 CI 用 Mailpit 接收，不 mock SMTP；服务器原生部署不装 Mailpit；真实 QQ 发送只做手工核实                                                                                                                             | plan 验收 1；原生部署决定                    | [本地与 CI 测试](#本地与-ci-测试)；PR 2                     |
| 22  | 所有 `active` 管理员都可读告警、改告警设置；没有角色区分，不新增                                                                                                                                                          | `design.md:351-364`                          | [越权](#越权用例idor)                                       |
| 23  | `balance_alert_deliveries` 记录实际发出的余额类通知（加 `outbox_id`），不再另建历史表                                                                                                                                     | 本设计；`0000_init.sql:637-644`              | [表](#表-email_outbox)；PR 2                                |
| 24  | 低余额提醒的阈值：只用租户自己的阈值；阈值为 0 表示不做低余额提醒。理由：与现有状态判定一致（阈值 0 时 `余额 < 0` 已是「透支」），也与 pages.md、设置页、种子一致；设置页写明「0 = 不提醒」                               | 用户 2026-10-29 确认 Q1（选项 A，即推荐项）  | PR 3                                                        |
| 25  | 余额提醒与停机通知的收件人：只发给租户的通知邮箱（管理人员邮箱默认就在其中），不抄送管理员。理由：避免管理员收到所有租户的低余额邮件；租户收件人也看不到管理员邮箱                                                        | 用户 2026-10-29 确认 Q2（选项 A，即推荐项）  | PR 3                                                        |
| 26  | 租户通知邮箱为空：不发，入队一行 `skipped` 记录原因，状态照常前进。理由：留空是明确不想通知；配置状态不当作故障；设置页已有「无法送达」提示                                                                               | 用户 2026-10-29 确认 Q3（选项 A，即推荐项）  | PR 3                                                        |
| 27  | 已停用租户（`disabled`）：不发（入队为 `skipped`，原因 `tenant_disabled`），状态仍同步，重新启用后不补发。理由：停用是管理员主动结果，不应再向可能已解约的租户发催款式邮件                                                | 用户 2026-10-29 确认 Q4（选项 A，即推荐项）  | PR 3                                                        |
| 28  | 一次变化同时越过低余额与停机两条线：只发停机通知，低余额视为已触发（`low_active` 置真）。理由：避免连续两封内容相近的邮件                                                                                                 | 用户 2026-10-29 确认 Q5（选项 A，即推荐项）  | PR 3                                                        |
| 29  | 修改阈值或透支额度后是否补发：不补发，静默按当前余额同步状态；租户回到阈值之上再降下去才会发。理由：避免上线当天或批量改阈值时涌出「迟到」邮件                                                                            | 用户 2026-10-29 确认 Q6（选项 A，即推荐项）  | PR 3                                                        |
| 30  | `0 < 余额 + 透支 < 一分钟费用` 窗口是否发停机通知：不发；停机通知只在 `余额 + 透支 ≤ 0` 时发。理由：与后台「已停机」状态、plan 验收 2 同一个定义；该窗口靠低余额提醒覆盖                                                  | 用户 2026-10-29 确认 Q7（选项 A，即推荐项）  | PR 3                                                        |
| 31  | 汇总邮件间隔 N 的默认值：默认 15 分钟（设计稿与 pages.md）；验收测试显式设 N = 10。理由：与设计稿文案一致，不用改设计稿对照；验收时间线沿用 plan 示例的 N = 10                                                            | 用户 2026-10-29 确认 Q8（选项 A，即推荐项）  | PR 4                                                        |
| 32  | 哪些告警类型发邮件：`email_failed` 之外全部发（授权超时、话单处理失败各子类型、分区维护失败、账单核对异常、审计写入失败、归档失败）。理由：合并规则（同键一条、同 tick 合并一封、无新增不汇总）控制数量；不新增按类型开关 | 用户 2026-10-29 确认 Q9（选项 A，即推荐项）  | PR 1、4                                                     |
| 33  | 管理员告警接收邮箱为空：发给所有 `active` 管理员的登录邮箱，页面注明「未设置接收邮箱，当前发给全部管理员」。理由：避免忘记配置时故障无人知晓                                                                              | 用户 2026-10-29 确认 Q10（选项 A，即推荐项） | PR 4、7                                                     |
| 34  | 汇总邮件内容：每条进行中的告警：类型、持续时长、距上次新增数、累计数；受影响最多的 5 个租户编码；站点链接。不含号码、UUID 列表。理由：信息够判断且不把号码、UUID 放进外部邮箱服务                                         | 用户 2026-10-29 确认 Q11（选项 A，即推荐项） | PR 4                                                        |
| 35  | 事件型告警的恢复判定：静默窗口：连续 `ALERT_QUIET_MINUTES`（默认 10 分钟）没有新事件即恢复，之后再出现事件开新的一条。理由：不需要人工点击，验收 4 的恢复邮件可自动产生                                                   | 用户 2026-10-29 确认 Q12（选项 A，即推荐项） | PR 1、4                                                     |
| 36  | 「话单推送延迟 / 队列积压」告警：不做，设计稿示例数据改用真实的告警形态。理由：plan 范围与现有代码都没有此检测；积压由对账告警和数据库队列自行暴露                                                                        | 用户 2026-10-29 确认 Q13（选项 A，即推荐项） | PR 1                                                        |
| 37  | 计费号码不一致日志的脱敏程度：号码保留前 4 位和后 2 位、中间打星、附长度；另记结构性对比字段；完整号码留在数据库；日志保留 14 天、仅运维可读。理由：排查归一化差异靠对比字段即可，完整号码走有访问控制的数据库路径        | 用户 2026-10-29 确认 Q14（选项 A，即推荐项） | PR 5                                                        |

## 验收标准对应计划测试

对应 [plan.md 阶段 9](plan.md#阶段-9通知与告警) 的 10 条验收标准。下表的测试名是**计划名**，PR 8 逐个用 grep 核对：存在且在 `pnpm test:db`、`pnpm test:e2e` 输出里通过，实际名字不同的在验收记录里写明对应关系（阶段 8 的做法）。

| 验收标准                                                                              | 测试文件 / name                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 余额 120 → 80（阈值 100）收 1 封；再降到 50 不再发；充值到 150 后降到 90 再收 1 封 | `packages/db/src/balance-notices.db.test.ts` / `queues one notice per crossing: 120, 80, 50, 150, 90`（断言发件箱 2 行与状态序列）；`apps/worker/src/notify.db.test.ts` / `delivers the two balance notices through Mailpit`（Mailpit 恰好 2 封，主题、收件人、正文含租户与余额）；边界 `does not fire at exactly the threshold`                                                        |
| 2. 余额 + 透支降到 0 收 1 封停机通知                                                  | `balance-notices.db.test.ts` / `queues one suspension notice when balance plus overdraft reaches zero`、`does not repeat while the tenant stays suspended`、`notifies again after a top-up and a second drop`；`notify.db.test.ts` / `delivers the suspension notice through Mailpit`                                                                                                   |
| 3. 明确停机通知阈值与「余额不足」的关系，规则写入设计并有测试                         | 本文[停机通知与授权「余额不足」的关系](#停机通知与授权余额不足的关系验收-3)；`balance-notices.db.test.ts` / `authorize rejects for insufficient balance while available credit is below one minute but no suspension notice is queued`、`a suspension notice is queued exactly when available credit is not above zero`                                                                 |
| 4. 授权超时持续 20 分钟（N = 10）收到 开始 1 + 汇总 2 + 恢复 1                        | `apps/worker/src/notify.db.test.ts` / `a 20 minute authorization timeout sends one start, two digests and one recovery`（假时钟，断言发件箱 4 行与 Mailpit 4 封及顺序）；`does not send a digest without new events`                                                                                                                                                                    |
| 5. 概览页的待收款合计、告警数与对应页面数字一致                                       | `apps/api/src/admin-overview.db.test.ts` / `overview receivable totals equal the receivables page totals`、`overview alert count equals the alerts page total for the same window`、`overview figures come from one snapshot`；`apps/web/e2e/admin-overview.spec.ts` / `shows the same receivable totals and alert count as their pages`                                                |
| 6. 对账（补投）告警恢复后标记为已恢复                                                 | `apps/worker/src/reliability.db.test.ts` / `a reconcile alert is recovered when the charge is finally written`；`packages/db/src/alerts.db.test.ts` / `recovers a charge-reconcile alert in the charge transaction`                                                                                                                                                                     |
| 7. 无效输入告警合并展示与恢复；JSON 解析失败的规则                                    | `alerts.db.test.ts` / `many invalid bodies with one reason keep one alert`、`a corrected push recovers the invalid-input alert`、`an ignored last pending row recovers it`；`apps/worker/src/ingest.db.test.ts` / `broken json pushes keep one invalid-json alert and recover after the quiet window`；`apps/web/e2e/admin-system-alerts.spec.ts` / `shows merged invalid-input alerts` |
| 8. 真实每分钟 cron 触发测试                                                           | `apps/worker/src/cron.db.test.ts` / `the notify-tick cron fires from the real clock without boss.send`、`fires again in the next minute`                                                                                                                                                                                                                                                |
| 9. pg-boss 关闭 advisory 锁的多实例安全                                               | `apps/worker/src/multi-instance.db.test.ts` / `two boss instances fire one cron job per minute`、`two instances charge every job once`、`concurrent supervision does not double-fail jobs`、`two dispatchers send each email once`、`an exclusive queue never runs two archive jobs`                                                                                                    |
| 10. 计费号码不一致日志脱敏                                                            | `apps/worker/src/app.test.ts` / `the mismatch log masks every number and keeps the comparison fields`、`a consistent request writes no mismatch log`、`worker logger redacts the shared key and error detail`；`apps/worker/src/redact.test.ts` / `masks numbers`                                                                                                                       |

### 新增行为的验收与测试

| 验收行为                                         | 测试文件 / name                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空收件人：入队 `skipped`，状态仍前进，不重复触发 | `balance-notices.db.test.ts` / `an empty recipient list is skipped and does not re-arm`                                                                                                                                             |
| 停用租户不发邮件但状态同步                       | `balance-notices.db.test.ts` / `a disabled tenant keeps its state and sends nothing`                                                                                                                                                |
| 改阈值或透支额度静默同步，不补发                 | `balance-notices.db.test.ts` / `changing the threshold syncs silently`                                                                                                                                                              |
| 迁移不给历史告警和已低于阈值的租户发邮件         | `packages/db/src/migrate.db.test.ts` / `backfilled alerts and tenants queue no email`；`apps/worker/src/notify.db.test.ts` / `a backfilled open alert recovers without a recovery mail`（PR 4：回填的未恢复旧告警恢复时不入发件箱） |
| SMTP 失败退避、分类、告警与恢复                  | `apps/worker/src/mail.test.ts` / `classifies smtp failures`、`backoff schedule`；`notify.db.test.ts` / `retries with backoff and opens an email_failed alert`、`recovers the smtp alert on the next success`                        |
| 配置校验                                         | `apps/worker/src/config.test.ts` / `requires MAIL_FROM with SMTP_HOST`、`rejects plaintext smtp on a non loopback host`、`qq sender must equal the authenticated user`                                                              |
| 模板：转义、无号码、无换行主题                   | `packages/shared/src/mail/templates.test.ts`                                                                                                                                                                                        |
| 告警设置版本冲突与审计                           | `apps/api/src/admin-system-alerts.db.test.ts` / `alert settings reject a stale version`、`saving settings writes one audit entry`                                                                                                   |
| 网页                                             | `apps/web/e2e/admin-overview.spec.ts`、`admin-system-alerts.spec.ts`（列表、详情、红点、设置、空状态、手机）                                                                                                                        |

## PR 拆分

| PR  | 内容                                                                                                                                                                                     | 依赖    | 文件边界                                                                                                                                                                                                                                                           | 验收与证据                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | 本 PR：设计文档                                                                                                                                                                          | 无      | `docs/phase-9-design.md`                                                                                                                                                                                                                                           | prettier；待用户评审                                                                                                                   |
| 1   | 告警模型与写入点收口：迁移 0020（新列、索引、回填）；`raiseAlert` / `recoverAlert`；10 个写入点改用键；对账告警恢复、无效输入合并与恢复、JSON 损坏规则；`kind` 子类型的 `notify` 策略    | 0       | `packages/db/migrations/0020_*.sql` 与 journal、`packages/db/src/alerts.ts`、`schema.ts`、`apps/worker/src/{ingest,app,maintenance,reconcile,archive,charge}.ts`、`packages/db/src/statements/reconcile.ts`、`apps/api/src/auth/admin-accounts.ts`、DB 测试        | 验收 6、7；`pnpm test:db`、`pnpm test:idor`                                                                                            |
| 2   | 邮件管线：迁移 0021、`email_outbox`、分发与退避、失败分类、`email_failed` 告警、模板、配置与校验、`mail:test` 与 `mail:requeue`、`compose.yaml` 加 Mailpit、CI 环境变量；QQ 账号手工核实 | 1       | `packages/db/migrations/0021_*.sql`、`packages/db/src/outbox.ts`、`packages/shared/src/mail/*`、`apps/worker/src/{mail,config,main,queue}.ts`、`apps/worker/scripts/*`、`compose.yaml`、`.env.example`、`.github/workflows/ci.yml`、`package.json`（`nodemailer`） | Mailpit 收发测试；退避与分类单测；`docs/evidence/phase-9/` 记录 QQ 实测（不含授权码）                                                  |
| 3   | 余额提醒与停机通知：迁移 0023、状态表与触发器、同步函数、模板样张                                                                                                                        | 2       | `packages/db/migrations/0023_*.sql`、`packages/db/src/balance-notices.ts`、`packages/db/src/admin/tenants.ts`（保存设置时同步）、DB 与 Worker 测试                                                                                                                 | 验收 1–3；PORTALBIG 扣费吞吐前后对比                                                                                                   |
| 4   | 故障告警邮件：迁移 0022（`alert_settings`）、`notify-tick`（恢复、开始、汇总、恢复通知）、队列与调度、告警设置读写的库函数                                                               | 1、2    | `packages/db/migrations/0022_*.sql`、`packages/db/src/alert-notify.ts`、`apps/worker/src/notify.ts`、`queue.ts`、`main.ts`、测试                                                                                                                                   | 验收 4；20 分钟场景假时钟与 Mailpit 两种断言                                                                                           |
| 5   | Worker 加固：真实 cron 测试、多实例测试（两个 `PgBoss`）、Worker 日志脱敏、`redact`                                                                                                      | 4       | `apps/worker/src/{cron,multi-instance}.db.test.ts`、`apps/worker/src/{app,redact,main}.ts`、`vitest.db.config.ts`、`docs/development.md`                                                                                                                           | 验收 8、9、10；CI 耗时                                                                                                                 |
| 6   | 契约与 API：概览、告警列表/详情/汇总、告警设置读写；`alertsInWindow`、概览聚合；审计 variants；越权用例                                                                                  | 1、4    | `packages/shared/src/api/admin/{overview,system-alerts}.ts`、`audit.ts`、`errors.ts`、`contract.ts`；`apps/api/src/routes/*`、`packages/db/src/{overview,alert-list}.ts`、`idor.db.test.ts`                                                                        | 验收 5 的 API 测试；经 HTTP 的耗时（概览在 PORTALBIG）                                                                                 |
| 7   | 后台 Web：概览、系统告警页（列表、详情、设置）、导航红点                                                                                                                                 | 6       | `apps/web/src/components/app-shell.tsx`、`pages/home.tsx`、`pages/admin/system-alerts.tsx`、`router.tsx`、`lib/*`                                                                                                                                                  | 组件测试与 e2e 冒烟；设计稿截图初稿                                                                                                    |
| 8   | e2e、视觉对照、种子补充（告警、待收款）、plan 勾选                                                                                                                                       | 3、5、7 | `apps/web/e2e/*`、`packages/db/src/seed*.ts`、`docs/evidence/phase-9*`、`docs/plan.md`、`README.md`                                                                                                                                                                | 全部 e2e；浅色、深色、手机宽度对照与差异清单；plan 阶段 9 逐项勾选并附证据；更正 plan 阶段 9 里已缩小的一项（`plan.md:347`）与总表状态 |

PR 3、PR 4 都只依赖 PR 1、2，可并行；PR 5 依赖 PR 4；PR 6 依赖 PR 1、4，可与 PR 3、5 并行；PR 7 依赖 PR 6。每个 PR 合并前跑 `pnpm check`，涉及数据库的跑 `pnpm test:db`，PR 1、6 加 `pnpm test:idor`。迁移编号按合并顺序重排，并行的 PR 合并时各自重新编号。

## 与其他阶段的依赖

| 阶段              | 关系                                                                                                                                                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段 5 租户设置   | 阈值、通知邮箱沿用现有字段与规则；保存设置时多一次状态同步（PR 3）；邮箱为空的提示文案加一句                                                                                                                                                                                                                               |
| 阶段 7、8         | 月账单核对、归档、分配补扣费都会产生告警；改用统一键后行为不变（阶段 7 的开/更新/恢复语义、阶段 8 的每月一条保持）。阶段 8 的分配补扣费会通过触发器引发余额通知，这是预期行为                                                                                                                                              |
| 阶段 10 部署      | `/etc/fs-billing.env` 增加 `SMTP_*`、`MAIL_FROM`、`APP_PUBLIC_URL`；Debian 13 原生部署不装 Mailpit；服务器出站 465 端口要放行（防火墙清单）；授权码轮换与日志保留 14 天写进运维手册；Worker/数据库整体宕机的外部监测（本阶段发不出邮件的情形）；迁移 0020–0023 在有历史数据的库上演练；多实例结论影响是否部署第二个 Worker |
| 阶段 3 的号码日志 | plan 阶段 10 末项「上线前必须解决阶段 9 的计费号码错误日志 PII 项」由 PR 5 满足                                                                                                                                                                                                                                            |

## 风险

- **QQ 邮箱的限制未知。** 发送频率、每日总量、单封收件人数、垃圾邮件判定都是实测项（[配置](#配置)的 7 点）。若每日上限低，汇总邮件与 `MAIL_RATE_PER_MINUTE` 能缓冲，但一次大规模故障加多租户同时低余额仍可能触顶，`failed` 邮件靠 `mail:requeue` 补发。
- **授权码失效或被撤销。** 所有邮件失败；`email_failed` 只出现在页面和概览，没有邮件通道可用，管理员要看到红点才知道。运维手册要写轮换步骤和检查办法。
- **告警是事后的。** `auth_timeout` 随话单到达，Worker 或数据库整体宕机时没有进程能告警或发邮件（[事件时间的取法](#事件时间的取法)）。外部存活监测属于阶段 10。
- **触发器在扣费热路径上。** 每次余额变化多一次主键读；PR 3 测吞吐，影响大时退到延迟判定（[判定放在哪里](#判定放在哪里tenant_balances-的触发器)）。
- **至少一次发送。** 极少数情况下会收到重复邮件。
- **键的粒度。** `invalid-cdr:<原因>` 与 `unassigned:<原因>` 把不同通话并成一条告警；排查依赖详情页的链接和未归属页的筛选；原因文本变化（阶段 8 的摘要格式）会让旧键与新键并存一条，恢复条件按键各自检查，不会误恢复。
- **停机通知的窗口。** `0 < 可用额度 < 一分钟费用` 时授权已拒绝而不发停机通知（[决定 30](#已决定)）；阈值为 0 的租户在这个窗口里没有任何通知。
- **租户邮件只有中文。** USD 租户（海外客户）收到中文邮件；若要双语是产品问题，本阶段不做。
- **没有解析退信。** 地址存在但邮箱不存在的情形 SMTP 同步不一定拒收，退信回到发件邮箱不被系统看见。
- **触发器与 `rebuild_tenant_balances`。** 重算修正缓存余额也会触发判定，可能发出通知；这是校正动作的副作用，罕见。
- **旧未恢复告警无键。** 迁移后部分旧行 `subject_key` 为空，不参与合并与恢复，会一直显示「进行中」，随时间落出 30 天窗口；若不接受，需要人工 SQL 清理一次。
- **真实 cron 测试增加 CI 时间。** 约 1.5–3 分钟，PR 5 实测后写入证据。
- **多实例结论尚未验证。** 见[多实例](#pg-boss-关闭-advisory-锁与多实例验收-9)；测试结果可能迫使加调度开关或改补丁。
- **plan.md 文字待更正。** 阶段 9 里已被阶段 8 缩小的一项（`plan.md:347`）和总表状态，由 PR 8 随勾选一并更正；本文不改 plan.md。

## 本步验证

2026-10-29 在本机读取了仓库，没有实现代码，没有运行 `pnpm check`，没有运行任何测试，没有连接数据库，没有发送任何邮件。

- **代码事实。** 逐个读了 `apps/worker/src/{queue,main,config,ingest,app,maintenance,reconcile,archive,statements}.ts`、`packages/db/migrations/0000、0013、0015、0017、0018、0019`（告警表、余额缓存触发器、提醒表、RLS、授权撤销）、`packages/db/src/{schema,ledger,tenant-health,usage,client}.ts`、`packages/db/src/statements/reconcile.ts`、`packages/rating/src/authorize.ts`、`packages/shared/src/api/admin/{tenants,receivables,contract}.ts`、`apps/api/src/auth/admin-accounts.ts`、`apps/api/src/logging.ts`、`apps/web` 的导航、路由与首页、`compose.yaml`、`.env.example`、`.github/workflows/ci.yml`、`patches/pg-boss@12.37.1.patch`。文中引用的路径、表名、列名、约束名来自这些文件。
- **pg-boss 源码。** 读了 `pg-boss@12.37.1`（带补丁）`dist` 里的 `plans.js`（`locked`、`tryAdvisoryLock`）、`boss.js`（维护流程）、`timekeeper.js`（`trySetCronTime`、`occurrenceKey`），确认了 `noAdvisoryLocks` 去掉的位置和 cron 去重的机制。**没有**逐行核对取任务的 SQL，也**没有**运行多实例。
- **种子。** 读了 `seed.ts` 的租户、余额、阈值与邮箱，没有查询数据库。种子里没有 `system_alerts`。
- **设计稿。** 读了 `管理后台 第三批 · 运营.dc.html` 的概览、系统告警模板与数据脚本（第 725-760、820-835 行），确认指标卡片、需要关注、告警示例和设置文案；设计稿是带模板的 HTML，没有渲染截图，字段与文案取自模板与脚本源码。
- **未验证。** QQ 邮箱的全部限制（授权码、发件人限制、频率与日额度、收件人上限、垃圾邮件判定、连接行为）；Mailpit 的镜像版本与 HTTP API；`nodemailer` 与 Node 24 的组合；`tenant_balances` 触发器对扣费吞吐的影响；多实例下 pg-boss 维护语句同时执行的行为；真实 cron 测试的耗时；概览聚合在 PORTALBIG 上的耗时；`auth.lookup_user_emails` 在 Worker（系统作用域）下是否可调用（不可调用，PR 4 增加了 `alert_admin_emails()`，见「PR 4 实现时对本章的补充」）；设计稿概览各数字是否与种子一致（部分已核对，见[种子数据核对](#种子数据核对)）。
