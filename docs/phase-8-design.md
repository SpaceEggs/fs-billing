# 阶段 8 设计：话单运维

## 范围与依据

本文档只是设计，没有实现代码，没有迁移，没有向 `liveApiContract` 注册任何端点，也不表示阶段 8 已验收。范围取自 [plan.md 阶段 8](plan.md#阶段-8话单运维)（`docs/plan.md:298-326`），包含两条延后项、四项范围、十条验收标准。

- 延后项 1：管理员重置密码的审计写入失败接入 `system_alerts`，不回滚已提交的凭据与会话撤销（`plan.md:300`）。
- 延后项 2：owner `auth:bootstrap` 创建与替换凭据补写操作审计，记录操作者、目标资料、操作类型与结果，不记录密码、哈希或会话 token（`plan.md:302`）。
- 未归属话单：按标签分组、分配给租户、预览计费金额与无费率条数、分配后补扣费。
- 删除话单：选择租户 + 整月、只能删除已出账月份、输入租户编码二次确认；删除后流水和账单不变。
- 操作日志页面。
- 原始 JSON 超过 6 个月压缩归档与恢复。

业务规则依据 [design.md §4.2、§4.3](design.md#42-呼叫前授权)（`docs/design.md:168-176`）、[§5](design.md#5-计费规则)（计费时间点，`docs/design.md:202`）、[§6.3](design.md#63-生效时间)（费率按接通时刻，不回溯，`docs/design.md:235-248`）、[§13](design.md#13-数据保留)（`docs/design.md:384-414`）、[pages.md](pages.md) §3.6.1 删除话单、§3.9 未归属话单、§3.12 操作日志（`docs/pages.md:272-283、306-317、335-342`），以及设计稿 `design/设计系统规范确认/` 下的 `管理后台 未归属话单原型.dc.html`、`管理后台 删除话单原型.dc.html`、`管理后台 第三批 · 运营.dc.html`（未归属话单第 176-318 行，操作日志第 585-660、775-826 行）、`管理后台 第三批 · 租户详情.dc.html`（删除话单对话框第 402-490、590-605 行）。账本不变量取自 [phase-2-db.md](phase-2-db.md)，Worker 入库与对账取自 [phase-3-worker.md](phase-3-worker.md) 和 `apps/worker/src`，月账单与删除话单预留取自 [phase-7-design.md](phase-7-design.md)（「为阶段 8 预留什么」），CSV、IDOR、合并流水约定取自 [phase-6-design.md](phase-6-design.md)。

plan 把阶段 3 评审遗留项列为 5 条（`plan.md:320-324`：4 条标「来自阶段 3 评审」，1 条标「来自阶段 3 收尾评审」），本文逐条覆盖。

设计稿与文档不一致、文档没有规定的地方，原先列为 14 个待确认问题；用户 2026-10-23 全部回答，均采用推荐项，并确认设计中的默认选择，已写入[已决定](#已决定)第 31 至 44 项并更新相关章节。设计稿的处理见[设计稿与文档的出入](#设计稿与文档的出入)。当前没有待用户确认的问题。

## 现状核对

### 仓库里已经有什么

| 事实                                                                                                                                                                                                                                                                                           | 出处                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unassigned_cdrs` 表已在 0000 建好，状态 `pending / ignored / assigned`，字段有租户标签、原因、时间、主叫被叫、`billing_number`、`assigned_tenant_id`、`resolved_by`、`resolved_at`；0002 起 `call_uuid` 可空并加 `raw_id`、`raw_received_at`；没有任何后台代码读写它                          | `packages/db/migrations/0000_init.sql:546-571`、`0002_worker_reliability.sql:10-30`、`packages/db/src/schema.ts:254-275`                              |
| 入库时哪些话单进未归属：缺少租户标签、租户不存在、接通时无费率、计费号码不一致、号码格式错误、话单校验失败。这些原因共用一张表；`billing_number` 为空当且仅当原因是「号码格式错误」或以「话单校验失败: 」开头                                                                                  | `apps/worker/src/ingest.ts:48-67、91-110、140-166`、`0004_billing_number_not_null.sql`                                                                |
| 未归属登记的 UUID 在 `call_uuids` 里 `tenant_id` 为空；`cdrs` 插入触发器遇到「登记存在且 `tenant_id` 为空」会认领（置租户），除非事务声明 `app.cdr_ingest = true`（HTTP 入库声明，所以重推不会认领）。这是为阶段 8 预留的认领路径，第二次认领因 `tenant_id` 已非空而报 `23505 call_uuids_pkey` | `packages/db/migrations/0000_init.sql:458-476`、`0001_worker_gate.sql:6-22`、`apps/worker/src/ingest.ts:117-125`                                      |
| 入库在同一事务里按接通时刻费率定价并写 `cdrs`，再入队扣费；扣费任务读 `cdrs.rate` 快照，写 `call_charge` 流水（`occurred_at = answered_at`，幂等键 `call:<UUID>`），0 元不写                                                                                                                   | `apps/worker/src/ingest.ts:140-182`、`apps/worker/src/charge.ts:15-50`、`packages/db/src/ledger.ts:35-37`                                             |
| 费率按接通时刻取版本、最长前缀匹配；费率版本生效时间不能早于当前时间，所以不能为过去的通话补费率                                                                                                                                                                                               | `packages/rating/src/rates.ts:23-62`、`docs/design.md:235-248`、`plan.md:122-134`                                                                     |
| 没有「按租户标签分组」「相近租户」「分配」「忽略」的任何 API 或页面；后台导航没有未归属话单和操作日志，话单标签页没有删除按钮                                                                                                                                                                  | `apps/web/src/components/app-shell.tsx:12-26`、`apps/web/src/pages/admin/tenant-tabs/cdrs-tab.tsx:39-40`                                              |
| `cdrs` 按 `started_at` 北京月分区，应用角色有 `DELETE`；`raw_cdrs` 按 `received_at` 北京月分区，应用角色只有 `SELECT, INSERT`，没有 `UPDATE/DELETE`；`raw_cdrs.tenant_id`、`call_uuid` 从未被写入（入库先存原文再解析）                                                                        | `0000_init.sql:427-455、487-499、690-698`、`apps/worker/src/ingest.ts:72-77`                                                                          |
| 6 个月后归档就是「整月分离分区再导出，不在大表上逐行删除」；`jsonb` 不能原样恢复文本，所以原文另存 `body text`，`payload` 由它生成                                                                                                                                                             | `docs/phase-2-db.md:371`、`0000_init.sql:487-495`                                                                                                     |
| 建分区是维护操作：`SECURITY DEFINER` 函数、持租户锁时拒绝、写入路径缺分区报错不建分区                                                                                                                                                                                                          | `0000_init.sql:496-545`、`packages/db/src/partitions.ts:9-20`、`apps/worker/src/maintenance.ts`                                                       |
| `monthly_statements.details_deleted` 与守卫触发器已建：标志只能由假变真，已删除月份禁止改数字和版本；服务层 409 `STATEMENT_DETAILS_DELETED`；前端已按标志置灰「导出话单明细」「重新生成」并显示已删除提示                                                                                      | `0017_monthly_statements.sql:82-125`、`packages/db/src/statements/regenerate.ts:101`、`apps/web/src/pages/portal/statement-detail.tsx:30-67、196-262` |
| 核对任务对话单已删除的月份仍检查期初与期末，不检查明细差额                                                                                                                                                                                                                                     | `phase-7-design.md`「为阶段 8 预留什么」、`packages/db/src/statements/reconcile.ts`                                                                   |
| `operation_logs` 只增、`admin_id` 非空、无列表接口；审计载荷有 `actor / target / content`，`writeAudit` 与业务同事务；操作日志只有主键索引                                                                                                                                                     | `0000_init.sql:605-618`、`packages/db/src/admin/audit.ts`、`packages/shared/src/api/admin/audit.ts:11-118`                                            |
| 运维用只读审计函数 `audit_operation_logs`（给 `fs_billing_audit` 角色）已存在，`JOIN admins`                                                                                                                                                                                                   | `0014_audit_reader.sql:14-40`                                                                                                                         |
| `system_alerts.kind` 目前允许 `auth_timeout`、`cdr_failed`、`email_failed`、`partition_failed`、`statement_mismatch`                                                                                                                                                                           | `0017_monthly_statements.sql:130-134`、`packages/db/src/schema.ts:357-365`                                                                            |
| 管理员没有角色区分，所有 `active` 管理员可操作所有租户                                                                                                                                                                                                                                         | `docs/design.md:351-364`                                                                                                                              |
| `auth:bootstrap` 用 owner 连接直接写 `auth.account`，不经 API；`operation_logs.admin_id` 引用 `admins`，bootstrap 没有可引用的操作者                                                                                                                                                           | `apps/api/src/auth/bootstrap.ts:8-76`、`apps/api/scripts/bootstrap-credential.ts`                                                                     |
| 管理员重置密码：凭据、会话撤销、审计在同一个 `withAdmin` 事务里                                                                                                                                                                                                                                | `apps/api/src/auth/admin-accounts.ts:362-396`                                                                                                         |
| Worker 的队列预建、定时任务模式（父任务扇出、`tz: 'Asia/Shanghai'`、`installQueue` 预建队列）                                                                                                                                                                                                  | `apps/worker/src/queue.ts:17-45、85-120`、`apps/worker/src/statements.ts:288-305`                                                                     |
| 余额类人工操作已有「客户端幂等键 + 同事务审计 + 重放返回原审计」写法                                                                                                                                                                                                                           | `packages/db/src/admin/balance.ts:105-215`                                                                                                            |
| 预览后提交已有先例：`admin_rate_previews`、`PREVIEW_STALE / PREVIEW_EXPIRED`                                                                                                                                                                                                                   | `0011_admin_rate_previews.sql`、`packages/shared/src/api/admin/errors.ts:5-20`                                                                        |

### 种子数据核对（验收标准 1）

2026-10-23 在开发库 `fs_billing` 上只读查询：

- `unassigned_cdrs` 只有 1 行：标签 `ABC01`、原因「租户不存在」、状态 `pending`（`packages/db/src/seed.ts:545-563`，UUID `a00000ff-0000-4000-8000-000000000001`）。验收要的是 **326 条** `ABC01`，其中 324 条能按 ABC001 费率计价、合计 ¥58.35，2 条无费率（前缀 1876）。当前种子远远不够，PR 1 必须扩种子。种子的这一行要么并入 326 条，要么删除，否则 `ABC01` 会是 327 条。2 条无费率话单的构造方式见[决定 37](#已决定)：接通时间早于 ABC001 的第一个费率版本生效时间（8-12 09:30，取 2026-08-05），被叫 `1876…`；其余 324 条接通在 9-29，在版本生效之后。
- 设计稿未归属话单原型的数据（`未归属话单原型.dc.html` 的 `data()`）是 338 条：`ABC01` 326 条（含 2 条无费率，被叫 `18765551234`、`18765559876`）、标签为空 12 条，另有 5 条已忽略（标签 `TEST` 3 条、空 2 条）。324 条合计被调整为恰好 ¥58.35（5835 分）。种子应按同一形状生成确定性数据，使预览数字与设计稿一致。
- ABC001 的费率表（`RATES_CSV`，`packages/db/src/seed.ts:171-180`）**含** `1876`（牙买加 0.2500）**也含** `1`（美国/加拿大 0.0100），且 8-12 开户起生效；9 月的牙买加话单已用到它（`packages/db/src/seed-calls.ts:53-57`）。见[设计稿与文档的出入](#设计稿与文档的出入)第 1 条：这使「2 条无费率（前缀 1876）」在现有费率表下无法靠删前缀产生，所以用户 2026-10-23 决定改用接通早于费率生效的构造（[决定 37](#已决定)），不改费率表。
- ABC001 余额 −35.200，`monthly_statements` 8、9 月都是 `reconcile_status = 'unchecked'`（核对任务尚未跑过），`details_deleted` 为假。「删除 8 月话单」的前置条件见[删除话单](#删除话单)。
- `raw_cdrs` 为空，存在分区 `raw_cdrs_2026_08` 至 `raw_cdrs_2026_11`；当前日期 2026-10-23 下没有任何分区满足「超过 6 个月」，所以归档验收必须在测试里造老分区（`ensureCdrPartitions` 接受任意 `moment`）。

### 设计稿与文档的出入

| #   | 出入                                                                                                                                                                                                                                                                                                                                                         | 本设计的处理                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1   | 设计稿说「2 条被叫前缀 1876（牙买加）在 ABC001 费率表中已删除……如需归属，请先在费率表补充该前缀」（`运营.dc.html:293`）。但 (a) 最长前缀匹配下，删掉 `1876` 后 `18765551234` 会落到前缀 `1`（0.0100），不是「无费率」；(b) 费率按接通时刻取版本且不能回溯生效（`design.md:235-238`），事后补前缀不会让已发生的话单有费率。设计稿的叙事与计费规则不能同时成立 | 决定 36、37：无费率话单保持规则，留在待处理，文案按规则改写；种子用接通早于费率生效构造 2 条         |
| 2   | 设计稿删除话单原型里 ABC001 在 9-29 有牙买加话单（费率 0.25），未归属原型里同一天的 1876 却无费率。两份原型是独立演示，数据互不一致                                                                                                                                                                                                                          | 不处理，记录                                                                                         |
| 3   | 设计稿的时间线停在 2026-09-29（9 月进行中），文案说话单会「出现在该租户的话单和当月账单中」。仓库的当前日期是 2026-10-23，9 月已出账；其中 324 条可分配的话单（接通在 9-29）补扣费会落在已出账的 9 月，使 ABC001 的 9 月账单变为 `stale`（−35.20 → −93.55 的差额不在账单里）。这正是阶段 7 预期的「迟到流水」（`phase-7-design.md` 与阶段 8 依赖表）         | 已决定第 6 项；预览和结果里列出受影响的月份                                                          |
| 4   | 设计稿未归属话单页的说明是「租户标签缺失，或找不到对应租户」，表里没有原因列。实际这张表还装着「接通时无费率」「计费号码不一致」「号码格式错误」「话单校验失败」                                                                                                                                                                                             | 表加「原因」列（设计稿没有），哪些原因可分配见决定 35                                                |
| 5   | plan 范围只写「分配给租户」，pages.md §3.9 与设计稿还有「忽略（需填原因）」「已忽略标签页」「撤销忽略」，并说忽略和撤销都记操作日志                                                                                                                                                                                                                          | 纳入本阶段（已决定第 7 项）。不做则无法清掉测试呼叫、校验失败和无费率的话单                          |
| 6   | 租户详情话单标签页的设计稿（`租户详情.dc.html`）是日期范围筛选，删除话单原型里是「2026年9月 / 2026年8月」月份切换，已删除后显示「2026年8月 的话单已删除 · 共 9,642 条 · 王敏 删除于 …」                                                                                                                                                                      | 采用实际页面的日期范围；范围内含已删除月份时在列表上方显示同样内容的提示条（已决定第 12 项）         |
| 7   | 删除话单原型里 9 月话单是 13,517 条，月账单通话数是 12,804（阶段 7 已记）；8 月两者都是 9,642，是因为 8 月没有未接通话单                                                                                                                                                                                                                                     | 删除预览的条数按「该月所有话单」数（含未接通），和账单通话数口径不同，页面文案写「话单」不写「通话」 |
| 8   | 操作日志设计稿的「操作」是中文标签（归属话单、删除话单、修改费率、修改设置……），现有审计 `action` 是英文枚举（`rate_entry_edit` 等），一个标签可能对应多个枚举                                                                                                                                                                                               | 页面和筛选用标签，服务端按标签展开成枚举集合，见[操作日志](#操作日志)                                |
| 9   | plan 把「删除当月话单的按钮不可用」放在验收里，设计稿的删除按钮在输入编码前一直不可用，月份格里当月置灰                                                                                                                                                                                                                                                      | 两处都做：月份格里不可选；服务端 409                                                                 |
| 10  | plan 延后项 1 的前提是「重置密码提交成功后审计写入失败」。当前代码（#22 起）凭据、会话撤销与审计在同一事务，审计失败整体回滚，没有「已提交而无审计」的窗口                                                                                                                                                                                                   | 决定 40：保持原子，加回归测试与告警；plan 文字作为后续更正                                           |
| 11  | plan 的阶段 9 验收里有「通用无效输入每次重推仍重复写告警」（`plan.md:347`），与本阶段验收「无 UUID 校验失败话单每次重推都新建 pending 行」落在同一段代码、同一个事务                                                                                                                                                                                         | 决定 42：本阶段对同一原文再次推送不再写告警，阶段 9 的同名一项缩小                                   |

## 未归属话单

### 数据模型与迁移

迁移文件 `packages/db/migrations/0018_cdr_operations.sql`（编号以合并时为准），随 PR 1。上线前开发库可以直接改；`unassigned_cdrs` 没有生产数据。

`unassigned_cdrs` 加列：

| 列                        | 类型与约束                               | 用途                                                                                                                         |
| ------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `hangup_cause`            | `text NOT NULL DEFAULT ''`               | 分配时要写进 `cdrs.hangup_cause`。现在 `park()` 把整个解析结果传给 `insert`，但表里没有这两列，值被丢弃（`ingest.ts:48-56`） |
| `unverified`              | `boolean NOT NULL DEFAULT false`         | 同上，`cdrs.unverified`（后台「未经验证」标签）                                                                              |
| `raw_sha256`              | `text`                                   | 无效推送去重键：原文 UTF-8 字节的 SHA-256 十六进制                                                                           |
| `push_count`              | `integer NOT NULL DEFAULT 1`             | 同一原文被推送的次数                                                                                                         |
| `last_pushed_at`          | `timestamptz`                            | 最近一次推送时间                                                                                                             |
| `candidate_call_uuid`     | `uuid`                                   | 校验失败的原文里尽力解析出的 `variables.uuid`（语法合法才存），用于重推成功后对上旧行                                        |
| `superseded_by_call_uuid` | `uuid`                                   | 状态 `superseded` 时，修正重推成功的通话 UUID                                                                                |
| `assignment_id`           | `uuid REFERENCES unassigned_assignments` | 状态 `assigned` 时所属的分配批次                                                                                             |

状态约束：`unassigned_cdrs_status_check` 与 `unassigned_cdrs_status_shape` 改写，加第四个状态 `superseded`（系统自动解决：`resolved_at` 非空、`resolved_by` 为空、`superseded_by_call_uuid` 非空，其余同 `pending` 的空值要求）。约束名取自开发库实际名称（本步验证已核对）。

索引：`unassigned_cdrs_status_tag (status, tenant_tag)`（分组与筛选）、`unassigned_cdrs_status_time (status, (coalesce(answered_at, started_at)) DESC, id)`（设计稿「接通时间 ↓」）、局部唯一索引 `unassigned_cdrs_invalid_body (raw_sha256) WHERE call_uuid IS NULL AND status IN ('pending', 'ignored')`（见[无 UUID 无效推送去重](#无-uuid-无效推送去重)）。

新表 `unassigned_assignments`（分配批次，只增）：

| 列                                                 | 类型与约束                                           | 用途                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `id`                                               | `uuid PRIMARY KEY DEFAULT gen_random_uuid()`         |                                                                                       |
| `tenant_id`                                        | `uuid NOT NULL REFERENCES tenants`                   | 目标租户                                                                              |
| `idempotency_key`                                  | `text NOT NULL CHECK (btrim(idempotency_key) <> '')` | 客户端幂等键                                                                          |
| `requested_by`                                     | `uuid NOT NULL REFERENCES admins`                    | 操作人                                                                                |
| `source_tag`                                       | `text`                                               | 按分组选择时的标签，按勾选时为空                                                      |
| `assigned_count`、`no_rate_count`、`blocked_count` | `integer NOT NULL CHECK (>= 0)`                      | 本批结果                                                                              |
| `charge_total`                                     | `numeric NOT NULL CHECK (charge_total >= 0)`         | 本批扣费合计（租户币种）                                                              |
| `balance_before`、`balance_after`                  | `numeric NOT NULL`                                   | 设计稿「−35.20 → −93.55」                                                             |
| `affected_months`                                  | `date[] NOT NULL`                                    | 扣费落入的北京月                                                                      |
| `audit_id`                                         | `uuid NOT NULL`                                      | 同事务写入的操作日志 id                                                               |
| `request_digest`                                   | `text NOT NULL`                                      | 请求（选择与预览数字）的 SHA-256；同键重放时核对是同一个请求（PR 1 加，原先没有列出） |
| `created_at`                                       | `timestamptz NOT NULL DEFAULT now()`                 |                                                                                       |
| 唯一约束                                           | `UNIQUE (tenant_id, idempotency_key)`                | 请求级幂等                                                                            |

RLS 同 `unassigned_cdrs`（`staff_only`，`app_is_operator()`，`0000_init.sql:680-688`），应用角色 `SELECT, INSERT`，`reject_mutation()` 触发器拒绝 `UPDATE/DELETE/TRUNCATE`。

### 分组与列表

- `GET /api/admin/unassigned-cdrs/groups`：待处理话单按 `tenant_tag` 分组，每组 `tag`（空串表示标签为空）、`count`、`reasons`（该组出现的原因及条数）、`suggestedTenants`（标签与租户编码的编辑距离 ≤ 1，忽略大小写，在 TypeScript 里算，租户数很小；设计稿「疑似拼写错误，相近：ABC001」）。组按条数降序，另有「全部」。
- `GET /api/admin/unassigned-cdrs`：query `status`（`pending` 默认、`ignored`）、`tag`（可选）、`page`、`pageSize`（沿用 `adminPageQuerySchema`，默认 25，页面请求 50）。行字段：接通时间（`coalesce(answered_at, started_at)`）、标签、主叫、被叫（`callee` 原始拨号）、通话时长、原因；已忽略多：忽略原因、操作人、时间。不返回 `call_uuid` 以外的内部列；没有 `call_uuid` 的行（校验失败）标记 `assignable: false`。
- `GET /api/admin/unassigned-cdrs/summary`：`pending`、`ignored` 条数，供导航角标和页签（设计稿导航上的 `338`）。

### 预览

`POST /api/admin/unassigned-cdrs/assign-preview`，body `{ tenantId, selection }`。`selection` 是 `{ ids: uuid[] }`（勾选，上限 1000）或 `{ group: { tag } }`（「选择该分组全部」，服务端在请求时点解析，不要求客户端发全部 id）。

服务端在 `withAdmin` 里，不拿租户锁，只读：

1. 取选中的 `pending` 行；`call_uuid IS NULL` 的、`billing_number IS NULL` 的，以及原因是「计费号码不一致」「号码格式错误」「话单校验失败」的，归入「不可分配」（决定 35：可分配的原因只有「租户不存在」「缺少租户标签」「接通时无费率」，其余只能忽略；列表的「原因」列标明不可分配）。
2. 用 `loadRatingTenant(tx, tenant.code)` 读目标租户费率，对每行按 `answered_at` 找费率（`findRate`）与定价（`priceCall`），和入库用的是同一套函数（已决定第 1 项）。未接通话单（`answered_at` 为空）不收费，可分配，费用 0。
3. 无费率的行统计条数，并给出解释：`before_first_version`（接通早于租户第一个费率版本的生效时间）或 `prefix_not_in_version`；`prefixHint` 取租户**任一**费率版本里与该号码最长前缀匹配的条目（前缀、国家），没有则为空。预览显示的「前缀 1876」来自这里（决定 37）。

   **无费率话单的处理与文案（决定 36）。** 规则不变：无费率的话单留在待处理，只能忽略（填原因），欠费由管理员用「调账」在当前月补记；不提供按当前费率计价的开关，也不提供手工单价。设计稿那句「请先在费率表补充该前缀」与计费规则冲突（补前缀不能回溯），改为：`before_first_version` 显示「接通时（2026-08-05）ABC001 还没有生效的费率，第一个费率版本自 2026-08-12 09:30 起生效。费率按接通时刻计价，不能回溯，这 N 条不能分配，会留在待处理；可以忽略并填写原因，需要补收的费用请用『调账』在当前月补记。」；`prefix_not_in_version` 显示「接通时 ABC001 的费率表里没有匹配的前缀（最接近：1876 牙买加）。……」，后半句同上。日期与前缀取自 `noRate.groups`。

4. 接通月份已 `details_deleted` 的行归入「月份已冻结」，不可分配（决定 38）。
5. 返回：`selected`、`assignable`、`chargeTotal`、`currency`、`noRate { count, groups[{ reason, prefixHint, samples[≤3] }] }`、`blocked { count, months[] }`、`notAssignable { count, reasons[] }`、`balance { current, afterEstimate }`、`affectedMonths[{ month, statementState }]`（`statementState` 为 `final / live / none`，`final` 表示该月已有账单、补扣费后会过期）。

预览不落库。设计稿的预览三格是「实际归属 / 扣费合计 / 匹配不到费率」，对应 `assignable / chargeTotal / noRate.count`。`afterEstimate` 只是展示，提交时以事务内的实算为准。

### 分配（事务、幂等、并发）

`POST /api/admin/unassigned-cdrs/assign`，body `{ tenantId, selection, idempotencyKey, expected: { assignable, noRate, chargeTotal } }`。入口在 API 进程，不经 pg-boss（API 没有队列依赖，`grep pg-boss` 只在 `apps/worker`）。扣费与入库在同一个事务，对话框确认后余额立即变化。

为复用，PR 1 把两段逻辑从 Worker 抽到 `packages/db`：

- `priceAndInsertCdr(tx, tenant, cdr)`：`ingest.ts:140-182` 的「按接通时刻找费率、定价、写 `cdrs`」。Worker 与分配共用。
- `chargeCall(tx, { tenantId, callUuid })`：`charge.ts:15-50` 的读 `cdrs` 快照、写 `call_charge` 流水。Worker 的扣费任务与分配共用。

提交的事务（`withAdmin`，默认隔离级别，读已提交）：

1. `lockTenants(tx, [tenantId])`。流水触发器要求持租户锁（`ledger_entries_require_tenant_lock`，`0000_init.sql:293-300`）。
2. **请求级幂等。** 查 `unassigned_assignments (tenant_id, idempotency_key)`。已存在：校验是否同一操作人、同一选择（`selection` 摘要与 `expected`），一致返回原结果并带 `replayed: true`，不一致 409 `IDEMPOTENCY_CONFLICT`。写法同 `operateBalance`（`packages/db/src/admin/balance.ts:120-160`）。
3. **行级互斥。** 按 `selection` 取行：`SELECT … FROM unassigned_cdrs WHERE status = 'pending' AND … ORDER BY started_at, id FOR UPDATE`。并发的第二个请求在行锁上等待，第一个提交后重新计算条件，行已是 `assigned`，查不到，不会重复处理。
4. 对每个可分配行：`priceAndInsertCdr` 写 `cdrs`（`app.cdr_ingest` 未声明，登记触发器认领 `call_uuids` 行，`tenant_id` 由空变租户）；`UPDATE unassigned_cdrs SET status = 'assigned', assigned_tenant_id, resolved_by, resolved_at, assignment_id`；`chargeCall` 写流水（幂等键 `call:<UUID>`，`occurred_at = answered_at`）。无费率、月份冻结、不可分配的行不动，保持 `pending`。
5. 实算的 `assignable`、`noRate`、`chargeTotal` 与请求的 `expected` 不符：抛 409 `UNASSIGNED_PREVIEW_STALE`，整个事务回滚（预览之后又有新话单进组、或费率被改）。UI 重新预览。
6. 写 `unassigned_assignments`、写操作日志 `unassigned_assign`（同事务），返回结果。

**重复提交只扣费一次**，由四层保证，任何一层单独都足够：

| 层                | 机制                                                                          | 重复提交时                                       |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| 请求幂等键        | `UNIQUE (tenant_id, idempotency_key)`                                         | 同键重放，返回原结果，不执行                     |
| 行状态 + 行锁     | `status = 'pending'` 加 `FOR UPDATE`                                          | 已 `assigned` 的行不再被选中，影响 0 行          |
| `call_uuids` 认领 | 触发器只认领 `tenant_id IS NULL` 的登记（`0001_worker_gate.sql:11-14`）       | 第二次认领 `23505 call_uuids_pkey`，事务失败回滚 |
| 流水幂等键        | `UNIQUE (tenant_id, idempotency_key)` 加 `call:<UUID>`（`0000_init.sql:262`） | 重复键返回已有流水，不新增                       |

另一个键不同、选择相同的请求，在行状态这层得到 0 条可分配，返回 409 `UNASSIGNED_NOTHING_TO_ASSIGN`（不写批次、不写日志）。

**批量上限。** 单次最多 2000 条（`ASSIGN_MAX_ROWS`），超过返回 400 并提示分批。PR 1 在 PORTALBIG 克隆库上实测（[evidence](evidence/phase-8/README.md)）：约 2.2 ms/行，2000 条持租户锁约 4.4 s，5000 条约 10.4 s；FreeSWITCH 的 `json_cdr` 推送超时是 5 秒，持锁超过它，该租户的话单推送会超时重试，所以取 2000（原先的占位值是 5000）。一个事务持租户锁期间，该租户的扣费任务和人工余额操作排队等待，不丢；授权读余额缓存，不等这把锁（PR 1 已用测试验证：持锁并已改过余额缓存行的事务不会挡住授权读）。

**分区。** `cdrs` 的分区只由维护任务建（`0000_init.sql:496-545`），而未归属话单可能比现有分区更老。分配事务之前，另起事务对选中行涉及的每个北京月调用 `ensureCdrPartitions(pool, { moment, monthsAhead: 0 })`，再开分配事务（建分区在持租户锁时被拒绝，所以必须在前）。API 的 `businessDb` 是否满足 `PoolDb` 类型，PR 1 核对。

**不触发账单自动重新生成。** 补扣费落在已出账月份，该月账单 `stale`，核对任务按阶段 7 的 `statement_mismatch` 开告警（已决定第 6 项）。响应的 `affectedMonths` 带月份和状态，页面提示「前往账单页重新生成」。

### 忽略与撤销忽略

- `POST /api/admin/unassigned-cdrs/ignore`，body `{ selection, reason }`（`reason` 去空白后非空、≤ 2000 字）。`pending → ignored`，写 `ignore_reason`、`resolved_by`、`resolved_at`，写操作日志 `unassigned_ignore`。设计稿的快捷原因「测试呼叫 / 内部线路 / 重复话单」是前端预填。
- `POST /api/admin/unassigned-cdrs/unignore`，body `{ selection }`。`ignored → pending`，清空忽略字段，写操作日志 `unassigned_unignore`。
- 没有 `call_uuid` 的校验失败行、无费率行都可以忽略（状态约束不限制）。已 `assigned` 的行不能撤销（不在 plan 范围，见风险）。
- 都只更新行，不动流水。重复提交幂等：`WHERE status = 'pending'` 影响 0 行时返回 `changed: 0`，不写日志。

## 删除话单

### 数据与迁移

`monthly_statements` 加三列（同迁移 0018）：

| 列                      | 类型与约束               | 用途                                  |
| ----------------------- | ------------------------ | ------------------------------------- |
| `details_deleted_at`    | `timestamptz`            | 删除时间（数据库时钟）                |
| `details_deleted_by`    | `uuid REFERENCES admins` | 操作人                                |
| `details_deleted_count` | `integer CHECK (>= 0)`   | 该月删除条数（设计稿「共 9,642 条」） |

约束：三列同为空或同非空；非空时 `details_deleted` 必须为真。**允许标志为真而三列为空**（阶段 7 的 e2e 辅助 `setStatementFlags` 直接置标志，`apps/web/e2e/db.ts:361-377`），此时页面显示「话单已删除」而不显示人和时间。`monthly_statements_guard` 触发器（`0017:87-123`）扩充：三列只能在 `details_deleted` 由假变真的同一条 `UPDATE` 里写入，之后不可改。

不新建 `cdr_deletions` 表：阶段 7 已把「在删除话单的同一事务里把覆盖月份的 `details_deleted` 置真」作为接口预留，删除元数据放在同一行，单一事实来源。

### 月份可选规则

`GET /api/admin/tenants/{tenantId}/cdr-deletions?year=2026` 返回 12 个月的状态，设计稿月份格的子标签即各状态的文案：

| 状态             | 判定                                                                                                                                                           | 设计稿子标签 / 提示                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `deletable`      | 该月有账单行、`details_deleted = false`、月份已结束、`reconcile_status = 'ok'` 且没有「有费用而无流水」的话单（决定 39）                                       | 「9,642 条」（`cdrCount`）                       |
| `deleted`        | `details_deleted = true`                                                                                                                                       | 「已删除」「该月话单已删除」                     |
| `no_statement`   | 月份已结束但没有账单行（1 日 00:00–02:00 的间隙、或生成失败），或是当前月                                                                                      | 「账单未生成」「本月账单尚未生成，不可选」       |
| `before_opening` | 早于第一个应有账单的月份（创建月与最早流水所在月中较早者，和账单生成任务的 `firstStatementMonth` 一致；PR 1 实现时对齐，PORTALBIG 夹具的流水早于租户创建时间） | 「未开户」                                       |
| `future`         | 晚于当前北京月                                                                                                                                                 | 「尚未到达」                                     |
| `blocked`        | 有账单但决定 39 的前置条件不满足（核对不是 `ok`、有未扣费话单）                                                                                                | 设计稿没有；「账单待重新生成」「有话单尚未扣费」 |

`cdrCount` 用与话单列表、导出相同的月份谓词（`packages/db/src/cdr-query.ts:20-39`）：`coalesce(answered_at, started_at)` 落在北京月 `[lo, hi)`，并带 `started_at >= lo - interval '31 days' AND started_at < hi` 的分区剪枝下界（振铃不超过 31 天的假设沿用阶段 6，`phase-6-design.md:169`）。一通 8-31 23:59:50 振铃、9-01 00:00:05 接通的电话在 `cdrs_2026_08` 分区里，但属于 9 月：它随 9 月被删，不随 8 月（和账单按 `answered_at` 归属一致）。

删除预览的时间范围文案「2026-08-12 00:00:00 至 2026-08-31 23:59:59（北京时间）」：起点取 `max(月初, 租户创建日 00:00)`，终点取月末，只是展示；删除谓词是整个北京月。

### 删除事务

`POST /api/admin/tenants/{tenantId}/cdr-deletions`，body `{ fromMonth, toMonth, tenantCode, expectedCount }`。设计稿是开始月份、结束月份两个选择器，输入框内容必须等于租户编码（区分大小写）才可点，按钮标签是「删除 N 条话单」。

1. 校验 `tenantCode` 与 `tenants.code` 完全相等，否则 400 `VALIDATION_ERROR`（编码来自数据库，不信任页面）。
2. 展开 `[fromMonth, toMonth]` 的每个月。先在**只读**事务里对所有月份做一遍资格检查，任一月份不是 `deletable` 就整个请求 409 `CDR_MONTH_NOT_DELETABLE`，一条都不删。当前月、无账单月、已删除月都在此被拒（验收：删除当月话单的按钮不可用，服务端同样不允许）。
3. `expectedCount` 与所有月份 `cdrCount` 之和不符：409 `CDR_DELETE_COUNT_CHANGED`（预览之后又有话单进来、或另一管理员已删），页面重新预览。
4. **按月一个事务**（升序，决定 44）：`withAdmin` → `lockTenants(tx, [tenantId])` → 在锁内重新检查该月资格（含核对状态与未扣费话单）和条数 → 删除：

   ```sql
   WITH gone AS (
     DELETE FROM cdrs c
     WHERE c.tenant_id = $tenant
       AND coalesce(c.answered_at, c.started_at) >= $lo AND coalesce(c.answered_at, c.started_at) < $hi
       AND c.started_at >= $lo - interval '31 days' AND c.started_at < $hi
     RETURNING 1)
   SELECT count(*) FROM gone
   ```

   → `UPDATE monthly_statements SET details_deleted = true, details_deleted_at = now(), details_deleted_by = $admin, details_deleted_count = $n WHERE tenant_id = $tenant AND month = $month AND NOT details_deleted` → 写操作日志 `cdr_delete`（一个月一条）。三步同事务，所以「话单没了但标志没置」或相反的状态不会提交。这是阶段 7 风险「阶段 8 漏置 `details_deleted`」的对策，验收要断言同事务（见[验收映射](#验收标准对应计划测试)）。

5. 响应：每个月 `{ month, deleted, statementId, auditId }` 与合计。月份之间不原子：基础设施故障发生在中途时，已完成的月份保留，响应与页面列出已删和未删的月份，重试只处理剩余月份。一个月可能几十万行，一个事务删多个月会长时间持租户锁，所以不做全有或全无。

租户锁与 Worker 的扣费、入库共用，所以删除期间该租户的新话单入库排队，不会插入「正在被删除的月份」。

### 删除后流水和账单为什么不变

| 对象                                | 为什么不变                                                                                                                                                    | 验证                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `ledger_entries`、`tenant_balances` | 删除语句只碰 `cdrs`；流水与话单之间没有外键，靠幂等键 `call:<UUID>` 关联；流水只增，数据库拒绝 `UPDATE/DELETE`（`0000_init.sql:274-278`）                     | 测试对比删除前后该租户全部流水的 id/金额/时间哈希与余额 |
| 账单头部与明细                      | 头部与国家、日明细都存成行，不依赖话单；守卫触发器拒绝已删除月份的数字、版本变更（`0017_monthly_statements.sql:98-110`）；`breakdown_gap` 不重算              | 测试对比头部全部列（除新三列）、国家表、日表            |
| `call_uuids`                        | **保留**。同一 UUID 的话单被重推，入库判为 `duplicate`，不会重新写 `cdrs`、不会重复扣费（`ingest.ts:126-131`）                                                | 测试：删除后重推已删话单，`cdrs` 与流水数不变           |
| 核对任务                            | 对已删除月份仍检查期初与期末，不检查明细差额；删除后应保持 `ok`                                                                                               | 测试：删除后跑 `reconcileStatements`，状态不变          |
| 对账补投                            | `reconcileCharges` 只扫 `cdrs`（`reconcile.ts:25-33`），被删的行不存在，不会补投；存在「有费用未扣费」话单时拒绝删除（决定 39），所以不会因删除丢掉待扣的费用 | 测试：存在未扣费话单时 409                              |

**原始 JSON 不随删除话单清除（决定 34）。** 删除话单只删 `cdrs`（`design.md` 说的「整理后的话单」），`raw_cdrs` 的原文按归档策略自然老化。原因：`raw_cdrs.tenant_id`、`call_uuid` 从未写入，原文和租户之间没有可查询的关联；应用角色也没有 `DELETE` 权限；归档后的文件更无法选择性清除。删除话单的对话框说明和 `cdr_delete` 的操作日志摘要里写明这一点。入库不为此新增 `tenant_id/call_uuid` 的写入。

### 迟到话单遇到已删除的月份

删除之后，FreeSWITCH 重推属于该月的**新**话单（UUID 未登记），或分配把接通在该月的未归属话单补进来，会写出 `occurred_at` 落在该月的流水，使冻结的账单与账本不一致，且不可重新生成。用户 2026-10-23 决定拦下（决定 38）：

- **入库。** 该租户该月账单 `details_deleted` 为真时，话单不定价扣费，停放到 `unassigned_cdrs`（原因「所属月份话单已删除」，`call_uuid` 与 `billing_number` 照常保存），同时写 `cdr_failed` 告警。检查放在 PR 1 抽出的共享入库函数里，Worker 与分配共用。删除持租户锁，扣费任务持租户锁，所以扣费前（`chargeCall`）在锁内也要复核一次标志，避免入库后、扣费前月份被删的窗口（未在本步验证，PR 1 补测试）。
- **分配。** 接通在已删除月份的行归入「月份已冻结」，不可分配（见[预览](#预览)），保持 `pending`。
- **出路。** 管理员可忽略（填原因），或用调账在当前月补记。这类话单极少，值得人工看；理由是保住「账目始终对得上」（`design.md:402`）。

## 操作日志

### 新增 action 与审计内容

`packages/shared/src/api/admin/audit.ts` 新增（沿用 `auditVariant` 与 `summary / changes` 内容结构）：

| action                 | target（`kind` → `id`）                | 内容字段                                                                                                                       | 页面「操作」标签 |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `unassigned_assign`    | `unassigned_batch` → 分配批次 id       | `sourceTag`、`assignedCount`、`noRateCount`、`blockedCount`、`chargeTotal`、`currency`、`affectedMonths`；`changes` 含余额前后 | 归属话单         |
| `unassigned_ignore`    | `unassigned_batch` → 本条审计自身的 id | `count`、`reason`、`sourceTag`                                                                                                 | 忽略话单         |
| `unassigned_unignore`  | 同上                                   | `count`                                                                                                                        | 撤销忽略         |
| `cdr_delete`           | `statement` → 账单头部 id              | `month`、`deletedCount`、`range { from, to }`、`confirmedCode`；`changes` 含删除条数 N → 0                                     | 删除话单         |
| `credential_bootstrap` | `admin` 或 `portal_account` → 资料 id  | `mode`（`create / replace`）、`result`（`succeeded / rejected / failed`）、`errorCode`、`revokedSessions`                      | 初始化凭据       |

批量操作没有单一对象，`target.id` 取批次 id；忽略没有批次表，取审计自身的 id。`auditChangeSchema.field` 的枚举（`audit.ts:37-52`）加 `balance`、`callCount`，页面据此画「字段 / 修改前 / 修改后」三列（设计稿 `运营.dc.html:792-797`：归属 324 条、扣费 ¥58.35、余额 −¥35.20 → −¥93.55；删除 9,642 条 → 0 条）。`target.kind` 枚举加 `unassigned_batch`。恢复原始话单是只读取回，不写操作日志（决定 33），所以没有 `raw_cdr` 对象。

凭据类审计**不含**密码、哈希、会话 token：`credential_bootstrap` 的内容字段里没有这些，schema 是 strict，另有测试断言 `details` 序列化后不含 `password`、`hash`、`token` 字样。

### 列表端点与索引

`GET /api/admin/audit-logs`，query：`from`、`to`（北京日，默认最近 30 天，设计稿「2026-08-31 — 09-29」）、`adminId`、`label`（操作标签，服务端展开为 action 集合）、`tenantId`、`page`、`pageSize`（设计稿 50 条一页，「共 214 条 · 第 1–50 条」）。排序 `created_at DESC, id`。行：时间、管理员（名称；无管理员时显示 `actor_label`）、操作标签、对象（租户编码或对象说明）、摘要；展开后返回 `changes` 与元信息「操作人 · 时间 · 只读记录」。只读：没有任何修改、删除操作；表本身由触发器拒绝（`0000_init.sql:615-618`）。

迁移 0018 加索引：`operation_logs_created (created_at DESC, id)`、`operation_logs_tenant_created (tenant_id, created_at DESC)`、`operation_logs_action_created (action, created_at DESC)`；现在除主键外没有索引（本步验证已核对）。开发库里 `operation_logs` 约 490 行（含测试产生的），量小，索引是为上线后的增长。

操作标签与 action 的对应（页面筛选与展示）：

| 标签                   | action                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新建租户               | `tenant_create`                                                                                                                                                       |
| 修改租户 / 设置        | `tenant_edit`、`tenant_settings_update`、`tenant_disable`、`tenant_enable`                                                                                            |
| 充值 / 赠送 / 调账     | `balance_topup`、`balance_credit_topup`、`balance_gift`、`balance_adjustment`                                                                                         |
| 修改费率 / 导入 / 复制 | `rate_entry_edit`、`rate_import`、`rate_export`、`rate_copy`、`rate_schedule_cancel`                                                                                  |
| 收款                   | `receivable_confirm`、`receivable_void`、`receivable_payment_reverse`                                                                                                 |
| 账号                   | `portal_account_create`、`portal_account_disable`、`portal_account_enable`、`reset_password`、`admin_create`、`admin_disable`、`admin_enable`、`credential_bootstrap` |
| 导出                   | `cdr_export`                                                                                                                                                          |
| 重新生成账单           | `statement_regenerate`                                                                                                                                                |
| 归属话单               | `unassigned_assign`                                                                                                                                                   |
| 忽略话单               | `unassigned_ignore`、`unassigned_unignore`                                                                                                                            |
| 删除话单               | `cdr_delete`                                                                                                                                                          |

设计稿的标签是示意，粒度（合并或拆分）是展示问题，PR 5 对着设计稿截图定；服务端以 action 集合为准。

### 页面

`/admin/audit-logs`（导航「操作日志」）：四个筛选（日期范围、管理员、操作类型、租户）加「重置」「共 N 条」，表格列时间、管理员、操作（色标：删除话单红、调账赊账橙、其余蓝，设计稿 `opTone`）、对象、详情；点行展开修改前后；手机端卡片。空结果显示「没有符合条件的操作记录」和当前筛选摘要、「清除筛选」。筛选写入地址参数，非法值单独丢弃（同 `lib/admin-search.ts`）。日志本身的访问不再记日志。范围（决定 43）：按 pages.md 与设计稿，只有这四个筛选、50 条一页、只读，不做导出，不设保留期（永久保留，`operation_logs` 只增，数据量大了再考虑按月分区）；归档、对账等后台任务的结果不进操作日志（它们有自己的清单与告警），`credential_bootstrap` 这类带 `actor_label` 的事件进。

## 原始 JSON 归档与恢复

### 数据模型

迁移 `packages/db/migrations/0019_raw_cdr_archives.sql`，随 PR 3。

`raw_cdr_archives`（每个月一行，状态机推进）：

| 列                                                                      | 类型与约束                                                                                  | 用途                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `month`                                                                 | `date PRIMARY KEY CHECK (extract(day FROM month) = 1)`                                      | `received_at` 的北京月，对应分区 `raw_cdrs_YYYY_MM`                                                             |
| `state`                                                                 | `text NOT NULL CHECK (state IN ('exporting', 'verified', 'detached', 'dropped', 'failed'))` | 见下节                                                                                                          |
| `file_key`                                                              | `text`                                                                                      | 相对存储根的路径，如 `raw-cdrs/2026/raw-cdrs-2026-03.jsonl.gz`                                                  |
| `rows`、`body_bytes`、`file_bytes`                                      | `bigint`                                                                                    | 行数、原文总字节（UTF-8）、压缩后字节                                                                           |
| `file_sha256`、`rows_digest`                                            | `text`                                                                                      | 压缩文件整体哈希；按顺序拼接的逐行 SHA-256 再取 SHA-256                                                         |
| `db_fingerprint`                                                        | `jsonb`                                                                                     | 导出时分区的 `count`、`sum(octet_length(body))`、`bit_xor(hashtextextended(id::text \|\| body, 0))`，分离前复核 |
| `chunks`                                                                | `jsonb`                                                                                     | `[{ offset, length, sha256, rows, firstReceivedAt, lastReceivedAt }]`，恢复单条时定位                           |
| `attempts`、`last_error`                                                | `integer NOT NULL DEFAULT 0`、`text`                                                        | 重试与最近一次失败原因（不含原文内容）                                                                          |
| `created_at`、`verified_at`、`detached_at`、`dropped_at`、`restored_at` | `timestamptz`                                                                               |                                                                                                                 |

RLS `staff_only`；应用角色 `SELECT, INSERT, UPDATE`（状态机推进），无 `DELETE`。

两个 `SECURITY DEFINER` 函数（属主执行，`SET search_path = public, pg_temp`，`REVOKE ALL FROM PUBLIC`，仅 `GRANT EXECUTE` 给 `fs_billing_app`，函数内 `app_is_operator()` 守卫，写法同 `ensure_month_partition`，`0000_init.sql:496-532`），因为应用角色不是表属主，不能 `DETACH`/`DROP`：

- `raw_cdrs_detach_partition(p_month date, p_fingerprint jsonb)`：持有租户锁时拒绝；`SET LOCAL lock_timeout = '3s'`；对分区 `LOCK … ACCESS EXCLUSIVE`；重算指纹，与传入不符则报错；`ALTER TABLE raw_cdrs DETACH PARTITION raw_cdrs_YYYY_MM`；`RENAME TO raw_cdrs_YYYY_MM_archived`。分区名只能由 `p_month` 按固定格式生成，不接受调用方传名。
- `raw_cdrs_drop_detached(p_month date)`：只丢 `…_archived` 表，且要求该表确实已脱离父表。

### 归档文件格式

一个月一个文件，放在存储根下，即 Worker 所在机器的本地目录 `RAW_CDR_ARCHIVE_DIR`（如 `/var/lib/fs-billing/archive`），清单在数据库 `raw_cdr_archives`（决定 31）。代码里把存储放在 `ArchiveStore` 接口后面（本地目录是唯一实现），以后加对象存储不动调用方。文件是多个 gzip 成员首尾相接（合法的 gzip 流，`zcat` 可整体解压），每个成员是 ≤ 1000 行（或 ≤ 4 MiB 未压缩）的 JSON Lines：

```json
{
  "id": "<uuid>",
  "receivedAt": "2026-03-14T08:21:09.123456Z",
  "sha256": "<body 的 UTF-8 字节的 SHA-256>",
  "body": "<原文，JSON 字符串转义>"
}
```

- `body` 是 `raw_cdrs.body`（`text`，数据库编码 UTF-8）。JSON 字符串转义对任何合法 Unicode 文本无损，换行、制表符、重复键、多余空白、` ` 都原样保留。
- `receivedAt` **用文本取**（`to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`），不经 JavaScript `Date`，否则微秒被截成毫秒。原文定位键 `(id, received_at)` 要能精确对上（`unassigned_cdrs.raw_received_at` 保存的就是它，`0002_worker_reliability.sql:12-17`）。
- 行按 `(received_at, id)` 升序，所以成员的 `firstReceivedAt/lastReceivedAt` 区间互不重叠，恢复单条时按 `received_at` 二分选成员，只读解压一个成员（约 1000 行）。
- 成员的 `offset/length/sha256` 记在 `raw_cdr_archives.chunks`，不依赖文件内部索引。

选 gzip 而不是 zstd：Node 内置 `node:zlib` 的 gzip 稳定，运维用 `zcat | jq` 就能读；zstd 压缩比更好，但在本机 Node 22.23.2 的 `zlib` 里是实验性接口，项目要求的 Node 24 上未验证，不采用（决定 31）。代价：阶段 10 的备份要覆盖这个目录，磁盘要监控。

### 任务与状态机

Worker 新队列 `archive-raw-cdrs`，`boss.schedule(…, '0 4 * * *', null, { tz: 'Asia/Shanghai' })`（01:00 分区维护之后、与 02:00 账单生成和 03:00 账单核对错开）；`installQueue` 预建队列，`retryLimit: 3`，`expireInSeconds` 给足（一个月分区按 `design.md:404-414` 的估算约 1.7 GB 原文，待 PR 3 实测）。每次运行只处理一个月（最老的未完成月），任务 `singletonKey = archive:YYYY-MM`，多次触发不并发。配置：`RAW_CDR_ARCHIVE_DIR`、`RAW_CDR_ARCHIVE_AFTER_MONTHS`（默认 6）、`RAW_CDR_ARCHIVE_GRACE_DAYS`（默认 7，决定 32）。

「超过 6 个月」按分区整月算：月份 M 的分区在 `M 月末 + 6 个月 ≤ 现在（北京）` 之后才可归档，也就是每条原文至少已保存 6 个月，最老的一月留到约 7 个月，不按半月分区（决定 32）。校验通过后 `DETACH` 并改名为 `raw_cdrs_YYYY_MM_archived`，保留宽限期后再 `DROP`，宽限期内可以原样挂回；`DROP` 是唯一不可逆的一步。不按行龄归档，因为那样分区里新旧混合，不能整月分离，与 `phase-2-db.md:371` 的方案冲突。

状态推进（每步幂等，失败可重入）：

| 步骤   | 动作                                                                                                                                                                                        | 数据库状态变化                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1 导出 | `REPEATABLE READ READ ONLY` 事务，**直接按分区名**查询（不查父表，只锁分区，不阻塞对 `raw_cdrs` 的写入和建分区），游标分批读，写 `….partial`，每 1000 行结束一个 gzip 成员，`fsync`         | 插入 `exporting`（`ON CONFLICT (month)` 续作）      |
| 2 校验 | 重新打开 `….partial`，逐成员解压、逐行重算 `sha256(body)`，与导出时记录的逐行哈希和数据库当前 `sha256(convert_to(body, 'UTF8'))` 逐行比较；行数、`rows_digest` 一致后 `rename` 为正式文件名 | `verified`，写 `file_*`、`chunks`、`db_fingerprint` |
| 3 分离 | 调 `raw_cdrs_detach_partition`；超时拿不到锁则本次放弃，下次再试（数据未动）                                                                                                                | `detached`                                          |
| 4 丢弃 | 宽限期（默认 7 天）后调 `raw_cdrs_drop_detached`；宽限期内保留 `raw_cdrs_YYYY_MM_archived`，可原样挂回                                                                                      | `dropped`                                           |
| 失败   | 任一步抛错：`state = 'failed'`，记 `attempts`、`last_error`，开一条 `system_alerts`（`kind = 'raw_archive_failed'`，每月一条，成功后写 `recovered_at`）                                     | `failed`                                            |

**校验通过之前数据库一行不动**；`detach` 之前文件已校验、已落盘；`drop` 之前有宽限期。

`DETACH PARTITION … CONCURRENTLY` 不能在事务块里执行，而 `SECURITY DEFINER` 函数总在事务内，所以这里用普通 `DETACH`（对 `raw_cdrs` 短暂 `ACCESS EXCLUSIVE`）加 `lock_timeout` 重试。这是对 PostgreSQL 行为的推断，PR 3 在 PG 17 上实测（连同拿不到锁时对入库的影响）后再定，不能因此让入库阻塞超过 `lock_timeout`。

### 恢复与逐字节一致

「逐字节相同」的对象是 `raw_cdrs.body` 存的文本的 UTF-8 编码，不是 HTTP 请求的线上字节：非法 UTF-8 或 NUL 在入库时就写不进 `text`（`phase-2-db.md:101`）。归档与恢复不再引入任何变换：

1. 归档写入 `body` 的 JSON 字符串转义；同时记录 `sha256(convert_to(body, 'UTF8'))`，由数据库算，不是由 JavaScript 重算。
2. 恢复读到同一个字符串，`Buffer.from(body, 'utf8')` 重新计算 SHA-256 并与归档里的 `sha256` 比较，不符就报错，不输出。
3. 成员级：`chunks[i].sha256` 校验压缩字节，整文件 `file_sha256` 供运维核对。

**单条恢复**（验收：归档后恢复一条原始 JSON，内容与归档前逐字节相同）：库函数 `readArchivedRawCdr(manifest, store, { id, receivedAt })`，按月份找清单、按 `receivedAt` 选成员、解压、按 `id` 取行、验哈希，返回 `{ body, sha256 }`；CLI `pnpm --filter @fs-billing/worker raw:restore -- --id <uuid> --received-at <iso> [--out <文件>]`，把 `body` 的 UTF-8 字节原样写到标准输出或文件，不加换行。恢复单条是只读取回，不写数据库，不写操作日志，本阶段不做管理后台页面（决定 33）；设计稿没有对应页面，单条取回足以满足验收和排障，整月恢复才需要写库。

**整月恢复**（运维脚本，非验收项，随 PR 3，决定 33）：`ensure_month_partition('raw_cdrs', …)` 重建分区，`INSERT` 保留原 `id`、`received_at`，`payload` 由生成列重新得到；状态置回并记 `restored_at`；归档任务对 `restored_at` 起 30 天内的月份不再归档。宽限期内（`…_archived` 还在）直接把它 `ATTACH` 回去即可，不需要读文件。

## 阶段 3 评审遗留项

### 校验失败原因结构化

`apps/worker/src/ingest.ts:100、104` 把 `parsed.error.message`（Zod 的完整 JSON 错误）原样写进 `unassigned_cdrs.reason` 和 `system_alerts.description`。改为：

```
话单校验失败: variables.billsec(invalid_type), variables.uuid(invalid_format)
```

即固定前缀（`CDR_VALIDATION_FAILURE_PREFIX`，`unassigned_cdrs_billing_number_reason_check` 依赖它，`0004_billing_number_not_null.sql`）后接最多 5 个 `路径(错误码)`，超出写「等 N 项」，总长 ≤ 200 字符，不含输入值，不含 Zod 的 `message`。完整信息仍在 `raw_cdrs.body`。实现为共享函数 `summarizeCdrIssues(error)`，放在 `packages/shared/src/worker.ts`，Worker 与测试共用。系统告警描述同一个字符串，加原文 id。

### 无 UUID 无效推送去重

现状：校验失败的行 `call_uuid` 恒为空（UUID 留在原文里，不占去重闸门，`ingest.ts:91-110`），每次推送都新建一行并写告警；同一份坏原文被 FreeSWITCH 重推 N 次就是 N 行（`raw_cdrs` 照样存 N 份，这是阶段 2 已决定的，`phase-2-db.md:394`，不变）。

改法：入库时计算原文 UTF-8 字节的 SHA-256 存入 `raw_sha256`，用局部唯一索引 `unassigned_cdrs_invalid_body`（`call_uuid IS NULL AND status IN ('pending', 'ignored')`）去重：

```sql
INSERT INTO unassigned_cdrs (…, raw_sha256, push_count, last_pushed_at)
VALUES (…, $sha, 1, now())
ON CONFLICT (raw_sha256) WHERE call_uuid IS NULL AND status IN ('pending', 'ignored')
DO UPDATE SET push_count = unassigned_cdrs.push_count + 1, last_pushed_at = now()
RETURNING (xmax = 0) AS inserted
```

`inserted` 为假时：不新增行，**不再写告警**（决定 42）。本阶段只做这一项，JSON 解析失败（只写告警、不写 pending 行）不在范围。去重对已忽略的行同样生效：管理员忽略过的坏原文再次推送，不会再冒出来。原文只有字节完全相同才合并；字节不同的修正稿是另一行，由下一节解决。JSON 解析失败（`ingest.ts:81-86`）本来就不写 pending 行，只写告警，不在本项范围。

### 修正重推成功后解决旧 pending

现状：修正后的话单成功入库（`cdrs` 或有身份的未归属行），旧的校验失败行仍是 `pending`。

改法：校验失败行入库时，尽力从原文解析 `variables.uuid`，语法是合法 UUID 才存入 `candidate_call_uuid`（`invalidCdrIdentitySchema` 现在已在解析 `variables`，`apps/worker/src/invalid-cdr.ts`，加一个 `uuid` 字段）。之后任何**通过校验**的话单入库（`queued`、`unassigned` 停放、`duplicate` 都算「该通话已有身份」），在同一事务里：

```sql
UPDATE unassigned_cdrs
SET status = 'superseded', resolved_at = now(), superseded_by_call_uuid = $uuid
WHERE call_uuid IS NULL AND status = 'pending' AND candidate_call_uuid = $uuid
```

`superseded` 不在「待处理」也不在「已忽略」页签里（设计稿没有第三个页签），API 用 `status=superseded` 可查。**局限**：原文里根本没有可解析 UUID 的坏话单（缺 `uuid` 字段）无法自动对上修正稿，只能人工忽略；这类行页面上没有额外提示，风险一节记录。

### 分区维护 DB 测试偶发超时

plan 要求「排查根因并修复，后续通过不能证明不稳定已消除」。**本步没有复现，根因未验证**，下面只是线索，PR 2 先查再改。

候选测试：`apps/worker/src/app.db.test.ts` 的「启动维护立即建分区，每日北京时间调度可重复运行」（约 `:1075-1112`）。它 `drop table cdrs_<下月>, raw_cdrs_<下月>`，随后启动维护、等 pg-boss 任务 `expect.poll(…, { timeout: 10000 })` 到 `completed`；`vitest.db.config.ts` 的 `testTimeout` 是 20 秒，`fileParallelism: false`。可能的原因（未证实）：

1. `DROP TABLE` 与 `CREATE TABLE … PARTITION OF` 都要 `cdrs`/`raw_cdrs` 的 `ACCESS EXCLUSIVE`（`0000_init.sql:496-500` 注释）。同一测试文件里此前测试启动的 pg-boss 工作者、扣费任务、对账任务仍在后台读 `cdrs`，DDL 排队时会拦住后来的所有读写（锁队列效应）。
2. `expect.poll` 的 10 秒等 pg-boss 轮询，pg-boss 默认轮询间隔 2 秒，负载高时可能不够。
3. `boss.send` 的任务是单次，被其他测试遗留的同名队列任务抢走。

PR 2 的做法：先加诊断再改——测试库设 `log_lock_waits = on`、`deadlock_timeout = 200ms`；在该测试的失败路径把 `pg_stat_activity` 的 `wait_event` 与 `pg_locks` 快照写进断言消息；循环跑至少 200 次（单文件 `--repeat`）并记录失败率和失败时的锁等待者。找到根因后修复根因（例如测试前停止后台工作者、或维护路径给 DDL 加 `lock_timeout`），不靠放宽超时。验收证据是修复前后各 200 次的失败计数，写入 `docs/evidence/phase-8/`。

另一个由此浮现的生产问题：`ensure_month_partition` 在分区缺失时对 `cdrs` 取 `ACCESS EXCLUSIVE` 且没有 `lock_timeout`，被长事务拦住时会让全部话单读写排队。日常维护提前一个月建分区，通常命中「已存在」直接返回，风险低；PR 2 评估是否在函数里加 `SET LOCAL lock_timeout`（同样适用于本阶段的分离函数）。

### Lua 与 `dialed.test.ts` 共用号码用例

两份清单现在各写各的：`packages/rating/src/dialed.test.ts:4-47` 的 `test.each` 与 `freeswitch/tests/billing_authorize_test.lua`。改为一个纯文本用例文件 `freeswitch/tests/dialed-cases.tsv`（每行 `valid<TAB>拨号<TAB>计费号码` 或 `invalid<TAB>拨号`，`#` 开头为注释；拨号里的特殊字符用转义，如 `\n`、`\s`）：

- vitest 读文件并生成 `test.each`（取代现有的两个硬编码数组）；
- Lua 测试用 `io.lines` 读同一个文件，对每行调用脚本里的归一化函数并比较（Lua 测试已经运行在 `lua5.3` 下，由 `tests/billing-authorize.test.ts` 启动，无 `lua5.3` 时本地跳过、CI 必跑，`tests/billing-authorize.test.ts:5-7`）。

再加一个 vitest 用例保证文件格式合法、两端读到的条数相等。不动归一化逻辑本身。

## 延后项

### 重置密码的审计失败

延后项的前提是「提交成功后审计写入失败」。当前代码 `AdminAccountService.resetPassword`（`apps/api/src/auth/admin-accounts.ts:362-396`）在**同一个** `withAdmin` 事务里依次 `setCredential`、`clearLoginFailures`、`revokeSessions`、`writeAudit`，审计失败整个事务回滚：凭据不变、会话不撤销、管理员收到 5xx。已有测试 `portal password reset waits for its tenant lock…`（`apps/api/src/admin-accounts.db.test.ts:964-1020`）覆盖「提交后才有审计」。也就是说，延后项描述的窗口在阶段 5 的修改（#22，「同一业务事务内创建…审计…失败整体回滚」，`plan.md:242`）之后已经不存在。设计稿 `design.md:361` 也写明「账号、资料和操作日志在同一个事务里写入，失败时全部回滚」。

因此这条延后项不能按字面实现（没有「已提交而审计失败」的路径可接）。用户 2026-10-23 决定（决定 40）：保持原子（比延后项更强：没有审计就没有重置），加一个回归测试证明审计失败时凭据和会话不变，并在审计写入失败（5xx）时尽力写一条 `system_alerts`（`kind = 'audit_failed'`，不含密码、邮箱或原文，只有动作与对象 id），让运维不必只靠 5xx 日志发现。告警在**另一个**事务里写（主事务已回滚），写不进去也不影响响应，只记结构化日志。plan.md 里这条延后项（`plan.md:300`）的文字应更正为「已由阶段 5 原子化，阶段 8 加告警与回归测试」。本步不改 plan.md，作为后续更正，在 PR 6 勾选 plan 阶段 8 时一并修改。不采用的做法：先提交凭据、审计在后续事务里写（可能出现无审计的重置，与 `design.md:361` 冲突），以及只关闭不加告警。

### bootstrap 审计

`bootstrapCredential`（`apps/api/src/auth/bootstrap.ts`）用 owner 连接、不经 API，没有管理员会话，而 `operation_logs.admin_id` 是 `NOT NULL REFERENCES admins`。要记录「操作者」，用户 2026-10-23 决定（决定 41）：操作者不伪造管理员，也不新建系统管理员行或另表，而是让 `operation_logs` 真实反映「没有管理员」：

- 迁移 0018：`operation_logs.admin_id` 去掉 `NOT NULL`，加 `actor_label text`，`CHECK ((admin_id IS NOT NULL) <> (actor_label IS NOT NULL))`；`audit_operation_logs` 改 `LEFT JOIN admins` 并多返回 `actor_label`（函数返回列变了，要 `DROP` 再 `CREATE`，重新 `GRANT`，并更新 `packages/db/src/audit.db.test.ts:43-52` 里对权限的断言）。
- 审计载荷的 `actor` 变为 `{ id, name } | { label }` 的联合；`actor_label` 形如 `cli:auth:bootstrap@<主机名>/<操作系统用户>`，取自 `os.userInfo().username` 与 `os.hostname()`，不是自称的字符串。
- 成功：凭据写入/替换、会话撤销、`operation_logs` 插入在**同一个** owner 事务里提交（`bootstrapCredential` 的 `BEGIN … COMMIT`）。内容：`mode`（有 `--replace` 为 `replace`，否则 `create`）、`result = 'succeeded'`、`revokedSessions`（`DELETE FROM auth.session` 的行数）。
- 拒绝/失败：已知拒绝（资料不存在、凭据已存在未带 `--replace`、多个凭据账户）和未知失败，在回滚后另用一个短事务写 `result = 'rejected' | 'failed'` 与稳定的 `errorCode`（固定枚举，不取异常消息，因为异常消息可能带输入，`bootstrap-credential.ts` 的错误处理已经按这个原则只输出白名单消息）。这条写入尽力而为：失败只在标准错误提示「审计未写入」，退出码仍反映 bootstrap 本身的结果。
- 不记录：密码、哈希、会话 token、`--generate` 生成的明文。`bootstrapCredential` 的参数里没有 token，哈希在函数内部产生，不进入审计载荷。

## 端点

后台操作 `access: 'admin'`、`isolationCase: 'admin-only'`（`packages/shared/src/api/admin/contract.ts:71-95`），租户只来自路径或请求体里的 `tenantId`，管理员本来就能看所有租户。本阶段没有门户端点，客户会话访问任一端点得 403。契约放 `packages/shared/src/api/admin/unassigned.ts`、`cdr-deletions.ts`、`audit-logs.ts`，先不并入 `liveApiContract`，随 PR 4 路由登记（登记方式同阶段 7，`packages/shared/src/api/admin/contract.ts:424-475`、`apps/api/src/routes/contract.ts`）。

| operationId                    | method path                                        | 请求                                                | 200 响应                            | 说明                     |
| ------------------------------ | -------------------------------------------------- | --------------------------------------------------- | ----------------------------------- | ------------------------ |
| `adminUnassignedSummary`       | `GET /api/admin/unassigned-cdrs/summary`           | 无                                                  | `{ pending, ignored }`              | 导航角标                 |
| `adminUnassignedGroups`        | `GET /api/admin/unassigned-cdrs/groups`            | 无                                                  | 分组列表                            | 含相近租户               |
| `adminUnassignedList`          | `GET /api/admin/unassigned-cdrs`                   | query `status`、`tag`、`page`、`pageSize`           | 分页列表                            |                          |
| `adminUnassignedAssignPreview` | `POST /api/admin/unassigned-cdrs/assign-preview`   | `{ tenantId, selection }`                           | 预览                                | 只读，不写日志           |
| `adminUnassignedAssign`        | `POST /api/admin/unassigned-cdrs/assign`           | `{ tenantId, selection, idempotencyKey, expected }` | 结果 + `affectedMonths` + `auditId` | 写 `unassigned_assign`   |
| `adminUnassignedIgnore`        | `POST /api/admin/unassigned-cdrs/ignore`           | `{ selection, reason }`                             | `{ changed, auditId }`              | 写 `unassigned_ignore`   |
| `adminUnassignedUnignore`      | `POST /api/admin/unassigned-cdrs/unignore`         | `{ selection }`                                     | `{ changed, auditId }`              | 写 `unassigned_unignore` |
| `adminTenantCdrDeletionMonths` | `GET /api/admin/tenants/{tenantId}/cdr-deletions`  | query `year`                                        | 12 个月状态与条数                   |                          |
| `adminTenantCdrDelete`         | `POST /api/admin/tenants/{tenantId}/cdr-deletions` | `{ fromMonth, toMonth, tenantCode, expectedCount }` | 每月结果                            | 每月写一条 `cdr_delete`  |
| `adminAuditLogs`               | `GET /api/admin/audit-logs`                        | query 见上                                          | 分页日志                            | 只读                     |

既有 `adminTenantCdrs`（话单列表）的响应加 `deletedMonths: [{ month, count, deletedBy: { id, name } | null, deletedAt | null }]`，只含与所选日期范围相交的已删除月份，供提示条使用；门户话单响应不加（`portal` schema 是 strict，也没有这些字段，沿用阶段 7 的原则）。

新增 409 码，加入 `adminConflictCodeSchema`（`packages/shared/src/api/admin/errors.ts:5-20`）：

| 情形                                                    | 响应                               |
| ------------------------------------------------------- | ---------------------------------- |
| 预览之后数字变了（条数、金额、无费率数）                | 409 `UNASSIGNED_PREVIEW_STALE`     |
| 选择里没有任何可分配的待处理话单                        | 409 `UNASSIGNED_NOTHING_TO_ASSIGN` |
| 幂等键已用于另一个操作人或另一份选择                    | 409 `IDEMPOTENCY_CONFLICT`（已有） |
| 选择超过单次上限                                        | 400 `VALIDATION_ERROR`             |
| 删除：月份不在可删范围（当月、无账单、已删除、blocked） | 409 `CDR_MONTH_NOT_DELETABLE`      |
| 删除：条数与预览不符                                    | 409 `CDR_DELETE_COUNT_CHANGED`     |
| 删除：租户编码不符                                      | 400 `VALIDATION_ERROR`             |
| 目标租户币种与选择无关（分配用目标租户币种计价）        | 不报错；预览显示目标币种           |

### 越权用例（IDOR）

每个后台操作登记一个 `admin-only` 用例；覆盖检查由 `generateOpenApi` 强制（`apps/api/src/idor.db.test.ts:601-663`）。具体情形：

1. 客户会话调用本阶段十个操作中的任一个，得 403；未登录得 401。
2. 数据库层：以租户身份直接 `SELECT` `unassigned_cdrs`、`unassigned_assignments`、`raw_cdr_archives`、`operation_logs` 都读不到行，`INSERT/UPDATE/DELETE` 被策略拒绝（`rls.db.test.ts` 同形）。
3. `monthly_statements` 的新三列：租户身份能 `SELECT` 本租户的账单行（既有策略），所以门户查询必须显式列出列；门户账单响应的原始 JSON 不含 `details_deleted_by`、`details_deleted_at`（对未解析的 `response.body` 断言）。
4. 管理员停用后，会话立即失效，删除/分配被拒（沿用既有机制，加一个用例）。

## Web 页面

页面细节以设计稿为准，下表只列新增或改动的文件。

| 文件                                                      | 动作                                                                                                                                                                                    | PR  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `components/app-shell.tsx`                                | 后台导航按设计稿顺序加「未归属话单」（待收款之后，带待处理条数角标）、「操作日志」（账单之后）；更新文件头注释                                                                          | 5   |
| `router.tsx`                                              | `/admin/unassigned`、`/admin/audit-logs`                                                                                                                                                | 5   |
| `pages/admin/unassigned.tsx`（新）                        | 页签「待处理 / 已忽略」；分组卡片（含「疑似拼写错误，相近：ABC001」）；表格勾选、「选择『…』全部 N 条」、清除选择；操作条「忽略」「归属到租户」；空状态「所有话单都已归属」；手机卡片   | 5   |
| `components/admin/unassigned-assign-dialog.tsx`（新）     | 租户下拉（相近租户置顶并提示）→ 预览三格 → 无费率说明 → 「确认后从 ABC001 余额扣除 ¥58.35（−¥35.20 → −¥93.55）」→ 「确认归属 324 条并扣费」；结果里列受影响月份和「前往账单页重新生成」 | 5   |
| `components/admin/unassigned-ignore-dialog.tsx`（新）     | 必填原因、快捷原因、「忽略和撤销均记入操作日志」                                                                                                                                        | 5   |
| `components/admin/cdr-delete-dialog.tsx`（新）            | 开始/结束月份选择器；月份网格每格带子标签与不可选原因；预览「将删除 ABC001 在 2026年8月 的 9,642 条话单」+ 时间范围；红色影响说明；编码输入（区分大小写）+「删除 N 条话单」；完成页     | 5   |
| `components/month-field.tsx`                              | 把 12 月网格抽成 `MonthGrid`，支持每格 `{ disabled, sub, title }`；账单页的 `MonthField` 与删除对话框共用                                                                               | 5   |
| `pages/admin/tenant-tabs/cdrs-tab.tsx`                    | 右上角「删除话单」按钮（现在注释写着不显示，`cdrs-tab.tsx:39-40`）；范围含已删除月份时显示提示条                                                                                        | 5   |
| `pages/admin/audit-logs.tsx`（新）、`lib/admin-search.ts` | 四个筛选、可展开行、50 条一页、空状态；筛选写入地址参数                                                                                                                                 | 5   |
| `lib/api-problem.ts`                                      | 新错误码的中文提示                                                                                                                                                                      | 5   |

主题、手机宽度、深浅色的视觉对照在 PR 6 做，沿用阶段 6、7 的形式。

## 并发与幂等小结

| 场景                                  | 对策                                                                                                                            | 测试                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 同一批分配重复提交（顺序）            | 四层幂等见[分配](#分配事务幂等并发)                                                                                             | 验收 2                                                       |
| 两个管理员同时分配同一批（不同键）    | 行锁 `FOR UPDATE`，后者得 0 条                                                                                                  | `assigns a row once when two admins submit at the same time` |
| 分配与 Worker 重推同一 UUID 并发      | HTTP 入库声明 `app.cdr_ingest`，不认领，判 `duplicate`；两边都以 `call_uuids` 为闸门                                            | 沿用阶段 3 并发测试，加一例                                  |
| 分配中途杀进程 / 回滚                 | 同一事务，要么整批成功要么全不变；没有「已扣费未入库」状态                                                                      | `a failure in the middle rolls the whole batch back`         |
| 分配与删除同一租户并发                | 都持租户锁，串行；删除在锁内重新检查「有未扣费话单」                                                                            | `delete waits for an in-flight assignment`                   |
| 删除重复提交 / 两个管理员同时删同一月 | 资格检查在租户锁内重做，`details_deleted` 已真则 409 `CDR_MONTH_NOT_DELETABLE`                                                  | `deleting the same month twice affects it once`              |
| 删除与账单重新生成并发                | 重新生成读 `details_deleted`；触发器兜底；两者都在租户的各自事务里，重新生成不拿租户锁，所以靠触发器：先提交者胜，后者 409/拒绝 | `regeneration racing a deletion is rejected by the guard`    |
| 归档任务重复触发 / 多实例             | `singletonKey`；清单行 `PRIMARY KEY (month)` 与 `ON CONFLICT`；`DETACH` 在数据库侧串行                                          | `a duplicate archive job does not archive twice`             |
| 归档中途崩溃                          | 状态机续作；`.partial` 文件丢弃重写；数据库在 `verified` 前不变                                                                 | `a crash after export and before detach is resumed`          |
| 无效推送并发重推                      | 局部唯一索引加 `ON CONFLICT DO UPDATE`                                                                                          | `concurrent pushes of one invalid body keep one row`         |

`withAdmin` 在 `40P01`、`40001` 时会重跑回调（`packages/db/src/client.ts:155-208`），分配与删除回调都只做数据库操作、可重跑；`idempotencyKey` 保证即使客户端重试也不会重复。

## 性能

plan 阶段 8 没有性能验收。本步没有做任何测量，下面是 PR 里要测的项目，沿用阶段 6、7 在 `fs_billing_perf`（PORTALBIG）上测量的做法：

- 分配 N 条（N = 326、5000）的事务耗时与租户锁持有时间，以此定 `ASSIGN_MAX_ROWS`。
- 删除 1 个月（PORTALBIG 的 2026-09 北京月 234,277 通，阶段 7 实测）的耗时，以及删除期间该租户扣费排队的时长。
- 归档 1 个月分区（原文约 1.7 GB 的估算见 `design.md:404-414`）的导出、校验耗时与压缩比；`DETACH` 的锁等待时间。
- 未归属列表在 10 万行下的分页与分组耗时；操作日志在 100 万行下带筛选的耗时。

结果写入 `docs/evidence/phase-8/`。PR 1 已测前两项和最后一项的 SQL 部分（分配 326、2000、5000 条，删除 PORTALBIG 的 2026-09，10 万行未归属话单的分组与分页，100 万行操作日志的筛选），见 [evidence/phase-8/README.md](evidence/phase-8/README.md)；归档由 PR 3 测，列表与日志的 HTTP 耗时由 PR 4 测。

## 已决定

下表是既有文档已定的规则、从仓库推出的约束，以及本设计的技术方案。「本设计」一栏表示技术选择，用户可以推翻，但不是产品问题。来源为「用户 2026-10-23 确认」的第 31 至 44 项是原先的待确认问题 Q1 至 Q14，用户全部采用推荐项；第 1 至 30 项是本设计自行选择的默认，用户同日一并确认。当前没有待用户确认的问题。

| #   | 决定                                                                                                                                                                                      | 来源                                      | 落实                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| 1   | 分配按**接通时刻**生效的费率定价，和入库同一套函数；不用「当前费率」                                                                                                                      | `design.md:202、238`；`ingest.ts:140-166` | [预览](#预览)；PR 1                                                |
| 2   | 分配与扣费在同一个事务、API 进程内完成，不经 pg-boss；入库定价和扣费逻辑抽到 `packages/db` 共用                                                                                           | 本设计                                    | [分配](#分配事务幂等并发)；PR 1                                    |
| 3   | 重复提交只扣费一次：请求幂等键、行状态加行锁、`call_uuids` 认领、流水幂等键四层                                                                                                           | plan 验收 2；`0001_worker_gate.sql`       | 同上                                                               |
| 4   | 预览不落库；提交带 `expected`，事务内实算不符则 409 并回滚                                                                                                                                | 本设计（先例：`PREVIEW_STALE`）           | 同上                                                               |
| 5   | 单次分配最多 `ASSIGN_MAX_ROWS` 条（2000，PR 1 实测）                                                                                                                                      | 本设计                                    | 同上                                                               |
| 6   | 补扣费落在已出账月份，该月账单变 `stale`，不自动重新生成；响应和页面列出受影响月份                                                                                                        | `phase-7-design.md` 依赖表                | 同上                                                               |
| 7   | 纳入「忽略」「撤销忽略」，忽略必填原因，都记操作日志                                                                                                                                      | `pages.md:313-315`；设计稿                | [忽略](#忽略与撤销忽略)；PR 1、4                                   |
| 8   | 「疑似拼写错误」= 标签与某租户编码的编辑距离 ≤ 1（忽略大小写）                                                                                                                            | 设计稿「相近：ABC001」；本设计            | [分组](#分组与列表)                                                |
| 9   | 未归属话单表加「原因」列                                                                                                                                                                  | 本设计（设计稿没有，见出入第 4 条）       | Web                                                                |
| 10  | 删除按整个北京月，月份谓词与话单列表、导出一致（`coalesce(answered_at, started_at)`）                                                                                                     | `cdr-query.ts:20-39`；`design.md:315`     | [月份可选规则](#月份可选规则)                                      |
| 11  | 删除元数据放在 `monthly_statements`（三列），不新建删除表；与话单删除、置标志同事务                                                                                                       | `phase-7-design.md` 预留                  | [数据与迁移](#数据与迁移)                                          |
| 12  | 话单标签页范围含已删除月份时显示提示条（条数、操作人、时间）                                                                                                                              | 设计稿 `删除话单原型.dc.html`             | [端点](#端点)；Web                                                 |
| 13  | 删除时 `call_uuids` 保留，已删话单重推仍判重复                                                                                                                                            | 本设计；`ingest.ts:126-131`               | [删除后流水和账单为什么不变](#删除后流水和账单为什么不变)          |
| 14  | 删除先对所有月份做资格检查，再按月份升序一月一事务，持租户锁；确认需租户编码完全相等并带 `expectedCount`                                                                                  | `pages.md:281-283`；本设计                | [删除事务](#删除事务)                                              |
| 15  | 当月、无账单月、已删除月不可删，界面置灰、服务端 409                                                                                                                                      | `design.md:391`；plan 验收 3              | 同上                                                               |
| 16  | 删除不改流水、余额、账单头部与明细；用测试对比哈希证明                                                                                                                                    | `design.md:394-402`                       | 同上                                                               |
| 17  | 操作日志复用 `operation_logs`，只读，加三个索引和新 action；标签在服务端展开为 action 集合                                                                                                | `pages.md:335-342`                        | [操作日志](#操作日志)                                              |
| 18  | 本阶段所有人工操作的审计与业务写入同事务                                                                                                                                                  | `design.md:361`；`balance.ts`             | 各节                                                               |
| 19  | 归档以 `raw_cdrs` 月分区为单位，整月分离，不逐行删除                                                                                                                                      | `phase-2-db.md:371`                       | [归档](#任务与状态机)                                              |
| 20  | 按北京月整月归档，月份满 6 个月后才归档                                                                                                                                                   | `design.md:414`；本设计                   | 同上                                                               |
| 21  | 归档先导出、校验，再分离，再宽限期后丢弃；校验通过前数据库不变                                                                                                                            | 本设计                                    | 同上                                                               |
| 22  | 归档保存 `body` 的 UTF-8 逐行 SHA-256（数据库计算）；`received_at` 用文本；恢复前再验                                                                                                     | plan 验收 5；本设计                       | [恢复与逐字节一致](#恢复与逐字节一致)                              |
| 23  | 归档分离用普通 `DETACH` 加 `lock_timeout`，不用 `CONCURRENTLY`（函数内不可用，待实测）                                                                                                    | 本设计                                    | 同上                                                               |
| 24  | 校验失败原因改为前缀加最多 5 个 `路径(错误码)`，≤ 200 字符                                                                                                                                | plan 验收 6                               | [校验失败原因结构化](#校验失败原因结构化)；PR 2                    |
| 25  | 无 UUID 无效推送以原文 SHA-256 去重，计 `push_count`，行为含已忽略                                                                                                                        | plan 验收 7                               | [去重](#无-uuid-无效推送去重)；PR 2                                |
| 26  | 新状态 `superseded`，靠 `candidate_call_uuid` 对上修正重推                                                                                                                                | plan 验收 8                               | [解决旧 pending](#修正重推成功后解决旧-pending)；PR 2              |
| 27  | 分区维护测试：先诊断再改，证据是修复前后各 200 次的失败计数                                                                                                                               | plan 验收 9                               | [偶发超时](#分区维护-db-测试偶发超时)；PR 2                        |
| 28  | 号码用例放 `freeswitch/tests/dialed-cases.tsv`，vitest 与 Lua 同读                                                                                                                        | plan 验收 10                              | [共用用例](#lua-与-dialedtestts-共用号码用例)；PR 2                |
| 29  | 所有 `active` 管理员都可分配、忽略、删除、读日志；没有角色区分，不新增                                                                                                                    | `design.md:351-364`                       | [越权用例](#越权用例idor)                                          |
| 30  | `system_alerts.kind` 加 `audit_failed`、`raw_archive_failed`（迁移里重建检查约束）                                                                                                        | 本设计；先例 0017                         | PR 1、3                                                            |
| 31  | 归档存本地目录 `RAW_CDR_ARCHIVE_DIR`，每月一个 gzip 成员首尾相接的 JSON Lines 文件，清单在 `raw_cdr_archives`；存储在 `ArchiveStore` 接口后面，不用对象存储、不存 `bytea`、不用 zstd      | 用户 2026-10-23 确认（原 Q1，采用推荐项） | [归档文件格式](#归档文件格式)；PR 3                                |
| 32  | 「6 个月」按分区整月算，月末加 6 个月之后才归档（最老的月约存 7 个月）；校验后 `DETACH` 改名 `_archived`，宽限 7 天（可配）后 `DROP`；不按行龄、不按半月分区                              | 用户 2026-10-23 确认（原 Q2）             | [任务与状态机](#任务与状态机)；PR 3                                |
| 33  | 恢复单条 = 只读取回（CLI `raw:restore`，校验哈希，不写库、不写操作日志）；整月恢复是运维脚本；本阶段不做后台页面                                                                          | 用户 2026-10-23 确认（原 Q3）             | [恢复与逐字节一致](#恢复与逐字节一致)；PR 3                        |
| 34  | 删除话单只删 `cdrs`，不删原始 JSON；原文按归档策略老化，对话框与日志摘要写明；入库不新增 `tenant_id/call_uuid` 写入                                                                       | 用户 2026-10-23 确认（原 Q4）             | [删除后流水和账单为什么不变](#删除后流水和账单为什么不变)；PR 1、5 |
| 35  | 可分配 = 有 `call_uuid` 且有 `billing_number`，原因是「租户不存在」「缺少租户标签」「接通时无费率」；「计费号码不一致」「号码格式错误」「话单校验失败」只能忽略，列表标明                 | 用户 2026-10-23 确认（原 Q5）             | [预览](#预览)；PR 1、4、5                                          |
| 36  | 接通时刻无费率的话单保持规则：留在待处理，预览如实说明，只能忽略，欠费用调账在当前月补记；设计稿「请先在费率表补充该前缀」改为符合规则的文案；不加开关、不加手工单价                      | 用户 2026-10-23 确认（原 Q6）             | [预览](#预览)；PR 1、5                                             |
| 37  | 种子里 2 条无费率话单的接通时间早于 ABC001 第一个费率版本生效（8-12 09:30，取 2026-08-05），被叫 `1876…`；其余 324 条在版本生效之后；「前缀 1876」取自任一版本的 `prefixHint`；不改费率表 | 用户 2026-10-23 确认（原 Q7）             | [种子数据核对](#种子数据核对验收标准-1)；PR 1                      |
| 38  | 删除之后属于该月的迟到话单被拦：入库不扣费，停放到未归属（原因「所属月份话单已删除」）并写 `cdr_failed` 告警；分配同样不可分配；管理员可忽略或用调账补记                                  | 用户 2026-10-23 确认（原 Q8）             | [迟到话单遇到已删除的月份](#迟到话单遇到已删除的月份)；PR 1        |
| 39  | 删除话单的前置条件：该月 `reconcile_status = 'ok'` 且没有「有费用而无流水」的话单，否则月份不可选（`blocked`）；不设冷静期                                                                | 用户 2026-10-23 确认（原 Q9）             | [月份可选规则](#月份可选规则)；PR 1、5                             |
| 40  | 重置密码审计失败：保持原子，加回归测试，审计写入失败时另起事务尽力写 `audit_failed` 告警；plan.md 延后项文字改为「已由阶段 5 原子化，阶段 8 加告警与回归测试」，作为后续更正              | 用户 2026-10-23 确认（原 Q10）            | [重置密码的审计失败](#重置密码的审计失败)；PR 4                    |
| 41  | bootstrap 操作者：`operation_logs.admin_id` 改可空，加 `actor_label`，二者恰有其一；`audit_operation_logs` 改 `LEFT JOIN`                                                                 | 用户 2026-10-23 确认（原 Q11）            | [bootstrap 审计](#bootstrap-审计)；PR 1、4                         |
| 42  | 无效推送去重时告警一并去重：同一原文再次推送不写第二条告警；JSON 解析失败不在本阶段；阶段 9 的同名一项缩成合并展示与恢复，plan 文字作为后续更正                                           | 用户 2026-10-23 确认（原 Q12）            | [无 UUID 无效推送去重](#无-uuid-无效推送去重)；PR 2                |
| 43  | 操作日志页面按 pages.md 与设计稿：四个筛选、50 条一页、只读，不导出，不设保留期；后台任务结果不进日志，带 `actor_label` 的事件进                                                          | 用户 2026-10-23 确认（原 Q13）            | [页面](#页面)；PR 4、5                                             |
| 44  | 删除范围跨多月：先对所有月份做资格检查，任一不合格整体拒绝；通过后按月一个事务，月份之间不原子，中途故障时列出已删与未删月份，重试处理剩余                                                | 用户 2026-10-23 确认（原 Q14）            | [删除事务](#删除事务)；PR 1、5                                     |

## 验收标准对应计划测试

对应 [plan.md 阶段 8](plan.md#阶段-8话单运维) 的 10 条验收标准和 2 条延后项。下表的测试此时都不存在，状态均为「计划」，名字在对应 PR 落地时核对。

| 验收标准                                                                                                         | 测试文件 / name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. 把 ABC01 的 326 条分配给 ABC001：预览 ¥58.35、324 条、2 条无费率（前缀 1876）；余额减少 58.35，流水有对应扣费 | `packages/db/src/unassigned/assign.db.test.ts` / `previews 326 ABC01 rows against ABC001 as 324 assignable, 58.35 and 2 without a rate`、`assigning charges 58.35 and writes one call_charge per assignable row`（断言 `tenant_balances` 前后差、流水条数 324、`cdrs` 新增 324、剩余 `pending` 2 条、`occurred_at = answered_at`）；`apps/api/src/admin-unassigned.db.test.ts` / `returns the mockup figures through the preview and assign endpoints`；`apps/web/e2e/admin-unassigned.spec.ts` / `assigns the ABC01 group to ABC001`。种子的 2 条无费率话单接通早于 ABC001 第一个费率版本（决定 37），预览的「前缀 1876」来自 `prefixHint`，对话框文案按决定 36。 |
| 2. 同一批重复提交只扣费一次                                                                                      | `assign.db.test.ts` / `submitting the same batch twice charges once`（同键、不同键两种）、`assigns a row once when two admins submit at the same time`、`a second claim of the call uuid fails with call_uuids_pkey`；`admin-unassigned.db.test.ts` / `replays the stored result for the same idempotency key`                                                                                                                                                                                                                                                                                                                                                     |
| 3. 删除当月话单的按钮不可用；删除 8 月后余额、8 月账单不变，导出提示已删除，重新生成不可用                       | `packages/db/src/cdr-deletion/delete.db.test.ts` / `rejects the current month and a month without a statement`、`deleting August leaves the ledger, balance, statement header and breakdown unchanged`（前后哈希对比）、`flags the statement and removes the rows in one transaction`；`apps/api/src/admin-cdr-deletion.db.test.ts` / `returns 409 for the current month`；`apps/web/e2e/admin-cdr-deletion.spec.ts` / `disables the current month, deletes August and shows the deleted notices`（门户导出按钮置灰、后台重新生成置灰）。**删除 8 月前种子账单要先过核对（见风险）。**                                                                             |
| 4. 操作日志能查到删除：谁、何时、哪个租户、哪个月、多少条                                                        | `admin-cdr-deletion.db.test.ts` / `writes one cdr_delete audit per month with actor, time, tenant, month and count`；`apps/api/src/admin-audit-logs.db.test.ts` / `lists the deletion with its filters`；`apps/web/e2e/admin-audit-logs.spec.ts` / `finds the deletion by admin, type and tenant`                                                                                                                                                                                                                                                                                                                                                                  |
| 5. 归档后恢复一条原始 JSON，内容与归档前逐字节相同                                                               | `packages/db/src/raw-archive/archive.db.test.ts` / `restores a single raw cdr byte for byte after the partition is dropped`（含多字节 UTF-8、CRLF、重复键、1 MiB 正文、微秒 `received_at`）、`refuses to return a body whose hash does not match`、`restores a whole month with the same ids, times and bodies`；`apps/worker/src/archive.db.test.ts` / `the scheduled job archives a month older than six months`、`a crash after export and before detach is resumed`                                                                                                                                                                                            |
| 6. 校验失败原因不再保存冗长 Zod 消息                                                                             | `apps/worker/src/ingest.db.test.ts`（新）/ `stores a short structured reason for a failed validation`（长度 ≤ 200、不含输入值、保留前缀）；`packages/shared/src/worker.test.ts` / `summarizes issues to at most five paths`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 7. 无 UUID 校验失败话单重推去重                                                                                  | `ingest.db.test.ts` / `repeated pushes of one invalid body keep one pending row and count the pushes`、`concurrent pushes of one invalid body keep one row`、`an ignored invalid body does not come back`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 8. 修正重推成功后旧 pending 移除或标记已解决                                                                     | `ingest.db.test.ts` / `a corrected push resolves the earlier invalid row as superseded`、`a corrected push parked as unassigned also resolves it`、`an invalid row without a parsable uuid stays pending`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 9. 分区维护 DB 测试偶发超时                                                                                      | `apps/worker/src/app.db.test.ts` 中对应测试的修复；`docs/evidence/phase-8/partition-flake.md` 记录修复前后各 200 次的结果；诊断断言（失败时输出锁等待快照）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 10. Lua 与 `dialed.test.ts` 共用号码用例                                                                         | `packages/rating/src/dialed.test.ts` 读 `freeswitch/tests/dialed-cases.tsv`；`freeswitch/tests/billing_authorize_test.lua` 同读；`tests/dialed-cases.test.ts` / `the shared case file is well formed and read by both sides`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 延后项 1：重置密码审计失败接入 `system_alerts`                                                                   | `apps/api/src/admin-accounts.db.test.ts` / `a failed audit write rolls the reset back and leaves credentials and sessions unchanged`、`a failed audit write opens one audit_failed alert without secrets`。见决定 40。                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 延后项 2：`auth:bootstrap` 审计                                                                                  | `apps/api/src/bootstrap.db.test.ts` / `audits a created and a replaced credential in the same transaction`、`audits a rejected attempt`、`audit details never contain a password, hash or token`；`packages/db/src/audit.db.test.ts` 更新的函数与权限断言。见决定 41。                                                                                                                                                                                                                                                                                                                                                                                             |

### 新增行为的验收与测试

| 验收行为                                       | 测试文件 / name                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 忽略必填原因、撤销回到待处理、都写日志         | `packages/db/src/unassigned/ignore.db.test.ts` / `ignores with a reason and restores to pending`、`rejects an empty reason`                                                     |
| 不可分配的行（无身份、无计费号码）不进入分配   | `assign.db.test.ts` / `leaves rows without a call identity or billing number pending`                                                                                           |
| 预览与提交不符整体回滚                         | `assign.db.test.ts` / `rolls back when the preview figures no longer match`                                                                                                     |
| 分配落入已出账月份使账单 stale，不自动重新生成 | `assign.db.test.ts` / `the September statement becomes stale after the assignment and is not regenerated`（调用 `reconcileStatements` 断言 `stale`）                            |
| 分配落入已删除月份被拦                         | `assign.db.test.ts` / `rows answered in a details-deleted month are not assigned`（决定 38）                                                                                    |
| 比现有分区更老的未归属话单可分配               | `assign.db.test.ts` / `creates the missing cdrs partition before assigning an old row`                                                                                          |
| 入库遇到已删除月份的新话单：不扣费，停放并告警 | `apps/worker/src/ingest.db.test.ts` / `parks a call answered in a details-deleted month without charging it and opens a cdr_failed alert`                                       |
| 已删话单重推不重复入库、不重复扣费             | `delete.db.test.ts` / `a re-pushed deleted call is a duplicate`                                                                                                                 |
| 有未扣费话单或核对未过的月份不可删             | `delete.db.test.ts` / `rejects a month with a charge not yet written`、`rejects a month that is stale or inconsistent`（决定 39）                                               |
| 守卫触发器：删除元数据只能随标志一次写入       | `packages/db/src/statements/regenerate.db.test.ts` 加 `the guard rejects rewriting deletion metadata`                                                                           |
| 操作日志 RLS、只读                             | `packages/db/src/rls.db.test.ts` / `new staff-only tables hide their rows from tenants`、`operation_logs stays append-only with a nullable actor`                               |
| 越权                                           | `apps/api/src/idor.db.test.ts` 的 `cases` 与 `caseKinds` 覆盖十个新操作；`admin-statements.db.test.ts` / 门户账单 JSON 不含 `details_deleted_by`                                |
| 网页                                           | `apps/web/e2e/admin-unassigned.spec.ts`（分组、选择整组、预览、无费率说明、忽略与撤销、空状态）、`admin-cdr-deletion.spec.ts`、`admin-audit-logs.spec.ts`（筛选、展开、空结果） |

## PR 拆分

| PR  | 内容                                                                                                                                                                                                                                                                                                                                            | 依赖    | 文件边界                                                                                                                                                                                                                                                                                        | 验收与证据                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | 本 PR：设计文档                                                                                                                                                                                                                                                                                                                                 | 无      | `docs/phase-8-design.md`                                                                                                                                                                                                                                                                        | prettier；用户 2026-10-23 已回答全部问题，见[已决定](#已决定)第 31 至 44 项                                                                                                                                                                                              |
| 1   | 数据库核心：迁移 0018（未归属列与批次表、状态扩充、删除元数据与守卫、`operation_logs` 可空操作者与索引、告警类型）；抽出 `priceAndInsertCdr`、`chargeCall`；预览/分配/忽略/删除函数（删除含核对状态与未扣费话单的前置条件）；入库与分配拦截已删除月份（决定 38）；种子扩到 326 条（2 条接通早于费率生效，决定 37）；`audit_operation_logs` 更新 | 0       | `packages/db/migrations/0018_*.sql` 与 journal、`packages/db/src/schema.ts`、`packages/db/src/unassigned/*`、`packages/db/src/cdr-deletion/*`、`packages/db/src/cdr-intake.ts`、`packages/db/src/seed.ts`、`seed-calls.ts`、`apps/worker/src/charge.ts` 与 `ingest.ts`（改调共享函数）、DB 测试 | 验收 1–3 的 DB 测试；`pnpm test:db`、`pnpm test:idor`；PORTALBIG 上耗时写入 `docs/evidence/phase-8/`                                                                                                                                                                     |
| 2   | Worker 入库加固与阶段 3 遗留：校验失败原因、无效推送去重、`superseded`、`park` 保存 `hangup_cause/unverified`、同一原文再次推送不写告警（决定 42）、号码共用用例、分区测试诊断与修复                                                                                                                                                            | 1       | `apps/worker/src/ingest.ts`、`invalid-cdr.ts`、`packages/shared/src/worker.ts`、`freeswitch/tests/*`、`packages/rating/src/dialed.test.ts`、`apps/worker/src/app.db.test.ts`                                                                                                                    | 验收 6–10；200 次循环结果                                                                                                                                                                                                                                                |
| 3   | 归档与恢复：迁移 0019、归档库（本地目录 `ArchiveStore`）、Worker 任务、只读取回 CLI 与整月恢复脚本、配置、告警                                                                                                                                                                                                                                  | 1       | `packages/db/migrations/0019_*.sql`、`packages/db/src/raw-archive/*`、`apps/worker/src/archive.ts`、`queue.ts`、`main.ts`、`config.ts`、`apps/worker/scripts/*`                                                                                                                                 | 验收 5；`DETACH` 锁实测；一个月分区的耗时与压缩比                                                                                                                                                                                                                        |
| 4   | 契约与 API：未归属、删除、操作日志端点；审计 variants；`adminTenantCdrs` 加 `deletedMonths`；延后项 1、2（重置密码告警、bootstrap 审计）；越权用例                                                                                                                                                                                              | 1       | `packages/shared/src/api/admin/{unassigned,cdr-deletions,audit-logs}.ts`、`audit.ts`、`errors.ts`、`contract.ts`；`apps/api/src/routes/*`、`auth/admin-accounts.ts`、`auth/bootstrap.ts`、`scripts/bootstrap-credential.ts`、`idor.db.test.ts`                                                  | 验收 1–4、延后项的 API 测试；经 HTTP 的耗时记录                                                                                                                                                                                                                          |
| 5   | 后台 Web：未归属话单页与对话框、删除话单对话框、操作日志页、导航、话单标签页提示条、`MonthGrid` 抽取                                                                                                                                                                                                                                            | 4       | `apps/web/src/components/*`、`pages/admin/*`、`router.tsx`、`lib/*`                                                                                                                                                                                                                             | 组件测试与 e2e 冒烟；设计稿截图初稿                                                                                                                                                                                                                                      |
| 6   | e2e、视觉对照、plan 勾选                                                                                                                                                                                                                                                                                                                        | 2、3、5 | `apps/web/e2e/*`、`docs/evidence/phase-8*`、`docs/plan.md`、`README.md`                                                                                                                                                                                                                         | 全部 e2e；浅色、深色、手机宽度对照图与差异清单；plan 阶段 8 逐项勾选并附证据；更正 plan.md 延后项 1（`plan.md:300`）与阶段 9 一项（`plan.md:347`）的文字（决定 40、42）；同时更正 plan.md 中延后项 1（`plan.md:300`）与阶段 9 一项（`plan.md:347`）的文字（决定 40、42） |

PR 2 与 PR 3 只依赖 PR 1，可并行；PR 4 也只依赖 PR 1。PR 5 依赖 PR 4。每个 PR 合并前跑 `pnpm check`，涉及数据库的跑 `pnpm test:db`，PR 1 与 PR 4 加 `pnpm test:idor`。

## 与其他阶段的依赖

| 阶段              | 关系                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段 7 月账单     | 删除话单依赖账单存在性、`details_deleted` 与守卫触发器；分配的迟到流水让相应月份 `stale`（预期行为）；删除前置条件用到核对状态；重新生成的 `STATEMENT_DETAILS_DELETED` 已就绪                                                                                                                                                                                                   |
| 阶段 9 通知与告警 | 本阶段新增 `audit_failed`、`raw_archive_failed` 两种告警类型，只写入，页面展示、邮件、汇总由阶段 9 决定。本阶段按决定 42 去重无效推送的告警（同一原文再次推送不写第二条），阶段 9 `plan.md:347` 那一项缩小为告警的合并展示与恢复语义；plan 文字的更正是后续改动，本文不改 plan.md。「真实每分钟 cron 触发测试」「pg-boss 多实例安全」也约束本阶段新增的 `archive-raw-cdrs` 任务 |
| 阶段 10 部署      | 新队列需重新执行 `queue:migrate`；归档目录要进备份范围（数据库备份不含文件）并设磁盘告警；大分区 `DETACH` 的锁等待要在有历史数据的库上演练；归档目录权限（仅 Worker 用户读写）和保留策略写进运维手册；迁移 0018/0019 在有数据的库上的锁时长要纳入上线前迁移演练                                                                                                                 |

## 风险

- **验收 1 的「2 条无费率」靠种子构造。** 决定 37 用接通早于费率生效的 2 条话单产生，不靠删前缀；这 2 条通话早于开户，与设计稿「标签拼写错误」的叙事略有出入，对话框文案按决定 36 改写，差异记入 PR 5 的差异清单。
- **补扣费必然使已出账月份过期。** 324 条可分配的话单在 9-29 接通，分配后 ABC001 的 9 月账单 `stale`，核对任务开告警，管理员要去账单页重新生成。演示和 e2e 要在隔离库里跑，否则会破坏阶段 7 的视觉对照数字（−35.20）。
- **删除前提是核对通过。** 开发种子的 8、9 月账单现在是 `unchecked`；决定 39 要求 `ok`，验收 3 的夹具要先跑一次核对。
- **迟到话单撞上已删除月份。** 决定 38 拦下这类话单，代价是极少数话单需要人工忽略或用调账补记；入库复核标志的窗口见[迟到话单](#迟到话单遇到已删除的月份)，未在本步验证。
- **应用角色不能 `DETACH`。** 必须用 `SECURITY DEFINER` 函数，其中只能用普通 `DETACH`，会短暂锁 `raw_cdrs`；`lock_timeout` 重试策略需要实测。拿不到锁而反复失败时，归档停滞但不影响业务，靠 `raw_archive_failed` 告警发现。
- **归档文件是唯一副本。** `dropped` 之后，原文只在文件和备份里。文件丢失等于原文丢失；数据库备份（阶段 10，保留 30 天）在丢弃之后不再包含它。目录必须进备份（决定 31）。
- **原文无法按租户清除。** `raw_cdrs.tenant_id`、`call_uuid` 从未写入，删除话单不能顺带清原文（决定 34）。
- **plan.md 文字待更正。** 延后项 1（`plan.md:300`）与阶段 9 一项（`plan.md:347`）的文字与决定 40、42 不一致；本步不改 plan.md，由 PR 6 随勾选一并更正。
- **无 UUID 的坏原文无法自动解决。** `candidate_call_uuid` 为空的行，修正重推不会关联到它，只能人工忽略。
- **分配的批量上限随数据量变化。** 2000 条来自 PR 1 在 PORTALBIG（340 万话单、285 万笔流水）上的实测，每行约 2.2 ms（逐条写话单、认领登记、写流水、更新余额缓存）；硬件或租户数据量不同，持锁时间会不同，上线前要在目标机器上复测。
- **`audit_operation_logs` 变更牵动审计角色的权限断言。** 函数返回列变了，要 `DROP` 重建并重新授权，`audit.db.test.ts` 里有对 ACL 文本的精确断言，漏改会失败。
- **已分配的话单不可撤销。** 不在 plan 范围；分配错租户只能用调账冲正。
- **多实例。** 阶段 3 遗留的「pg-boss 关闭 advisory locking 假设单实例」（`plan.md:349`）同样约束归档任务；归档靠 `singletonKey` 和 `PRIMARY KEY (month)` 避免重复，但两个实例同时写同一个 `.partial` 文件没有防护，PR 3 用独占创建（`wx` 标志）。
- **分区测试的根因尚未找到。** 若原因是业务代码里的锁等待（而不是测试夹具），修复可能改动 `ensure_month_partition`，影响阶段 2、3 已验收的行为，需要重跑相关测试。

## 待用户确认

无。原先的 14 个问题已由用户 2026-10-23 回答，全部采用推荐项，见[已决定](#已决定)第 31 至 44 项。

## 本步验证

2026-10-23 在本机验证了以下事实，没有实现代码，没有运行 `pnpm check`，没有运行任何测试。

- **种子核对。** 在开发库 `fs_billing`（Docker 里的 `fs-billing-postgres-1`）上以 owner 身份只读查询：`unassigned_cdrs` 仅 1 行（`ABC01`，租户不存在，`pending`）；`raw_cdrs` 0 行，分区 `raw_cdrs_2026_08` 至 `_11`；`cdrs` 25,367 行；ABC001 余额 −35.200，8、9 月账单 `reconcile_status = 'unchecked'`、`details_deleted = false`；`operation_logs` 除主键外无索引，列为 `id, admin_id, tenant_id, action, target, details, created_at`；`unassigned_cdrs` 的约束名（`unassigned_cdrs_status_check`、`unassigned_cdrs_status_shape` 等）与 `system_alerts_kind_check` 已核对。
- **代码事实。** 逐个读了 `apps/worker/src/{ingest,charge,queue,reconcile,maintenance,main,config}.ts`、迁移 0000–0004、0011、0014、0017、`packages/db/src/{schema,ledger,client,partitions,cdr-query,admin/audit,admin/balance,statements/*}`、`packages/shared/src/api/admin/{audit,contract,errors}.ts`、`apps/api/src/auth/{admin-accounts,bootstrap}.ts` 及 `scripts/bootstrap-credential.ts`、`apps/web` 的导航与话单标签页、`packages/rating/src/{rates,dialed.test}`。文中引用的路径、表名、列名、约束名均来自这些文件。
- **设计稿。** 读了未归属话单原型与删除话单原型的模板和数据脚本，`第三批 · 运营` 的未归属话单与操作日志部分，`第三批 · 租户详情` 的删除话单对话框。设计稿是带模板的 HTML，没有渲染截图，字段与文案取自模板与脚本源码。
- **费率匹配。** 读 `longestPrefix` 确认是最长前缀、`versionAt` 按接通时刻取版本：删掉 `1876` 后 `1876…` 会落到前缀 `1`。
- **Node。** 本机 Node 是 v22.23.2（项目要求 24.22.1）：`zlib.zstdCompressSync` 与 `createGzip` 都存在；Node 24 上未验证。
- **未验证。** 迁移、任务、API、页面均未实现；`DETACH PARTITION` 在 `SECURITY DEFINER` 函数里的行为与锁影响、对 `raw_cdrs` 写入的阻塞时间、`CONCURRENTLY` 在函数里不可用的推断、`FOR UPDATE` 在读已提交下重新计算条件的行为、分区测试偶发超时的根因、`ASSIGN_MAX_ROWS` 与各项耗时、`businessDb` 是否满足 `ensureCdrPartitions` 的 `PoolDb` 类型、授权接口是否等待租户锁，均未验证。

## PR 1 实现时的验证与偏差

2026-10-23 PR 1 落地时核对的、本文原先标为「未验证」的假设，和与本文不同的地方：

- **`FOR UPDATE` 重新判断条件。** 读已提交下，被另一个事务持有行锁的待处理话单，在对方把它改成 `ignored` 并提交后，等待的分配重新判断 `status = 'pending'`，看不到这些行，得到 `UNASSIGNED_NOTHING_TO_ASSIGN`（`assign.db.test.ts` / `a row locked by another request and resolved meanwhile is not assigned afterwards`）。
- **`businessDb` 满足 `PoolDb`。** `apps/api/src/app.ts` 的 `businessDb: PoolDb`，`main.ts` 传的是 `connect()` 返回的连接池数据库；PR 4 的分配处理器直接传它，`ensureCdrPartitions` 不需要别的类型。
- **授权接口不等租户锁。** `apps/worker/src/app.ts` 的 `/authorize` 只读缓存余额，不调用 `lockTenants`；测试里持租户锁并已改过余额缓存行的事务没有挡住 `loadRatingTenant`。
- **入库与扣费复核已删除标志。** 复核放在共享函数 `priceAndInsertCdr` 与 `chargeCall` 里，都在租户锁之后；`cdr-intake.db.test.ts` 用「删除事务持锁、入库等待」的顺序验证拿到锁之后读到的是最新已提交的标志。`chargeCall` 遇到已删除月份抛 `CdrMonthDeletedError`（任务失败，对账告警），不写流水。
- **审计 variants 提前到 PR 1。** 分配、忽略、删除要在同一事务里写操作日志，`unassigned_assignments.audit_id` 也要有值，所以 `packages/shared/src/api/admin/audit.ts` 的四个 action（`unassigned_assign`、`unassigned_ignore`、`unassigned_unignore`、`cdr_delete`）、`target.kind: 'unassigned_batch'`、变更字段 `balance`、`callCount` 在 PR 1 加；`credential_bootstrap` 与 `actor` 的 `{ label }` 联合仍在 PR 4。`system_alerts.kind` 的 `audit_failed`、`raw_archive_failed` 两个值都在迁移 0018 里加。
- **业务错误码。** PR 1 的数据库函数抛 `UnassignedError`、`CdrDeletionError`（带 `code`，沿用阶段 7 `StatementError` 的做法），不依赖 `adminConflictCodeSchema`；PR 4 把它们映射成 API 的 409 / 400。
- **`unassigned_assignments.request_digest`。** 幂等重放要核对「同一份选择与 expected」，原表没有可比较的列，加了这一列。
- **跨月删除的第一个月失败。** 没有任何月份被删时直接抛错；已有月份完成后失败，返回 `months / remaining / failure`，不抛。
- **删除预检用快照读。** 预检是一个 `repeatable read` 只读事务，账单行的标志和话单条数取自同一时刻；否则另一个管理员恰好在两条语句之间提交删除时，会读到「标志未置而话单已没」的混合状态。
- **月份列表的耗时。** 一整年 12 个月在 PORTALBIG 上约 2.5 s（最初把「有费用而无流水」写成逐行 `NOT EXISTS` 的聚合过滤，约 7–10 s，改为 `WHERE NOT EXISTS` 的反连接后降到约 2.5 s）；耗时与该年话单行数成正比，页面可以只在打开删除对话框时请求。
