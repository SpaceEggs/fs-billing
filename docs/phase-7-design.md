# 阶段 7 设计：月账单

## 范围与依据

本文档最初只是设计（PR 0），后来由 PR 1 至 PR 6 实现；各 PR 的进度见[PR 拆分](#pr-拆分)之后的进度小节，阶段 7 的验收在 PR 6 逐项核对，见[验收记录](evidence/phase-7/README.md)。以下正文保留设计时的表述（历史核对、「本步验证」等不改写）。范围取自 [plan.md 阶段 7](plan.md#阶段-7月账单)（`docs/plan.md:277-296`）。

- 账单生成任务：每月 1 日凌晨（北京时间）生成上月账单；期初 + 充值（含赊账）+ 赠送 ± 调账 − 通话扣费 = 期末；按国家、按日汇总。
- 管理员手动重新生成，已删除话单的月份禁止重新生成。
- 门户：月账单列表与详情、CSV 导出。
- 后台：账单页面、租户详情的账单标签页。

业务规则依据 [design.md §9](design.md#9-月账单)（`docs/design.md:344-349`）、[§13.1 与 §13.2](design.md#131-话单永久保存)（`docs/design.md:386-402`）、[§14 第 1 项](design.md#14-其他约定)（`docs/design.md:420`）、[pages.md](pages.md) §2.4、§2.5（`docs/pages.md:155-172`）、后台租户详情行（`docs/pages.md:249`）、删除话单对话框（`docs/pages.md:272-283`）、后台账单页（`docs/pages.md:318-324`），以及设计稿 `design/设计系统规范确认/` 下的 `客户门户 第二批.dc.html`（月账单）、`管理后台 第三批 · 运营.dc.html`（账单，第 412-490 行）、`管理后台 第三批 · 租户详情.dc.html`（账单标签页，第 173-200、349-357 行）、`管理后台 删除话单原型.dc.html`。账本不变量取自 [phase-2-db.md](phase-2-db.md)，合并流水、北京日、CSV 流式导出、IDOR 约定取自 [phase-6-design.md](phase-6-design.md)，Worker 任务模式取自 [phase-3-worker.md](phase-3-worker.md) 和 `apps/worker/src`。

设计稿与文档不一致、文档没有规定的地方，原先列为 11 个待确认问题；用户 2026-10-22 全部回答，均采用推荐项，已写入[已决定](#已决定)第 20 至 30 项并更新相关章节。设计稿的处理见[设计稿与 pages.md 的差异](#设计稿与-pagesmd-的差异)。当前没有待用户确认的问题。

## 现状核对

### 仓库里已经有什么

| 事实                                                                                                                                                                                                                                                        | 出处                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `monthly_statements` 表已在 0000 建好：期初、充值、赠送、调账、通话扣费、期末、通话分钟、`details_deleted`、`generated_at`，`UNIQUE (tenant_id, month)`，`month` 必须是 1 日，`monthly_statements_balanced` 检查期末 = 期初 + 充值 + 赠送 + 调账 − 通话扣费 | `packages/db/migrations/0000_init.sql:586-603`、`packages/db/src/schema.ts:278-291`              |
| 该表没有任何代码使用，只出现在迁移、RLS 改写、性能脚本和 drizzle schema 里                                                                                                                                                                                  | `grep monthly_statements apps packages`：`0015_rls_initplan.sql:41`、`schema.ts`、`scripts/*.ts` |
| 缺少本设计需要的：通话数、版本、首次生成时间、生成人、按国家与按日明细、核对状态                                                                                                                                                                            | 同上                                                                                             |
| 表的 RLS 与权限：`tenant_read`（0015 已改成 InitPlan 形式）、`operator_insert/update/delete`，应用角色有 `SELECT, INSERT, UPDATE`，没有 `DELETE`                                                                                                            | `0000_init.sql:658-694`、`0015_rls_initplan.sql:41-44`                                           |
| 流水五种类型 `recharge`、`credit_recharge`、`gift`、`adjustment`、`call_charge`，索引 `(tenant_id, occurred_at)`；人工流水 `occurred_at = created_at`，通话扣费 `occurred_at` 为接通时间                                                                    | `0000_init.sql:251-272`、`phase-2-db.md:61`、`apps/worker/src/charge.ts:45`                      |
| 通话扣费一通一笔，幂等键 `call:<UUID>`，费用为 0 的通话不写流水                                                                                                                                                                                             | `apps/worker/src/charge.ts:36-49`、`phase-2-db.md:379`                                           |
| `cdrs` 按 `started_at` 月分区，已接通话单必须有国家、费率；索引 `(tenant_id, answered_at)` 与 `(tenant_id, started_at)`                                                                                                                                     | `0000_init.sql:427-455`、`0010_cdrs_tenant_started_at.sql:6`                                     |
| `system_alerts.kind` 只允许 `auth_timeout`、`cdr_failed`、`email_failed`、`partition_failed`；Worker 的 `recordAlert` 类型只接受 `cdr_failed` 与 `partition_failed`                                                                                         | `0000_init.sql:620-628`、`apps/worker/src/ingest.ts:35-46`                                       |
| `operation_logs.admin_id` 非空，系统任务写不了操作日志；审计 `target.kind` 枚举没有账单                                                                                                                                                                     | `0000_init.sql:605-616`、`packages/shared/src/api/admin/audit.ts:70-79`                          |
| pg-boss 队列只能由 owner 脚本预建，运行时 `migrate: false`；定时任务用 `tz: 'Asia/Shanghai'`                                                                                                                                                                | `apps/worker/src/queue.ts:38`、`queue.ts:85-95`、`maintenance.ts:34`、`reconcile.ts:102`         |
| 门户导航没有月账单，后台导航没有账单，租户详情标签页没有账单                                                                                                                                                                                                | `apps/web/src/components/app-shell.tsx:13-26`、`apps/web/src/lib/admin-search.ts:79-86`          |
| 阶段 6 已留出接口：月账单有了之后，合并流水的锚点可以改用最近一张月账单                                                                                                                                                                                     | `docs/phase-6-design.md:354`（本设计不采用，理由见[决定 18](#已决定)）                           |
| 门户首页和后台概况的「本月消费」是流水里本月通话扣费的合计，进行中月份的账单必须与它一致                                                                                                                                                                    | `packages/db/src/usage.ts:9-19`                                                                  |

### 种子数据核对（验收标准 1）

在本机开发库 `fs_billing` 上用只读 SQL 核对（`docker exec … psql`，只有 `SELECT`）。ABC001 的流水按 `occurred_at` 的北京月份汇总：

| 月份    | 类型              | 笔数 | 合计      |
| ------- | ----------------- | ---- | --------- |
| 2026-09 | `recharge`        | 1    | 1,931.10  |
| 2026-09 | `credit_recharge` | 1    | 500.00    |
| 2026-09 | `gift`            | 2    | 40.00     |
| 2026-09 | `adjustment`      | 1    | −20.00    |
| 2026-09 | `call_charge`     | 28   | −2,486.30 |

流水合计 −35.20（33 笔），`monthly_statements` 为空，ABC001 的话单只有 3 条（2026-09-28）。**种子不能产出验收标准 1 写的数字。** 逐项对照：

| 项目     | 设计稿 8 月 | 种子 8 月 | 设计稿 9 月 | 种子 9 月                       |
| -------- | ----------- | --------- | ----------- | ------------------------------- |
| 期初     | 0.00        | 无流水，0 | 1,176.60    | 0.00                            |
| 充值     | 3,000.00    | 0         | 1,300.00    | 2,431.10（1,931.10 + 赊账 500） |
| 赠送     | 50.00       | 0         | 0.00        | 40.00                           |
| 调账     | 0.00        | 0         | −25.50      | −20.00                          |
| 通话扣费 | 1,873.40    | 0         | 2,486.30    | 2,486.30                        |
| 期末     | 1,176.60    | 0         | −35.20      | −35.20                          |

只有 9 月的通话扣费与期末对得上，两个月的其余数字都不同；8 月在种子里不存在。种子里 ABC001 的 9 月流水来自后台设计稿（赠送两笔各 20.00、冲正 −20.00，`seed.ts:198-292`，[设计稿](../design/设计系统规范确认/管理后台%20原型.dc.html) 第 368-369 行），月账单设计稿来自客户门户第二批（充值 800.00 + 500.00、冲正 −25.50，`客户门户 第二批.dc.html:629-633`），两份设计稿对 ABC001 的 9 月描述不是同一份流水。另外种子没有设置 `tenants.created_at`，ABC001 的创建时间是播种时刻（开发库里为 2026-10-22），晚于全部流水，而设计稿写「创建于 2026-08-12」。种子的通话扣费是按日汇总的流水，不是逐通流水，也没有对应话单（`phase-2-db.md:372`），所以按国家、按日明细在种子上是空的。用户 2026-10-22 决定改种子（[决定 20](#已决定)，做法见[种子](#种子决定-20)）。

设计稿月账单数字（单位分，取自 `客户门户 第二批.dc.html:592-593`）：

| 月份 | 期初   | 充值   | 赠送 | 调账  | 通话扣费 | 期末   | 分钟  | 通话数 |
| ---- | ------ | ------ | ---- | ----- | -------- | ------ | ----- | ------ |
| 9 月 | 117660 | 130000 | 0    | −2550 | 248630   | −3520  | 49726 | 12804  |
| 8 月 | 0      | 300000 | 5000 | 0     | 187340   | 117660 | 37468 | 9642   |

两月的国家表之和与合计一致（9 月 192380 + 22500 + 12600 + 9100 + 5100 + 4200 + 2000 + 750 = 248630，通话 12804，分钟 49726），已核对。

### 设计稿与 pages.md 的差异

| 项目               | pages.md                                                                 | 设计稿                                                                                                                                                        | 处理                                                               |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 国家表列           | 国家（只按国家分组，不含说明）、通话数、计费分钟、费用（`pages.md:169`） | 列头「国家/备注」，多一列「占比」，行里有「英国手机」「英国」两行（`第二批.dc.html:223-229, 595`）                                                            | 决定 21：按 pages.md，列头「国家」，英国手机并入英国，保留「占比」 |
| 按日汇总的天数     | 日期、通话数、计费分钟、费用                                             | 标题带「29 天」「20 天」，8 月从开户日 12 日起，每天一行（`第二批.dc.html:233, 625-626`）                                                                     | 决定 23：区间内每天一行，补零                                      |
| 进行中月份         | 列表显示「本月（进行中）」，数据实时更新（`pages.md:161`）               | 同，详情有「截至 2026-09-29 14:03:22 · 实时更新」和「2026-10-01 凌晨生成正式账单」                                                                            | 实时计算，不落库（决定 14）                                        |
| 空状态             | 无                                                                       | 「还没有账单」，副文案却说「本月账单会实时显示在这里」（`第二批.dc.html:333-334, 353-354`）                                                                   | 决定 22                                                            |
| 打印               | 操作含「打印」                                                           | 有「打印」按钮                                                                                                                                                | 决定 29：做，`window.print()`                                      |
| 后台账单页月份     | 选择月份                                                                 | 默认上月，「›」到上月即置灰，进行中月份不可选（`运营.dc.html:428, 818`）                                                                                      | 照设计稿                                                           |
| 后台账单页重新生成 | 「重新生成（例如补推话单后）」                                           | 行内有「重新生成」，话单已删除的行置灰并提示，生成时间下面可有「已重新生成 · 原 09-01 02:00」（`运营.dc.html:441-444, 814`）                                  | 照设计稿，见决定 11、27、30                                        |
| 租户详情账单标签页 | 同门户，另有「重新生成」                                                 | 表格多一列「操作」，进行中月份的重新生成置灰并写「进行中，月结后可重新生成」，话单已删除写「话单已删除，无法重新计算」（`租户详情.dc.html:577-579, 593-594`） | 照设计稿                                                           |
| 删除话单月份选择   | 只能选已生成月账单的月份                                                 | 当月提示「本月账单尚未生成（2026-10-01 生成后可选）」（阶段 8）                                                                                               | 阶段 8 使用本阶段的账单存在性                                      |

## 数据定义

### 北京月边界

账单月份存为 `date`（该月 1 日，`monthly_statements.month`，已有检查约束）。月份区间是半开区间，由 SQL 换算，沿用阶段 6 的做法（`phase-6-design.md:135`，`packages/db/src/ledger-merge.ts:68-70`）：

```sql
lo = ($month::date)::timestamp AT TIME ZONE 'Asia/Shanghai'
hi = (($month::date + interval '1 month'))::timestamp AT TIME ZONE 'Asia/Shanghai'
```

2026-09 对应 UTC `2026-08-31 16:00+00` 至 `2026-09-30 16:00+00`。账单与核对一律按流水的 `occurred_at`，不按 `created_at`：9-30 23:59 接通、10-01 00:00:30 才写入的扣费归 9 月（`phase-2-db.md:61, 366`）。`created_at` 只在核对时用来判断「这笔流水是不是生成之后才写入的」，不参与归属。

### 各项如何取数

头部六个数全部来自流水，所以与余额同源：

| 账单项   | 流水来源                                                    | 符号                                               |
| -------- | ----------------------------------------------------------- | -------------------------------------------------- |
| 期初余额 | `occurred_at < lo` 的全部流水金额合计，没有流水为 0         | 带符号，可为负                                     |
| 充值     | `kind IN ('recharge', 'credit_recharge')`、区间内的金额合计 | 恒 ≥ 0（流水检查 `amount > 0`）                    |
| 赠送     | `kind = 'gift'`                                             | 恒 ≥ 0                                             |
| 调账     | `kind = 'adjustment'`，**带符号**求和                       | 可正可负；赊账作废产生的反向调账也在这里（阶段 5） |
| 通话扣费 | `-sum(amount)`，`kind = 'call_charge'`                      | 恒 ≥ 0，账单里存正数、公式里减去                   |
| 期末余额 | 期初 + 充值 + 赠送 + 调账 − 通话扣费                        | 由表上的检查约束保证                               |

赊账充值并入「充值」，对客户和后台都不区分（`design.md:348`、`pages.md:168`、设计稿后台账单页只有一列「充值」）。若某赊账后来被反向调账冲正，账单里充值和调账各显示一笔，净额为零，不做抵消。期末余额等于 `occurred_at < hi` 的流水合计，这是核对任务检查的恒等式。

期初不取上一张账单的期末，而是直接对流水求和。取上月期末会把上月的任何过期错误带进来；用流水求和，每一月的期初都是账本当时的事实，上月是否过期由核对任务单独发现。

### 通话数、计费分钟、按国家、按日

这三项只在话单里有（流水没有国家，也没有分钟）：

| 汇总         | 来源                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------- |
| 通话数       | 已接通话单条数，按 `answered_at` 的北京月/日归属，跨午夜、跨月电话归接通时刻（`design.md:315`） |
| 计费分钟     | `sum(billed_minutes)`                                                                           |
| 按国家的费用 | `sum(charge)`，按 `country` 分组（不含说明，阶段 6 决定 39，`phase-6-design.md:702`）           |
| 按日的费用   | `sum(charge)`，按 `(answered_at AT TIME ZONE 'Asia/Shanghai')::date` 分组                       |

话单查询带 `started_at` 区间下界（`lo` 往前 31 天）以裁剪分区，沿用阶段 6（`phase-6-design.md:161`）；一通电话 9-30 23:59:50 振铃、10-01 00:00:05 接通，在 10 月的账单里（接通时刻在 10 月，流水 `occurred_at` 也在 10 月）。

头部与明细的关系：**头部来自流水，明细来自话单**，二者由同一个快照事务读出，各自独立，不互相推导。理想情况下 `sum(国家费用) = sum(日费用) = 通话扣费`。它可能不等的原因：

- 话单已入库而扣费流水未入账（队列延迟），或话单费用为 0（不写流水，对通话数有影响）。
- 振铃超过 31 天的话单落在下界之外（`phase-6-design.md:169, 670`）。
- 种子里的汇总流水没有对应话单（`phase-2-db.md:372`）。
- 话单被删除之后（阶段 8），但那时已禁止重新生成，明细不再变化。

所以账单记录一个 `breakdown_gap = 通话扣费 − sum(国家费用)`，生成时算出并存下，后台详情显示它。它不为零不阻止生成，也不触发流水核对告警（流水核对只看恒等式）。通话数取已接通话单条数，含 0 元通话、不含未接通（决定 24）；阶段 6 流水合并行的「共 N 通」仍是有扣费流水的通话数，两处口径不同，0 元通话只出现在前者。

在某个性能库月份上，两个数是相等的：PORTALBIG 2026-09 话单 `sum(charge)` = 流水 `call_charge` 合计 = 23,864.4270，234,277 笔对 234,277 条。

### 金额精度与显示

流水金额是不限精度的 `numeric`，通话扣费可有 4 位小数（费率 4 位 × 整分钟），调账最多 4 位（`design.md:275`）。账单存精确值，不在生成时舍入，否则等式 `期末 = 流水合计` 不成立。页面用现有 `Money` 组件按 2 位四舍五入显示（`apps/web/src/components/data-format.tsx`），分项分别舍入后相加可能与舍入后的期末差 0.01。这在阶段 6 的余额流水里已经存在，用户决定不处理（决定 26）。

### 示例

用设计稿的数字走一遍。8 月：期初 0.00 + 充值 3,000.00 + 赠送 50.00 + 调账 0.00 − 通话扣费 1,873.40 = 1,176.60。9 月：期初 1,176.60（不是 8 月账单的存值，而是 `occurred_at < 9 月 1 日` 的流水合计，两者在账本一致时相同）+ 充值 1,300.00 + 赠送 0.00 − 25.50 − 2,486.30 = −35.20，等于当前余额，也等于后台设计稿里的 −¥35.20。

## 表结构与迁移

迁移文件 `packages/db/migrations/0017_monthly_statements.sql`（编号以合并时为准），一个迁移，随 PR 1。已有表改列，新增两张明细表。上线前开发库可以直接改，不需要数据回填（`monthly_statements` 无生产数据）。

### `monthly_statements` 改列

| 列                   | 类型与约束                                                                                    | 用途                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `calls`              | `integer NOT NULL DEFAULT 0 CHECK (calls >= 0)`                                               | 通话数，列表与详情显示「12,804 通」（`第二批.dc.html:214`）                     |
| `version`            | `integer NOT NULL DEFAULT 1 CHECK (version >= 1)`                                             | 每次重新生成加 1，明细行按它区分                                                |
| `first_generated_at` | `timestamptz NOT NULL DEFAULT now()`                                                          | 设计稿后台「已重新生成 · 原 09-01 02:00」需要原始生成时间（`运营.dc.html:814`） |
| `generated_by`       | `uuid REFERENCES admins`，空表示定时任务                                                      | 最近一次生成的人，后台详情显示                                                  |
| `breakdown_gap`      | `numeric NOT NULL DEFAULT 0`                                                                  | 见上节                                                                          |
| `reconcile_status`   | `text NOT NULL DEFAULT 'unchecked' CHECK (… IN ('unchecked', 'ok', 'stale', 'inconsistent'))` | 核对结果，见[核对任务](#核对任务)                                               |
| `reconciled_at`      | `timestamptz`                                                                                 | 最近一次核对时间                                                                |
| `reconcile_diff`     | `numeric`                                                                                     | 流水合计减账单期末                                                              |
| 唯一约束             | `UNIQUE (id, tenant_id)`                                                                      | 明细表的复合外键，与 `receivable_settlements` 的写法一致（`phase-2-db.md:41`）  |

已有的 `UNIQUE (tenant_id, month)` 保证同一租户同一月份只有一行。`generated_at` 保存最近一次生成时间，`first_generated_at` 保存第一次，后台「生成时间」列显示前者。

### 明细表

`monthly_statement_countries (statement_id, tenant_id, version, country, calls, minutes, charge)`，主键 `(statement_id, version, country)`；`monthly_statement_days (statement_id, tenant_id, version, day date, calls, minutes, charge)`，主键 `(statement_id, version, day)`。两张表的 `(statement_id, tenant_id)` 外键指向 `monthly_statements (id, tenant_id)`，保证明细的租户与账单一致。`calls >= 0`、`minutes >= 0`、`charge >= 0`。只存有通话的国家与日期，没有通话的日子在读取时补零（决定 23）。

**版本语义。** 重新生成时头部原地 `UPDATE`（`version + 1`，新数字），同一事务里**追加**新版本的明细行，旧版本的明细行保留。读取只取 `version = 头部当前版本` 的明细。这样做有三个理由：明细表保持只增，不需要给应用角色加 `DELETE`；头部和明细版本在一次提交里翻转，读者不会看到新头部配旧明细；旧明细留作排查依据。旧头部数字不保留在表里，前后差异由重新生成的操作日志保存（`before` 与 `after`，见[手动重新生成](#手动重新生成)）。备选是单独建 `monthly_statement_versions` 头部历史表，成本是多一张表和一套读取路径，而操作日志本来就要记前后差异，所以没有采用。

明细的行数很小（国家几十个，日期至多 31 个），不另建索引，主键覆盖读取。

### 行级安全与权限

两张明细表照 0000 的 `DO` 块建四条策略（`0000_init.sql:658-681`）：`tenant_read` 直接写成 0015 的 InitPlan 形式，`operator_insert`、`operator_update`、`operator_delete` 同 0000。权限只授予应用角色 `SELECT, INSERT`（不给 `UPDATE`、`DELETE`），再加 `reject_mutation()` 触发器拒绝 `UPDATE/DELETE/TRUNCATE`（与 `operation_logs` 同形，`0000_init.sql:605-616`）。`monthly_statements` 的 RLS 与授权不变。门户身份只能 `SELECT` 本租户的行，任何写入被策略拒绝。

### `monthly_statements` 的守卫触发器

`BEFORE UPDATE` 触发器 `monthly_statements_guard`，为「已删除话单的月份不能重新生成」提供数据库层防线（`design.md:394-402`，不依赖任何用户决定）：

- `id`、`tenant_id`、`month` 不可改。
- `details_deleted` 只能由 `false` 变 `true`，不可回退。
- 旧行 `details_deleted = true` 时，禁止修改六个金额、`calls`、`call_minutes`、`version`、`generated_at`、`generated_by`；核对列（`reconcile_*`）仍可更新。
- 金额或明细相关列变化时，`version` 必须恰好加 1。

阶段 8 删除话单时在同一事务里把对应月份的 `details_deleted` 置 `true`（见[为阶段 8 预留什么](#为阶段-8-预留什么)）。

### `system_alerts` 的告警类型

用户确认（决定 27）：把 `statement_mismatch` 加入 `system_alerts.kind` 的检查约束，同一个迁移里 `DROP CONSTRAINT` 再 `ADD CONSTRAINT`（约束定义在 0000 的列内联检查里，约束名需要在迁移前核对实际名称）。

### 种子（决定 20）

用户 2026-10-22 确认把 ABC001 的种子改成月账单设计稿，验收 1 的数字因此按字面成立。PR 1 的种子内容：

- **租户。** `tenants.created_at` 回填 2026-08-12（owner 连接，触发器不限制，`phase-2-db.md:366`），详情里「2026-08-12（开户）至 2026-08-31」据此得出。
- **人工流水。** 8 月：充值 3,000.00、赠送 50.00（具体时间设计稿没写，PR 1 自定）。9 月：充值 800.00（09-10 14:20:08，备注「银行转账 · 招行尾号 6621」）、赊账充值 500.00（09-23 10:15:36，内部备注保留「月结，10月5日前付款」，门户显示「账户充值」）、调账 −25.50（09-26 16:20:41，「9月25日重复扣费冲正」），见 `客户门户 第二批.dc.html:629-633`。现有种子 9 月的 1,931.10 充值、两笔各 20.00 赠送和 −20.00 冲正删除，后台余额流水设计稿里的赠送与冲正行不再出现。
- **通话。** 8 月 12 至 31 日 9,642 通、37,468 分钟、1,873.40；9 月 1 至 29 日 12,804 通、49,726 分钟、2,486.30，其中 9-29 当天 42.10 截至 14:03:22（`第二批.dc.html:592-593, 621-625`）。每通一条话单加一笔流水，不再是按日汇总的流水，所以合并流水行的「共 N 通」也变成真实通数。流水用生产的幂等键 `call:<uuid>`（`callChargeKey`，`packages/db/src/ledger.ts:29`），`occurred_at` 取接通时间，`created_at` 取接通后数秒。不能沿用种子现在的 `seed:` 键，因为 Worker 的补扣对账按 `call:<uuid>` 找缺失流水，近 30 天内有费用而没有该键的话单会被再扣一次（`apps/worker/src/reconcile.ts:25-28`）。
- **国家与日分配。** 国家合计（通话、分钟、费用）与设计稿国家表逐项相等。各国单价正好是费用除以分钟的整除结果（中国 0.05、牙买加 0.25、英国手机 0.045、日本 0.035、香港 0.03、新加坡 0.028、英国 0.02、美国/加拿大 0.01，8 月、9 月相同），PR 1 核对 ABC001 的种子费率表含这些单价，缺的补上，不改 447 在 10-01 变价的现有断言（`packages/db/src/rates.db.test.ts:473`）。日费用与设计稿一致：9-23 至 9-28 沿用现有种子的 86.05、83.48、90.12、85.90、81.27、88.64，9-29 为 42.10，其余日期按设计稿的确定性规则。设计稿的日分钟与日通话数是脚本加噪声生成的，要同时满足国家单价、日费用和各合计，不一定有整数解，所以只要求各合计和日费用精确，日分钟与日通话数逐日取最接近的可行值，偏差记入差异清单。可行性由 PR 1 先用小脚本验证，若日费用也无解，回到用户确认。
- **示例话单。** ABC001 现有 3 条示例话单（9-28 的英国手机、牙买加两通已接通，一通未接通）并入 9 月的分配，补写它们缺的扣费流水，使 `breakdown_gap` 为 0；未接通那条不计入通话数。
- **幂等。** 话单与流水的 UUID 由租户、月份、序号确定地算出，`ON CONFLICT DO NOTHING`，重复 `db:seed` 不增行。
- **账单。** 种子脚本最后调用与定时任务相同的生成函数，产出 8 月、9 月两张账单。

PR 1 要同步更新的现有测试与文档（对种子数字 grep 得出，PR 1 以全仓 grep 复核为准）：

| 文件                                                                 | 受影响的断言                                                                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/ledger.db.test.ts:58, 235-245`                      | 33 笔流水、9 月 28 笔扣费合计 −2486.30                                                                                                                     |
| `apps/web/e2e/portal-ledger.spec.ts:19-52`                           | 合并行数 26、「2026-09-28 通话扣费，共 1 通」、9-28 话单页 3 行（当天现在有数百通）、充值合计 +¥2,431.10、赠送 +¥40.00（9 月不再有赠送）、第二页「第 26–」 |
| `apps/web/e2e/portal-home.spec.ts:60-76`                             | 最近话单 3 行（9-28 两通已接通）；现在最近 10 通是 9-29 14:03 之前的话单                                                                                   |
| `apps/web/e2e/portal-home.spec.ts:80`                                | 「月账单」导航 `toHaveCount(0)`，PR 4 加导航时翻转                                                                                                         |
| `docs/phase-2-db.md:115, 126, 230, 372`                              | 33 笔、28 笔扣费、「按日汇总的流水」「5 条示例话单」                                                                                                       |
| `apps/web/.agents/skills/verify/features/db-seed.md`、`db-ledger.md` | 种子计数（`seed:` 键流水 88 条、5 条话单）、ABC001 33 笔                                                                                                   |
| `docs/evidence/phase-6-web/visual-diff.md` R5 与第 58 行             | 「种子话单只有 2 通已接通、都在 9 月 28 日」不再成立，以带日期的附注更新，不改写历史证据                                                                   |

不需要改的：阶段 5 的 `tenant-ledger` 视觉对照，区间是当前月 10 月（`docs/evidence/phase-5-web/visual-diff.md:63`），当时的截图不含 9 月的赠送、冲正行；PR 1 重拍时确认。`docs/evidence/phase-2/acceptance.txt` 等历史运行输出保持原样，不重写。

`ABC001` 余额仍为 −35.20，所以首页、`balance_discrepancies` 与余额相关的断言不变。

## 生成任务

### 谁来生成、何时生成

| 项目       | 设计                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 调度       | `boss.schedule('generate-statements', '0 2 * * *', null, { tz: 'Asia/Shanghai' })`，每天 02:00 运行，不只在每月 1 日（决定 7）                                                                                                                                |
| 为什么每天 | pg-boss 的 cron 不补发错过的触发。只在 1 日运行，那天 Worker 停机就整月缺账单。每天运行、只补缺失的月份，1 日自然生成上月，其余日子是空操作                                                                                                                   |
| 时刻       | 02:00，与设计稿「账单生成于 2026-09-01 02:00:15」一致（`第二批.dc.html:626`、`运营.dc.html:801-806`）。分区维护在 00:00（`maintenance.ts:34`），错开；也给最后一天的在途扣费留 2 小时                                                                         |
| 哪些租户   | 所有租户，包括已停用的，包括没有任何活动的（设计稿 CDT018 一行全零，`运营.dc.html:801`）。一个租户第一个应有账单的月份是 `min(tenants.created_at, 最早流水 occurred_at)` 所在的北京月。取最小值是因为种子的 `created_at` 晚于流水，也容忍管理员回填的历史流水 |
| 哪些月份   | 第一个应有月份到上一个北京月，已有账单的跳过。补缺数量由 `STATEMENT_BACKFILL_MONTHS`（默认 24）限制，更早的缺口靠管理员「重新生成」补建                                                                                                                       |
| 只建不改   | 定时任务只**创建**缺失的账单，绝不覆盖已有账单（决定 9）。验收标准 4 的「重复执行结果相同」由此直接成立；覆盖只有管理员重新生成一条路径                                                                                                                       |

### 扇出与并发

沿用 `reconcile.ts` 的模式（`apps/worker/src/reconcile.ts:93-105`、`queue.ts:44-61`）：

1. 父任务 `generate-statements` 在 `withSystem` 里列出缺失的 `(租户, 月份)`，在同一事务里逐个 `boss.send('generate-statement', {tenantId, month}, {singletonKey: '<租户>:<月份>', id: <由租户与月份推出的确定性 UUID>, db: fromDrizzle(tx)})`，写法同 `chargeQueue.enqueue`。父任务重跑不会产生第二个子任务。
2. 子任务 `generate-statement` 处理一个租户一个月，`localConcurrency` 默认 2（`WORKER_STATEMENT_CONCURRENCY`），`retryLimit: 3`。失败抛出，由 pg-boss 重试，仍失败则任务进入 failed 状态，次日父任务会再补一次，核对任务也会报告缺失。
3. 队列 `generate-statements`、`generate-statement`、`reconcile-statements` 必须加入 `installQueue` 的 `createQueue`（`queue.ts:85-95`），部署时重新执行 `pnpm --filter @fs-billing/worker queue:migrate`（`apps/worker/package.json:10`）。运行时应用角色不能建队列。这条要写进阶段 10 的运维手册。

### 单个账单的事务

子任务在 `withSystem` 里用 **`REPEATABLE READ`** 事务生成：同一个快照里读流水合计、话单汇总，再写头部与明细。这样头部和明细是同一时刻的账本，不会被两条语句之间提交的扣费撕裂。`withOperator` 现在只接受 `serializable`（`packages/db/src/client.ts:155-202`）；PR 1 给 `withSystem` 增加 `repeatable read` 配置，因为 `SET TRANSACTION ISOLATION LEVEL` 必须在事务第一条语句之前，而 `withOperator` 的第一条语句就是 `set_config`。不使用 `serializable`，避免 SSI 冲突误伤并发扣费。

**不拿租户锁。** 租户锁保护的是写流水和写费率（`packages/db/migrations/0000_init.sql:104-118` 的租户锁说明）。生成只读流水与话单、只写账单表，不需要锁；拿锁反而会让该租户的扣费排队等一次最长约 1 秒的扫描。快照事务已经保证读到一致的账本。

写入顺序：`INSERT INTO monthly_statements … ON CONFLICT (tenant_id, month) DO NOTHING RETURNING id`，没有返回行（已被并发的另一次抢先）就直接结束，不写明细；有返回行再写国家与日期明细。并发两次运行，一次成功一次空操作，或其中一次因 `REPEATABLE READ` 下看不到刚提交的冲突行而收到 `40001`，由 `withOperator` 的重试收敛（`client.ts:176-202`）。PR 1 的并发测试验证这一点，不预设结论。

### 话单补推与迟到

FreeSWITCH 在 Worker 不可用时把话单落盘，恢复后重推（`design.md:179`、`freeswitch.md:66`），迟到的扣费仍按接通时刻的 `occurred_at` 落回原月份（`phase-2-db.md:366`）。因此账单生成之后仍可能出现属于该月的新流水。设计不在生成前「等待所有扣费到齐」：等待没有上界，还会隐藏问题。迟到的处理是：

1. 核对任务发现账单期末与流水合计不一致，标为 `stale`，开告警（见下节）。
2. 管理员在后台「重新生成」（设计稿 `运营.dc.html:455`、`design.md:420`），账单更新，核对在下一轮恢复。
3. 不自动覆盖。自动覆盖会让客户已看到的正式账单无声改变，也与「重复执行结果相同」冲突。

## 实时（进行中）月份

设计稿的「本月（进行中）」行不落库（决定 14）：读取时用与生成相同的取数函数在 `[lo, statement_timestamp())` 上实时计算，响应带 `asOf`。进行中月份的期初用阶段 6 的余额锚点：`tenant_balances.balance` 减去本月至今的流水合计（`phase-6-design.md:349-354`），在 PORTALBIG 上实测 9 至 104 ms；这是当前月才合法的快捷写法，已过去的月份用「月初前流水合计」。读取是只读的 `withTenant` 事务，不写任何表。

状态有三种，列表与详情用同一个枚举 `state`：

| `state`       | 含义                                                     | 数据来源                   | 可重新生成                         |
| ------------- | -------------------------------------------------------- | -------------------------- | ---------------------------------- |
| `final`       | 已有账单行                                               | 存下的头部与明细           | 是（未删除话单时）                 |
| `in_progress` | 当前北京月                                               | 实时计算                   | 否，写「进行中，月结后可重新生成」 |
| `pending`     | 月份已结束但还没有账单行（凌晨 00:00-02:00，或任务失败） | 实时计算，页面标「待生成」 | 是，等同补建                       |

`pending` 比设计稿多出来的状态是必要的：没有它，每月 1 日 00:00 到 02:00 之间，上月会从列表里消失。它只出现在已结束但无账单的月份，用同一取数函数，不另写。进行中月份的通话扣费必须等于首页「本月消费」（`usage.ts:9-19`），PR 1 的测试断言两者相等。

门户列表只列第一个应有月份起的月份。

**空状态（决定 22）。** 只要租户存在，接口总是返回进行中月份那一行（可以全零）。「还没有账单」空状态（设计稿 4a、4b）只在同时满足下面三条时由 Web 显示：没有任何账单行、本月至今没有流水、本月至今没有已接通话单。未接通话单不算活动。判断用返回行本身：`calls` 为 0 且五个金额全 0 且没有账单行。

**后台的「未生成」（决定 30）。** 后台账单页对应有而缺账单行的 (租户, 月份) 返回 `state: 'pending'` 且 `figures` 为 null，页面显示「未生成」，不为每个缺失行做实时聚合；行内「重新生成」等同补建。租户详情账单标签页里的 `pending` 行仍然实时计算并显示数字，标签为「待生成」。

## 核对任务

对应验收标准 2：每个租户每月，账单期末 = 截至月末的流水合计，不一致产生告警。

### 检查什么

队列 `reconcile-statements`，每天 03:00（北京时间，在生成之后）运行，对每个租户做一次按月累计扫描：`sum(amount)` 按 `occurred_at` 的北京月分组再做窗口累计，得到每个月末的账本余额 `L(hi)`，以及月初 `L(lo)`。对该租户每张账单：

| 检查 | 条件                               | 失败时                                 |
| ---- | ---------------------------------- | -------------------------------------- |
| 期末 | `L(hi) = closing_balance`          | 见下表                                 |
| 期初 | `L(lo) = opening_balance`          | 同上，前一月迟到会让后续月份的期初过期 |
| 缺失 | 第一个应有月份到上月之间没有账单行 | 记为缺失，开告警                       |

按月累计扫描的代价是一次读完该租户全部流水。PORTALBIG（2,850,187 笔）实测约 0.97 至 0.99 s；全库每天一次，总行数按每天 1 万通估算约每年 360 万笔，每天扫描量级是秒到十几秒。只读，不占租户锁。

### 失败的分类

用 `created_at` 区分原因（只做分类，不做归属）：

| `reconcile_status` | 条件                                                                   | 含义与处置                                                                 |
| ------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ok`               | 期初与期末都吻合                                                       | 无                                                                         |
| `stale`            | 不吻合，且存在 `occurred_at < hi AND created_at > generated_at` 的流水 | 账单生成之后才写入的属于该月（或更早月份）的流水，补推所致；管理员重新生成 |
| `inconsistent`     | 不吻合，且不存在上述迟到流水                                           | 不是补推能解释的：代码缺陷或绕过应用的手工改库，需要人工调查               |
| `unchecked`        | 尚未核对（刚创建）                                                     | 默认值                                                                     |

状态写回头部的 `reconcile_status`、`reconciled_at`、`reconcile_diff`（核对列不受守卫触发器限制，`details_deleted` 的月份也会被核对）。`details_deleted` 的月份仍检查期初与期末，因为流水完整；只有明细缺口不再检查。

### 不一致怎么记录（告警系统在阶段 9）

阶段 9 才有告警页面和邮件，但 `system_alerts` 表已经存在，Worker 已经往里写 `cdr_failed`、`partition_failed`（`ingest.ts:35-46`）。用户确认的做法（决定 27）：

1. 状态存在头部列里，是权威数据，后台账单页可以据此标注。
2. 同时往 `system_alerts` 写一条 `kind = 'statement_mismatch'`，`tenant_id` 为该租户，`description` 是确定性文本「<租户编码> <YYYY-MM> 账单与流水不一致（stale|inconsistent|missing），差额 <diff>」，`affected_calls` 取迟到流水笔数。一个 `(租户, 月份)` 同时只开一条：写之前按 `(tenant_id, kind, description)` 查未恢复的告警，已有就不重复。
3. 后来核对通过（管理员重新生成之后），把这条告警的 `recovered_at` 置为当前时间。这与阶段 9 验收的「对账（补投）告警在恢复后标记为已恢复」同一形态（`plan.md:346`）。
4. 阶段 9 负责在页面显示、发邮件和去重规则；阶段 7 只负责产生与恢复这条记录。阶段 9 若要更结构化的去重键，可以给 `system_alerts` 加列，不需要改阶段 7 的行为。

5. 后台账单页在「生成时间」下方的备注位（与「已重新生成」「该月话单已删除」同一位置）显示「账单已过期」（`stale`）或「账单与流水不一致」（`inconsistent`）。设计稿没有这两句，是决定 27 引入的新文案，PR 6 的差异清单要记录。

已否决的备选：只写头部列、不进 `system_alerts`；或推迟到阶段 9。

## 手动重新生成

### 行为

后台租户账单行的「重新生成」（`运营.dc.html:444`、`租户详情.dc.html`），对话框展示当前通话扣费、当前通话分钟数、账单生成于（`运营.dc.html:462`）。确认后：

1. 请求带 `expectedVersion`（对话框打开时看到的版本）。管理员身份进入 `withAdmin`，`REPEATABLE READ`。
2. 锁定该账单头部行；`version` 与 `expectedVersion` 不符返回 409 `STATEMENT_VERSION_CONFLICT`（另一个管理员刚重新生成过）。
3. 守卫：`details_deleted` 为真返回 409 `STATEMENT_DETAILS_DELETED`；月份未结束返回 409 `STATEMENT_NOT_FINAL`；租户不存在或月份早于第一个应有月份返回 404。
4. 用与定时任务相同的取数函数重新计算。头部 `UPDATE`（`version + 1`、新数字、`generated_at`、`generated_by`、核对状态复位为 `unchecked`），追加新版本明细。
5. 同一事务写操作日志 `statement_regenerate`，内容含 `before` 与 `after` 两组数字（期初、充值、赠送、调账、通话扣费、期末、通话数、分钟、版本）和 `changed`（设计稿：「操作人和前后差异记入操作日志」，`运营.dc.html:463`）。
6. 响应带 `before`、`after`、`changed`，以及 `staleFollowingMonths`（见下）。如果算出的数字与现有完全相同，不加 `version`、不写新明细，`changed` 为假，但仍写操作日志，记录这次操作（决定 10）。

对 `pending` 月份（已结束但无账单行），同一个动作等同补建：`expectedVersion` 为 0，插入 `version = 1`。这也是 `STATEMENT_BACKFILL_MONTHS` 之外的缺口的补救途径。

### 后续月份的期初

补推一笔 8 月的扣费，8 月账单的期末变了，9 月账单里存的期初也过期了（账本的月初前合计变了，9 月的期末也跟着变）。核对任务会把 9 月标为 `stale`。重新生成只处理被点的那个月，响应的 `staleFollowingMonths` 列出此刻期初与账本不符的后续账单月份，页面提示管理员按月份顺序逐个重新生成。用户确认不级联（决定 28）：不做可选级联，也不要求前面月份先为 `ok`。

### 审计

`packages/shared/src/api/admin/audit.ts` 增加 action `statement_regenerate`，`target.kind` 枚举（`audit.ts:70-79`）增加 `'statement'`，`target.id` 是账单头部的 `id`，`tenantId` 是租户。内容字段沿用其他 variant 的 `summary` 与 `changes`，另有 `month`、`before`、`after`、`changed`。定时任务没有管理员，不写操作日志；它的结果可以从账单行的 `generated_by IS NULL` 与 `generated_at` 查到，核对告警另有记录。

## 为阶段 8 预留什么

阶段 8 删除话单（`plan.md:303-310`、`design.md:386-402`）与本阶段的接口：

| 需要                   | 阶段 7 提供                                                                                                                                | 阶段 8 做什么                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 只能删除已出账月份     | `monthly_statements` 行的存在与 `state = 'final'`，查询函数 `listStatementMonths(tx, tenantId)`                                            | 删除对话框的月份选择器据此置灰当月与未出账月份                       |
| 删除后禁止重新生成     | 列 `details_deleted`、守卫触发器、服务层 409 `STATEMENT_DETAILS_DELETED`、后台按钮置灰与提示                                               | 在**删除话单的同一个事务里**把覆盖月份的 `details_deleted` 置 `true` |
| 账单明细导出提示已删除 | 详情响应的 `detailsDeleted`、「导出 CSV（该月话单明细）」置灰并提示「该月话单明细已删除」（`pages.md:172`、`第二批.dc.html:198, 300-301`） | 无                                                                   |
| 删除后账单与余额不变   | 明细与头部都存成行，不再依赖话单；`breakdown_gap` 不重算                                                                                   | 无                                                                   |
| 操作日志               | 已有审计信封                                                                                                                               | 删除动作自己的 action                                                |

如果阶段 8 漏掉置位，重新生成会基于残缺的话单算出错误的明细，守卫触发器拦不住（它只看标志）。所以阶段 8 的验收（`plan.md:317`）必须断言置位与删除同事务，这个风险记入[风险](#风险)。

核对任务对 `details_deleted` 的月份仍然检查期初与期末，因此话单删除后账目对不上能被发现。

## 端点

门户操作要求 customer session，租户只来自会话，路径里的 `month` 不是租户选择器；`access` 为 `customer`，`isolationCase` 为 `tenant-read`（`packages/shared/src/api/portal/contract.ts:26-41`）。后台操作要求 admin session，`access` 为 `admin`，`isolationCase` 为 `admin-only`（`packages/shared/src/api/admin/contract.ts:71-95`）。`month` 参数格式 `YYYY-MM`，严格解析，多余键 400。

| operationId                      | method path                                                        | 请求                              | 200 响应                           | 说明                                                                                         |
| -------------------------------- | ------------------------------------------------------------------ | --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `portalStatements`               | `GET /api/portal/statements`                                       | 无                                | `portalStatementsResponse`         | 列表：`currency`、`items`（按月份降序，含实时月份）、`asOf`                                  |
| `portalStatement`                | `GET /api/portal/statements/{month}`                               | params `month`                    | `portalStatementResponse`          | 详情：头部、国家、日期、`state`、`detailsDeleted`、`period`                                  |
| `portalStatementExport`          | `POST /api/portal/statements/{month}/export`                       | params `month`，空 body           | 流式 CSV                           | 汇总 CSV，不写操作日志                                                                       |
| `adminStatements`                | `GET /api/admin/statements`                                        | query `month`（默认上一个北京月） | `adminStatementsResponse`          | 按币种分组，各组带合计，**不跨币种相加**；应有而缺账单行的租户以 `pending` 行列出（决定 30） |
| `adminTenantStatements`          | `GET /api/admin/tenants/{tenantId}/statements`                     | 无                                | `adminTenantStatementsResponse`    | 租户账单标签页列表，含实时月份和每行 `regenerable`                                           |
| `adminTenantStatement`           | `GET /api/admin/tenants/{tenantId}/statements/{month}`             | params                            | `adminTenantStatementResponse`     | 详情，另有版本、生成人、核对状态、`breakdownGap`                                             |
| `adminTenantStatementExport`     | `POST /api/admin/tenants/{tenantId}/statements/{month}/export`     | params，空 body                   | 流式 CSV                           | 汇总 CSV，不写操作日志（决定 16）                                                            |
| `adminTenantStatementRegenerate` | `POST /api/admin/tenants/{tenantId}/statements/{month}/regenerate` | body `{ expectedVersion }`        | `adminStatementRegenerateResponse` | 写 `statement_regenerate` 操作日志                                                           |

话单明细 CSV 复用现有操作，不新增端点：门户 `portalCdrsExport`、后台 `adminTenantCdrsExport`，请求体 `from` 是该月 1 日、`to` 是该月最后一天（满足一个月上限，`latestRangeEnd('2026-09-01') = '2026-09-30'`，`packages/shared/src/api/day-range.ts`），后台导出照常写 `cdr_export` 操作日志（`apps/api/src/routes/exports.ts:167-210`）。`exportFilename` 的 `ExportKind` 增加 `'statement'`（`packages/shared/src/api/export.ts:12`），汇总 CSV 文件名 `statement_ABC001_2026-09-01_2026-09-30.csv`。

模块布局与阶段 6 一致：`packages/shared/src/api/statement-fields.ts` 放头部、国家、日期的公共字段表，`portal/statements.ts` 与 `admin/statements.ts` 各自从字段表组合，**互不继承**（`phase-6-design.md:78`）。门户 schema 里没有 `version`、`generatedBy`、`reconcile*`、`breakdownGap`，且为 strict。契约先不并入 `liveApiContract`，随 PR 3 的路由登记（`phase-6-design.md:79`）。

### 响应形状

| 类型                   | 字段                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StatementFigures`     | `openingBalance`、`recharge`、`gift`、`adjustment`、`callCharges`、`closingBalance`、`calls`（整数）、`callMinutes`，金额与分钟均为 canonical decimal string（`money.ts`）。schema 检查等式 `closing = opening + recharge + gift + adjustment − callCharges`                                                |
| `StatementRow`         | `month`、`state`、`StatementFigures`、`generatedAt`（实时月份为 null）、`detailsDeleted`                                                                                                                                                                                                                    |
| `StatementDetail`      | `currency`、`tenant {code, name}`、`month`、`state`、`period {from, to, openedOn}`（8 月的 `from` 是开户日，`openedOn` 非空，设计稿「2026-08-12（开户）至 2026-08-31」）、`asOf`（实时月份）、`generatedAt`、`detailsDeleted`、`figures`、`countries`（按费用降序）、`days`（按日期升序，只含有通话的日子） |
| `AdminStatementDetail` | `StatementDetail` 的全部字段加 `version`、`firstGeneratedAt`、`generatedBy {id, name}                                                                                                                                                                                                                       | null`、`reconcile {status, reconciledAt, diff}`、`breakdownGap`、`regenerable {allowed, reason}`，`reason`为`in_progress`、`details_deleted` 或 null |
| 后台列表一行           | `tenant {id, code, name}`、`state`（`final` 或 `pending`）、`figures`（`pending` 时为 null）、`generatedAt`、`firstGeneratedAt`、`version`、`detailsDeleted`、`reconcileStatus`；合计只算 `final` 行                                                                                                        |

门户列表不分页（每年 12 行，十年 120 行）。后台账单页按币种分组，组内按租户编码升序，组头带租户数，组尾带合计（设计稿 `运营.dc.html:432, 448`）；合计由服务端在全量行上算，不是前端求和。

### 错误契约

沿用阶段 5 的错误形状（`phase-6-design.md:118`），**新增三个 409 码**，加入 `adminConflictCodeSchema`（`packages/shared/src/api/admin/errors.ts:5-20`）：

| 情形                                             | 响应                                                      |
| ------------------------------------------------ | --------------------------------------------------------- |
| `month` 格式不对、晚于当前北京月、多余键         | 400 `VALIDATION_ERROR`                                    |
| 门户请求的月份没有账单，也不是进行中或待生成月份 | 404 `NOT_FOUND`（与别的租户的月份无法区分）               |
| 后台租户不存在、月份早于第一个应有月份           | 404 `NOT_FOUND`                                           |
| 客户访问后台路径；后台访问门户路径               | 403 `FORBIDDEN`                                           |
| 重新生成：`details_deleted`                      | 409 `STATEMENT_DETAILS_DELETED`                           |
| 重新生成：进行中月份                             | 409 `STATEMENT_NOT_FINAL`                                 |
| 重新生成：`expectedVersion` 过期                 | 409 `STATEMENT_VERSION_CONFLICT`                          |
| 导出并发已满                                     | 429 `RATE_LIMITED`，沿用阶段 6（`phase-6-design.md:125`） |

### 越权用例（IDOR）

每个门户操作登记一个 `tenant-read` 用例，每个后台操作一个 `admin-only` 用例；覆盖检查由 `generateOpenApi` 强制（`apps/api/src/idor.db.test.ts:601-663`）。具体情形：

1. 租户 A 的会话请求 `portalStatements`，只得到 A 的行；夹具里 B 有同月份账单，A 的响应里不出现 B 的任何数字。
2. 租户 A 请求 B 独有月份的 `portalStatement`，得 404，响应体与 A 请求从不存在月份时相同；响应里没有 `tenantId`。
3. 租户 A 的 `portalStatementExport` 文件名、内容都是 A 的；路径里没有租户可替换。
4. 客户会话调用任一后台账单操作得 403；管理员会话调用门户操作得 403。
5. `adminTenantStatementRegenerate` 按 `(租户, 月份)` 定位账单，请求里没有账单 id，因此不会出现用 A 的路径改 B 的账单。
6. 数据库层：以租户身份直接 `SELECT` 两张明细表只见本租户行，`INSERT`、`UPDATE`、`DELETE` 被策略或权限拒绝（`rls.db.test.ts` 同形）。
7. 门户响应的原始 JSON 不含 `version`、`generatedBy`、`reconcile`、`breakdownGap`（对未解析的 `response.body` 断言，与阶段 6 的做法相同）。

## CSV

### 汇总 CSV

UTF-8、BOM、CRLF、每个单元格过 `csvCell`（`packages/rating/src/csv.ts`），走阶段 6 的 `streamCsv`（`apps/api/src/export/stream-csv.ts`），不另写一套下载代码（`phase-6-design.md` 决定 4）。汇总数据很少，仍用同一响应通道。文件布局（决定 25）是**长表单文件**：一个表头，三类行，便于 Excel 筛选和透视。

| 列                     | 取值                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类别                   | `汇总`、`国家`、`日期`                                                                                                                                                                  |
| 项目                   | 汇总类：期初余额、充值、赠送、调账、通话扣费、期末余额；国家类：国家名；日期类：`YYYY-MM-DD`                                                                                            |
| 通话数                 | 通话扣费行、国家行、日期行填写，其余为空                                                                                                                                                |
| 计费分钟               | 同上                                                                                                                                                                                    |
| 金额(CNY) 或 金额(USD) | 汇总类带符号（充值、赠送为正，通话扣费为负，调账原符号，期初、期末原值），使这一列之和等于期末；国家、日期行为费用（正数）。表头注明币种，与流水 CSV 一致（`phase-6-design.md` 决定 4） |

行序：汇总六行，国家按费用降序，日期升序。进行中月份在汇总类末尾无额外行，文件名带月份区间，导出时间不进文件。

### 话单明细 CSV

复用话单导出，列与话单页一致（`apps/api/src/routes/exports.ts:27-43`），门户版没有「验证状态」，后台版多一列。明细 CSV 只含已接通话单（决定 24、25），使行数与账单「通话数」一致；请求体不带 `status`，取默认值 `answered`。

## Web 页面

页面细节以设计稿为准，下表只列新增或改动的文件。

| 文件                                                        | 动作                                                                                                                                                                                                                                     | PR   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `components/app-shell.tsx`                                  | 门户导航在「话单」「余额流水」之间加「月账单」（设计稿顺序 首页、话单、月账单、余额流水、账号设置）；后台导航加「账单」，位于「待收款」之后                                                                                              | 4, 5 |
| `router.tsx`                                                | `/portal/statements`、`/portal/statements/$month`、`/admin/statements`                                                                                                                                                                   | 4, 5 |
| `lib/admin-search.ts:79-86`                                 | `tenantTabs` 在「话单」后加 `statements`（标签「账单」）                                                                                                                                                                                 | 5    |
| `components/statement/*`（新）                              | 汇总算式、国家表、日表、手机卡片、列表行，电脑与手机一套组件；门户与后台共用，后台包一层加操作列                                                                                                                                         | 4    |
| `pages/portal/statements.tsx`、`statement-detail.tsx`（新） | 列表 1a 1b 1c、详情 2a-2d、话单明细已删除 3a 3b、空状态 4a 4b（空状态规则见决定 22）；国家表列头「国家」，带「占比」列（由费用算出）；日表补零；`window.print()` 与打印样式（决定 29）；骨架屏、错误重试沿用通用状态（`pages.md:83-89`） | 4    |
| `components/month-field.tsx`（新）                          | 月份选择（后台账单页 ‹ 月份 ▾ ›，下一月到上月即置灰；阶段 8 的删除对话框月份网格复用同一组件）                                                                                                                                           | 5    |
| `pages/admin/statements.tsx`（新）                          | 按币种分组表格、合计行、手机卡片 5c（「手机端仅显示前 3 个租户示意」只是设计稿说明，实际显示全部）、重新生成确认对话框 5b；缺账单的租户显示「未生成」，行内重新生成等同补建（决定 30）；生成时间下方的「账单已过期」备注（决定 27）      | 5    |
| `pages/admin/tenant-tabs/statements-tab.tsx`（新）          | 租户详情账单标签页 1f 1g 3f 3g，进行中行与话单已删除行的重新生成置灰并显示原因；待生成行显示实时数字并可重新生成；「账单已过期」备注                                                                                                     | 5    |
| `lib/api.ts`、`lib/download.ts`                             | `webApiContract` 并入新契约；汇总 CSV 用阶段 6 的 `callDownload`（POST、`blob()`）                                                                                                                                                       | 4, 5 |

详情页行为：

- 顶部：月份标题、「本月（进行中）」标签、租户名称、编码、币种、区间；进行中显示「数据截至 …… · 实时更新」，已结束显示「账单生成于 ……」。
- 汇总区算式：期初余额 + 充值 + 赠送 ± 调账 − 通话扣费（附「N 通 · M分钟」）= 期末余额。赠送、调账为零仍显示 0.00，调账为负红色，期末为负红色。
- 按国家汇总「按费用从高到低」，列为国家、通话数、计费分钟、占比、费用，合计行；按日汇总覆盖区间内每一天，没有通话的日子补零，首月从开户日起，标题显示区间天数，进行中月份当天标「今日 · 截至当前」，合计行。电脑用表，手机用卡片。
- 导出 CSV（汇总）、导出 CSV（该月话单明细）、打印（`window.print()`，打印样式隐藏导航与按钮，决定 29）。`detailsDeleted` 为真时明细按钮置灰，显示横幅「该月话单明细已删除，账单汇总不受影响，但无法再导出该月话单明细。」
- 进行中月份顶部提示「本月尚未结束，以下数据截至今日并实时更新；<下月 1 日> 凌晨生成正式账单。」。
- 列表底部说明「本月数据实时更新，截至 …；每月 1 日凌晨生成上月正式账单。「充值」包含所有入账充值。」

主题、手机宽度、深浅色的视觉对照在 PR 6 做，沿用阶段 6 的 `portal-visual.spec.ts` 形式。

## 性能

阶段 7 的 plan 没有性能验收标准。本节为设计提供数量级依据，沿用阶段 6 页面 500 ms 的内部目标。

在本机 `fs_billing_perf` 库的 PORTALBIG（300 万话单、2,850,187 笔流水、2026-09 北京月 234,277 通）上，以 `fs_billing_app` 身份在只读事务里执行下列语句，每项跑 1 至 3 遍，单连接，本机，不含 HTTP，**事务全部 `ROLLBACK`，没有改库**。数字是各遍原值，首遍常偏慢。

| 查询                                     | 毫秒（各遍）         | 说明                                      |
| ---------------------------------------- | -------------------- | ----------------------------------------- |
| 期初 = 月初前全部流水合计                | 750.6、233.7         | 读到该租户历史全部流水，随历史线性增长    |
| 区间内按类型合计                         | 30.8、37.2           |                                           |
| 按国家汇总话单                           | 154.8、39.1          | 计划里有 `started_at` 下界，只扫 3 个分区 |
| 按日汇总话单                             | 55.4、56.2           |                                           |
| 国家与日期一次 `GROUPING SETS`           | 203.3、121.5、120.1  | 比分开跑两条（约 95 ms）慢，不采用        |
| 期初与四类合计合成一条带 `FILTER` 的聚合 | 2409.4、473.5、390.2 | 比分开跑（234 + 37 ms）慢，不采用         |
| 进行中月份期初（余额锚点）               | 103.5、10.1、9.2     | 2026-10 至今 128,795 笔扣费               |
| 核对：全历史按月累计                     | 994.2、974.0         | 每租户一次                                |

一次生成约 0.4 s（热）、约 1.0 s（冷），是上表单项相加的估算，不是整任务实测。核对按租户约 1 s。一个租户一次账单对 3M 话单规模来说可以接受，Worker 以并发 2 逐个处理没有压力。读取已存账单是按唯一键取一行加最多约两百行明细，没有实测，预计远低于 500 ms；进行中月份的详情是实时聚合，按单项相加估算约 0.15 s（热）。这两项 PR 3 没有测，PR 6 用 `apps/api/scripts/statements-perf-http.ts` 经回环 HTTP 在 PORTALBIG 上实测，原始输出在 [`docs/evidence/phase-7/statement-http-timings.txt`](evidence/phase-7/statement-http-timings.txt)，数字见 [PR 6 进度](#pr-6-验收收尾2026-10-22)：读取已存账单的详情中位数约 4.6 ms，进行中月份的详情（实时聚合）中位数约 367 ms，比上面按单项相加估算的 0.15 s 慢，原因见该小节。

## 已决定

下表是既有文档已定的规则、从仓库推出的约束，以及本设计的技术方案。来源为「用户 2026-10-22 确认」的 11 项（第 20 至 30 项）是原先的待确认问题，用户全部采用推荐项；第 7、8、9、16、18 项是本设计自行选择的默认，用户同日一并确认。第 31、32 项是 PR 6 验收时用户 2026-10-23 的决定。当前没有待用户确认的问题。

| #   | 决定                                                                                                                                                                                                                                                                                                                                                                                             | 来源                                 | 落实                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------- |
| 1   | 账单与核对按流水 `occurred_at` 的北京月统计，不按 `created_at`；9-30 23:59 接通、10-01 才扣费的电话计入 9 月                                                                                                                                                                                                                                                                                     | plan 阶段 7；`phase-2-db.md:61`      | [北京月边界](#北京月边界)；PR 1                                      |
| 2   | 「充值」含赊账充值，对客户和后台都不区分                                                                                                                                                                                                                                                                                                                                                         | `design.md:348`；`pages.md:168`      | [各项如何取数](#各项如何取数)                                        |
| 3   | 调账带符号求和，页面「±」，负数红色；赠送、调账为零仍显示 0.00                                                                                                                                                                                                                                                                                                                                   | `pages.md:168`；设计稿算式           | 同上；Web                                                            |
| 4   | 期初用月初前流水合计，不取上月账单期末                                                                                                                                                                                                                                                                                                                                                           | 本设计                               | 同上                                                                 |
| 5   | 头部来自流水，国家与日期明细来自话单，`breakdown_gap` 记录二者差额                                                                                                                                                                                                                                                                                                                               | 本设计                               | [通话数、计费分钟、按国家、按日](#通话数计费分钟按国家按日)          |
| 6   | 账单月份存 `date`（1 日），明细行按 `version` 区分                                                                                                                                                                                                                                                                                                                                               | 既有表；本设计                       | [表结构与迁移](#表结构与迁移)                                        |
| 7   | 每天 02:00 运行，只补缺失月份，1 日自然生成上月                                                                                                                                                                                                                                                                                                                                                  | 用户 2026-10-22 确认（采用设计默认） | [谁来生成、何时生成](#谁来生成何时生成)                              |
| 8   | 所有租户（含已停用、含零活动）都有账单，第一个应有月份取创建时间与最早流水的较早者                                                                                                                                                                                                                                                                                                               | 用户 2026-10-22 确认（采用设计默认） | 同上                                                                 |
| 9   | 定时任务只创建，不覆盖已有账单；覆盖只有管理员重新生成                                                                                                                                                                                                                                                                                                                                           | 用户 2026-10-22 确认（采用设计默认） | 同上；PR 2                                                           |
| 10  | 重新生成必须带 `expectedVersion`，必写操作日志（含前后差异）；结果无变化时不加版本，仍写日志                                                                                                                                                                                                                                                                                                     | 设计稿 `运营.dc.html:463`；本设计    | [手动重新生成](#手动重新生成)；PR 3                                  |
| 11  | 版本：头部原地更新并 `version + 1`，明细按版本追加、不删除；后台显示「已重新生成 · 原 <首次生成时间>」                                                                                                                                                                                                                                                                                           | 设计稿 `运营.dc.html:814`；本设计    | [明细表](#明细表)                                                    |
| 12  | `details_deleted` 的月份不能重新生成：服务层 409，加数据库触发器守卫；标志只能置真不能回退                                                                                                                                                                                                                                                                                                       | `design.md:394-402`；plan 阶段 7     | [守卫触发器](#monthly_statements-的守卫触发器)                       |
| 13  | 生成与重新生成用 `REPEATABLE READ` 快照事务，不拿租户锁                                                                                                                                                                                                                                                                                                                                          | 本设计                               | [单个账单的事务](#单个账单的事务)                                    |
| 14  | 进行中月份不落库，读取时实时计算，响应带 `asOf`                                                                                                                                                                                                                                                                                                                                                  | `pages.md:161`；设计稿               | [实时（进行中）月份](#实时进行中月份)                                |
| 15  | 核对用期初、期末两个恒等式，失败按 `created_at` 区分 `stale` 与 `inconsistent`，缺失账单单列                                                                                                                                                                                                                                                                                                     | plan 验收 2；本设计                  | [核对任务](#核对任务)                                                |
| 16  | 汇总 CSV 走阶段 6 的流式响应、POST；门户和后台汇总 CSV 都不写操作日志；话单明细 CSV 复用现有话单导出（后台照常写 `cdr_export`）                                                                                                                                                                                                                                                                  | 用户 2026-10-22 确认（采用设计默认） | [CSV](#csv)                                                          |
| 17  | 门户操作只认会话租户，`month` 参数不是租户选择器；请求带不存在的月份与别人独有的月份都是 404                                                                                                                                                                                                                                                                                                     | 阶段 6 约定                          | [越权用例](#越权用例idor)                                            |
| 18  | 不把月账单用作阶段 6 流水合并的锚点：账单可能过期，用过期期末做锚点会让流水余额错。若以后要用，只用 `reconcile_status = 'ok'` 的最近一张                                                                                                                                                                                                                                                         | 用户 2026-10-22 确认（采用设计默认） | 不在阶段 7 实现                                                      |
| 19  | 不同币种不相加，后台账单页按 CNY、USD 分组各自合计                                                                                                                                                                                                                                                                                                                                               | `pages.md:322`；设计稿               | [响应形状](#响应形状)                                                |
| 20  | ABC001 种子改成月账单设计稿：补 8 月、9 月人工流水按设计稿、`created_at` 回填 2026-08-12、逐通话单与逐通流水（`call:<uuid>` 键）使通话数、分钟、国家合计与设计稿一致；同步更新依赖旧种子的测试与文档                                                                                                                                                                                             | 用户 2026-10-22 确认                 | [种子](#种子决定-20)；PR 1                                           |
| 21  | 国家表按 pages.md 与阶段 6 决定 39 只按国家分组，列头「国家」，英国手机并入英国；保留由费用算出的「占比」列（不入库）                                                                                                                                                                                                                                                                            | 用户 2026-10-22 确认                 | Web；PR 4                                                            |
| 22  | 租户存在即显示进行中月份那一行（实时）；「还没有账单」空状态只在没有账单行、本月无流水、无已接通话单时显示                                                                                                                                                                                                                                                                                       | 用户 2026-10-22 确认                 | [实时月份](#实时进行中月份)；PR 3、4                                 |
| 23  | 按日汇总覆盖区间内每一天，没有通话的日子补零，首月从开户日起，标题显示区间天数；接口只返回有通话的日子                                                                                                                                                                                                                                                                                           | 用户 2026-10-22 确认                 | [响应形状](#响应形状)；PR 4                                          |
| 24  | 通话数 = 已接通话单条数，含 0 元通话，按 `answered_at` 归属，不含未接通；账单话单明细 CSV 只含已接通话单                                                                                                                                                                                                                                                                                         | 用户 2026-10-22 确认                 | [通话数、计费分钟、按国家、按日](#通话数计费分钟按国家按日)；PR 1、3 |
| 25  | 汇总 CSV 为长表单文件（类别、项目、通话数、计费分钟、金额(币种)），带符号金额之和等于期末；明细 CSV 复用话单导出的 15 列                                                                                                                                                                                                                                                                         | 用户 2026-10-22 确认                 | [CSV](#csv)；PR 3                                                    |
| 26  | 账单存精确值、页面按 2 位显示，不处理分项舍入后差 0.01                                                                                                                                                                                                                                                                                                                                           | 用户 2026-10-22 确认                 | [金额精度与显示](#金额精度与显示)                                    |
| 27  | 核对不一致时头部列保存状态，同时写 `system_alerts` 新类型 `statement_mismatch`，重新生成后置 `recovered_at`；后台账单页显示「账单已过期」备注                                                                                                                                                                                                                                                    | 用户 2026-10-22 确认                 | [核对任务](#核对任务)；PR 1、2、5                                    |
| 28  | 重新生成只处理点选的月份，响应列出过期的后续月份，不级联                                                                                                                                                                                                                                                                                                                                         | 用户 2026-10-22 确认                 | [后续月份的期初](#后续月份的期初)；PR 3、5                           |
| 29  | 「打印」在阶段 7 做：`window.print()` 加打印样式                                                                                                                                                                                                                                                                                                                                                 | 用户 2026-10-22 确认                 | Web；PR 4                                                            |
| 30  | 后台账单页列出应有而缺账单行的租户，显示「未生成」，行内重新生成等同补建                                                                                                                                                                                                                                                                                                                         | 用户 2026-10-22 确认                 | [实时月份](#实时进行中月份)；PR 3、5                                 |
| 31  | 验收标准 2 的「告警」是 `system_alerts` 的 `statement_mismatch` 记录（决定 27）；页面展示与邮件通知属阶段 9，不是本验收的条件；plan 阶段 7 该项保持勾选                                                                                                                                                                                                                                          | 用户 2026-10-23 确认                 | [验收记录](evidence/phase-7/README.md#plan-勾选)；PR 6               |
| 32  | 视觉对照发现的 9 处没有现成决定的差异（U1 至 U9）全部按稿修：月份选择器的「月份」小标签、后台手机组头一行加页脚提示、租户标签页分钟带单位、租户标签页手机紧凑卡片、「话单已删除」标签同一行、期初为负标红、重新生成对话框电脑上无遮罩与 ×、门户 1024 宽度顶栏与标题精简、手机详情标题居中。共用组件（对话框、外壳顶栏、账号菜单、列表）只给阶段 7 的页面加可选参数，不改阶段 4 至 6 已验收的页面 | 用户 2026-10-23 确认                 | [差异清单](evidence/phase-7-web/visual-diff.md)；PR 6                |

## 验收标准对应计划测试

对应 [plan.md 阶段 7](plan.md#阶段-7月账单) 的 5 条验收标准。状态列在 PR 6（2026-10-22）逐行核对过：表里点名的测试都用 grep 核对了文件与名字，并在 `pnpm test:db`、`pnpm test:idor`、`pnpm test:e2e`、`pnpm check` 里全部通过（原始输出见 [`docs/evidence/phase-7/`](evidence/phase-7/README.md)）。设计阶段点名的名字有一批没有原样落地（例如 `returns the mockup figures in the raw JSON`、`seeds ABC001 August and September to the statement mockup`、`seeding twice adds no CDR or ledger row`、`a tenant cannot see another tenant's month`），已改为实际存在的测试，对应关系在 [PR 6 验收记录](evidence/phase-7/README.md#设计里点名的测试与实际名字)。没有凭空补写：这些点名的覆盖都在实际存在的测试里，不是缺失的覆盖。

| 验收标准                                                   | 状态   | 测试文件 / name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. 种子数据生成 ABC001 的 8、9 月账单，数字与设计稿一致    | 已通过 | `packages/db/src/statements/generate.db.test.ts` / `generates the ABC001 August and September statements from the seed with the mockup figures`、`matches the mockup country tables with descriptions folded into the country`、`matches the mockup day tables: August starts on the opening day, September ends on the 29th`、`closing balance equals the ledger sum to month end for every seeded statement`；`apps/web/e2e/portal-statements.spec.ts` 与 `admin-statements.spec.ts` / `shows the August and September statements of the mockup`、`shows the ABC001 August and September statements of the mockup`（真实种子，经浏览器与接口）；`packages/db/src/seed.db.test.ts` / `running the seed again adds no rows anywhere`                                                                                                                                                                                                                   |
| 2. 每租户每月期末 = 截至月末流水合计，自动核对，不一致告警 | 已通过 | `packages/db/src/statements/reconcile.db.test.ts` / `marks a statement ok when closing and opening equal the ledger`、`checks the seeded ABC001 statements against the ledger`、`flags a call charge written after generation as stale and opens one alert`、`flags a closing that differs without late entries as inconsistent`、`opens one alert per tenant and month across reruns, updating it when the difference changes`、`recovers the alert after regeneration`、`reports a missing statement, opens an alert and recovers it once the statement exists`、`checks details-deleted months against the ledger without the breakdown gap`；`apps/worker/src/statements.db.test.ts` / `marks generated statements ok and opens no alert`、`flags a late call charge as stale with one alert, keeps it at one alert across reruns and recovers after regeneration`、`processes the parent job, the children and the reconcile job through pg-boss` |
| 3. 一律按 `occurred_at` 的北京日/月，不按 `created_at`     | 已通过 | `generate.db.test.ts` / `puts a call answered on 09-30 23:59 and charged on 10-01 into September`、`puts a call ringing on 09-30 23:59:50 and answered on 10-01 00:00:05 into October for both ledger and breakdown`、`puts a call ringing on 08-31 23:59:50 and answered on 09-01 00:00:05 into September, not August`、`ignores created_at when the entry was written months later`；核对同样按 `occurred_at` 的北京月（`reconcile.db.test.ts` 的 `flags a call charge written after generation as stale and opens one alert`：9 月的扣费 `created_at` 是现在，仍归 9 月，`created_at` 只用来区分 stale 与 inconsistent）                                                                                                                                                                                                                                                                                                                            |
| 4. 同一月份重复执行生成任务，结果相同且不重复              | 已通过 | `generate.db.test.ts` / `running the generator twice leaves one statement and one breakdown version`、`a scheduled generation never overwrites an existing statement after late entries`、`concurrent generators produce exactly one statement`；`apps/worker/src/statements.db.test.ts` / `a duplicate parent job enqueues no second child`、`repeated runs leave one statement with identical results`、`a scheduled run never overwrites an existing statement after late entries`、`concurrent child jobs for the same tenant-month produce one statement and one breakdown`、`the daily schedule is registered with tz Asia/Shanghai`                                                                                                                                                                                                                                                                                                             |
| 5. 话单补推后重新生成，账单更新；跨午夜电话归属正确        | 已通过 | `packages/db/src/statements/regenerate.db.test.ts` / `a late call charge then regeneration updates the figures, bumps the version and appends the new breakdown`、`an unchanged recomputation keeps the version and still reports changed false`、`a call answered after midnight belongs to the next day in the day breakdown`、`rejects expectedVersion that is stale`；`apps/api/src/admin-statements.db.test.ts` / `regenerates and writes one statement_regenerate audit with before and after, and lists the stale following months`；`apps/web/e2e/admin-statements.spec.ts` / `regenerating after a late call updates the figures, bumps the version and audits before and after`                                                                                                                                                                                                                                                              |

### 新增行为的验收与测试

状态同上：PR 6 逐行核对，表里的名字都是实际存在并通过的测试。

| 验收行为                                      | 测试文件 / name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 种类映射：赊账并入充值，调账带符号            | `generate.db.test.ts` / `counts credit recharges as recharge and keeps adjustments signed`、`a void adjustment of a credit shows as a negative adjustment`                                                                                                                                                                                                                                                                                                                                                                 |
| 进行中月份与首页本月消费一致                  | `packages/db/src/statements/live.db.test.ts` / `matches the home month spend for the current month`、`computes a pending month between midnight and generation`                                                                                                                                                                                                                                                                                                                                                            |
| 已删除话单的月份不能重新生成                  | `regenerate.db.test.ts` / `rejects a details-deleted month at the service`、`the guard trigger rejects figure changes on a details-deleted month and a flag rollback`                                                                                                                                                                                                                                                                                                                                                      |
| 头部与明细同一快照                            | `generate.db.test.ts` / `a charge committed during generation never splits the header from the breakdown`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 国家只按国家分组                              | `generate.db.test.ts` / `groups by country and folds descriptions together`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 租户第一个应有月份                            | `generate.db.test.ts` / `starts at the earlier of tenant creation and the first ledger entry`、`creates zero statements for tenants with no activity`                                                                                                                                                                                                                                                                                                                                                                      |
| 明细表只增、RLS                               | `packages/db/src/rls.db.test.ts` / `statement detail tables show a tenant only its own rows and reject writes`、`statement detail rows cannot be updated or deleted`                                                                                                                                                                                                                                                                                                                                                       |
| 越权                                          | `apps/api/src/idor.db.test.ts` 的 `portalStatements`、`portalStatement`、`portalStatementExport` 三个客户用例（`app` 与 `owner` 两条车道，共 6 个）与「客户访问全部后台操作得 403」循环；`apps/api/src/portal-statements.db.test.ts` / `never shows another tenant's numbers`、`answers 404 for another tenant's month exactly as for a month that never existed`、`carries no internal fields in the raw JSON`；`admin-statements.db.test.ts` / `keeps every statement operation away from customer sessions`             |
| 汇总 CSV                                      | `portal-statements.db.test.ts` / `streams the long-format summary whose signed amounts add up to the closing balance`；`apps/api/src/export/statement-csv.test.ts` / `names the currency in the amount header and neutralizes formula country names when serialized`                                                                                                                                                                                                                                                       |
| 网页                                          | `apps/web/e2e/portal-statements.spec.ts`（列表、详情、国家占比、补零日表、进行中行、导出、打印、手机卡片、不存在的月份）、`admin-statements.spec.ts`（月份切换、币种分组合计、未生成补建、重新生成与版本冲突、置灰原因、核对备注、导出、打印、手机）                                                                                                                                                                                                                                                                       |
| 种子重写（决定 20）                           | `seed.db.test.ts` / `running the seed again adds no rows anywhere`、`every seeded call has the production ledger key and no call is left for the Worker reconciliation to charge again`、`ABC001 opened on 2026-08-12 and its rate card applies from the opening`、`the seeded ledger of ABC001 follows the statement mockup: no gifts or reversals of the admin mockup remain`；`generate.db.test.ts` / `matches the mockup country tables with descriptions folded into the country`；`ledger.db.test.ts` 的种子流水用例 |
| 通话数口径（决定 24）                         | `generate.db.test.ts` / `counts zero-charge answered calls and ignores unanswered ones`；`portal-statements.db.test.ts` / `exports the answered call details of the month, row count equal to the statement call count`                                                                                                                                                                                                                                                                                                    |
| 空状态与进行中行（决定 22）                   | `portal-statements.db.test.ts` / `returns only the all-zero current month for a tenant with no activity, from which the empty state is derived`；`apps/web/e2e/portal-statements.spec.ts` / `shows the empty state only without statements and activity`                                                                                                                                                                                                                                                                   |
| 日表补零与占比（决定 21、23）                 | `apps/web/src/pages/portal/statement-detail.test.tsx` / `fills days without calls with zero from the opening date`、`shows each country's share of the call charges`、`titles the table with the period length`；`portal-statements.spec.ts` / `lists countries only by country with each share of the call charges`、`counts the days of the period and zero-fills the days without calls`                                                                                                                                |
| 后台「未生成」与「账单已过期」（决定 27、30） | `admin-statements.db.test.ts` / `groups a month by currency, lists missing statements as pending without figures and totals only final rows`、`backfills a pending month as version 1 with expectedVersion 0 and a null before`；`admin-statements.spec.ts` / `lists a tenant without a statement as 未生成 and regenerating creates it`、`shows the reconcile state in the generation-time note slot, the tab and the detail`                                                                                             |
| 不级联（决定 28）                             | `regenerate.db.test.ts` / `lists the following months whose stored opening no longer matches the ledger`；`admin-statements.spec.ts` / `lists the later months that went stale and does not regenerate them`                                                                                                                                                                                                                                                                                                               |
| 打印（决定 29）                               | `portal-statements.spec.ts` / `hides navigation and buttons under print media`（后台是 `admin-statements.spec.ts` 的 `hides the navigation and buttons when printing`）、`opens the print dialog from the print button`                                                                                                                                                                                                                                                                                                    |

## PR 拆分

| PR  | 内容                                                                                                                                                                                                                                                                                                  | 依赖    | 文件边界                                                                                                                                                                                                                                                                                                                                                                                                        | 验收与证据                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | 本 PR：设计文档                                                                                                                                                                                                                                                                                       | 无      | `docs/phase-7-design.md`                                                                                                                                                                                                                                                                                                                                                                                        | prettier；待用户回答[待用户确认](#待用户确认)                                                                                                          |
| 1   | 数据库与取数核心 + 种子重写：迁移 0017（含 `statement_mismatch`）、守卫触发器、取数函数（生成、实时、核对查询）、`withSystem` 的 `repeatable read`；ABC001 种子按决定 20 重写（人工流水、`created_at`、逐通话单与流水、种子末尾生成两张账单），并更新依赖旧种子的测试与文档（见[种子](#种子决定-20)） | 0       | `packages/db/migrations/0017_*.sql` 与 journal、`packages/db/src/schema.ts`、`packages/db/src/statements/*`、`packages/db/src/client.ts`、`packages/db/src/seed.ts`、`packages/db/src/ledger.db.test.ts`、`apps/web/e2e/portal-ledger.spec.ts`、`apps/web/e2e/portal-home.spec.ts`、`docs/phase-2-db.md`、`apps/web/.agents/skills/verify/features/db-*.md`、`docs/evidence/phase-6-web/visual-diff.md`（附注） | 验收 1、3、4 的 DB 测试；种子幂等与不被对账重扣；`pnpm test:db`、`pnpm test:idor`、受影响的 e2e；PORTALBIG 上取数耗时重测写入 `docs/evidence/phase-7/` |
| 2   | Worker：队列预建、生成任务（扇出）、核对任务、告警记录                                                                                                                                                                                                                                                | 1       | `apps/worker/src/statements.ts`、`queue.ts`、`main.ts`、`config.ts`、`scripts/install-queue.ts`                                                                                                                                                                                                                                                                                                                 | 验收 2、4 的 Worker 测试；调度元数据与手动 `boss.send()`（真正的 cron 触发测试是阶段 9 的遗留项，`plan.md:348`）                                       |
| 3   | 契约与 API：门户、后台操作，重新生成与审计，汇总 CSV，越权用例                                                                                                                                                                                                                                        | 1       | `packages/shared/src/api/statement-fields.ts`、`portal/statements.ts`、`admin/statements.ts`、`admin/audit.ts`、`admin/errors.ts`、`export.ts`；`apps/api` 路由、`liveApiContract` 登记、`idor.db.test.ts`                                                                                                                                                                                                      | 验收 5 的 API 测试；原始 JSON 不含管理字段；经 HTTP 的耗时记录                                                                                         |
| 4   | 门户 Web：导航、列表、详情（占比、补零日表）、导出、打印、空状态、已删除话单状态；共用 `components/statement/*`                                                                                                                                                                                       | 3       | `apps/web/src/components/statement/*`、`pages/portal/statements*.tsx`、`app-shell.tsx`、`router.tsx`、`lib/api.ts`、`apps/web/e2e/portal-home.spec.ts`（导航断言翻转）                                                                                                                                                                                                                                          | 组件测试与 e2e 冒烟；设计稿 1a-4b 截图初稿                                                                                                             |
| 5   | 后台 Web：账单页（含「未生成」「账单已过期」）、租户详情账单标签页、重新生成对话框、月份选择器                                                                                                                                                                                                        | 3、4    | `pages/admin/statements.tsx`、`tenant-tabs/statements-tab.tsx`、`components/month-field.tsx`、`lib/admin-search.ts`、`app-shell.tsx`、`router.tsx`                                                                                                                                                                                                                                                              | e2e：月份切换、币种分组、重新生成、置灰原因、未生成补建                                                                                                |
| 6   | e2e、视觉对照、plan 勾选                                                                                                                                                                                                                                                                              | 2、4、5 | `apps/web/e2e/*`、`docs/evidence/phase-7*`、`docs/plan.md`、`README.md`                                                                                                                                                                                                                                                                                                                                         | 全部 e2e；浅色、深色、手机宽度对照图与差异清单；plan 阶段 7 逐项勾选并附证据                                                                           |

PR 1 体量大，建议在同一 PR 里分两个提交：先迁移与取数核心，再种子重写与依赖测试、文档的更新；审查要求时，种子部分可以独立成 PR 1b，依赖前者的生成函数。PR 2 与 PR 3 只依赖 PR 1，可并行。PR 4 先落共用组件，PR 5 复用，避免两边各写一套。每个 PR 合并前跑 `pnpm check`，涉及数据库的跑 `pnpm test:db`，PR 1 与 PR 3 加 `pnpm test:idor`。

### PR 1 实现与验收进度（2026-10-22，[#57](https://github.com/SpaceEggs/fs-billing/pull/57)）

迁移 0017（`monthly_statements` 补列、两张只增的明细表与 RLS、守卫触发器、`statement_mismatch` 告警类型）、`withSystem` / `withAdmin` 的 `repeatable read`、`packages/db/src/statements/*`（取数是一条 CTE 语句，头部与明细同一快照）与 ABC001 种子重写（决定 20）。设计标为未验证的 `REPEATABLE READ` 下 `ON CONFLICT DO NOTHING` 行为用真实并发确认：快照之后提交的冲突行得到 40001，包装器重试后得到 `exists`。核对的告警在 db 层完成（一个租户一个月份同时只开一条，按「租户编码 + 月份」前缀识别，与设计的 `(tenant, kind, description)` 去重不同）。用户当天追加的决定：GZT007 两条示例话单补扣费流水（余额 86.27）、ABC001 在播种当月 1 日凌晨固定 20 通话单（81 分钟、¥3.51）与等额预存。

### PR 2 实现与验收进度（2026-10-22，[#58](https://github.com/SpaceEggs/fs-billing/pull/58)）

Worker 的 `generate-statements`（每天 02:00 北京时间，父任务扇出）、`generate-statement`（子任务）、`reconcile-statements`（每天 03:00）。cron 不补发的三层对策：调度用 `missed: 'once'`、父任务补齐全部缺失月份、Worker 启动时再入队一次。与设计的差异：子任务 ID 多带「父任务运行的北京日」，入队前检查上一轮仍在排队的子任务。部署时必须重新执行 `queue:migrate`。真实的每日 cron 触发测试仍是阶段 9 的遗留项（`plan.md:348`）。

### PR 3 实现与验收进度（2026-10-22，[#59](https://github.com/SpaceEggs/fs-billing/pull/59)）

契约（`statement-fields.ts` 公共字段表，门户与后台各自组合、互不继承）、三个 409 错误码、审计 `statement_regenerate`、读取服务 `readStatementView` / `readStatementMonthList`、重新生成（`repeatable read`、同事务写操作日志）、汇总 CSV（长表，走阶段 6 的 `streamCsv`）、8 个端点与越权用例。设计 PR 3 行写的「经 HTTP 在 PORTALBIG 上实测耗时」当时没有做，在 PR 6 补做。

### PR 4 实现与验收进度（2026-10-22，[#60](https://github.com/SpaceEggs/fs-billing/pull/60)）

门户月账单列表与详情，共用组件 `components/statement/*`（算式、国家表、日表、列表、状态标签）。国家表与日表的合计行取各行之和，头部通话扣费与行和不等时表下写「部分扣费没有对应的话单明细」（用户 2026-10-22 决定）。新文案：待生成月份的说明、国家表空数据时的「没有已接通的通话」、手机顶栏 ⋯ 打开的底部面板（里面只有「打印」）、手机日表当天的「今日」小标记。

### PR 5 实现与验收进度（2026-10-22，[#61](https://github.com/SpaceEggs/fs-billing/pull/61)）

后台「账单」页（月份选择器、币种分组、「未生成」补建、「账单已过期」等备注）、租户详情「账单」标签页、重新生成确认对话框（两张稿合并为运营稿的行）、账单详情（无后台稿，沿用门户版式加管理员信息块）、`components/month-field.tsx`。组头在有未生成行时写「N 个未生成，不计入合计」。

### PR 6 验收收尾（2026-10-22）

PR 6 新增 `apps/web/e2e/portal-statements-visual.spec.ts`、`admin-statements-visual.spec.ts`（共用 `statement-visual.ts`）、`apps/api/scripts/statements-perf-http.ts`、`docs/evidence/phase-7/` 与 `docs/evidence/phase-7-web/` 下的证据，并勾选 plan 阶段 7、更新本文的验收映射表和 README。证据索引见 [PR 6 验收记录](evidence/phase-7/README.md)。

- **视觉对照**：门户 1a 至 1c、2a 至 2d、3a、3b、4a、4b（11 个画框）与后台运营稿 5a 至 5c（含 5a 的 8 月与默认上月两种取景）、租户详情稿 1f、1g、3f、3g，各含浅色与深色，共 38 张对照图，另有 6 张只存档的图（门户 9 月详情、后台账单详情）。对照中发现一处明确缺陷并已修正：手机 375 px 下按日汇总的「1,994分钟」在「分」与「钟」之间折行（稿里一行），日表中间列加 `whitespace-nowrap`，e2e 新增 `keeps each day of the phone day table on one line at 375 px`。另有 9 处没有现成决定的差异（U1 至 U9），用户 2026-10-23 决定全部按稿修（[决定 32](#已决定)），已修正并复拍：月份选择器的「月份」小标签、后台手机组头一行与页脚提示、租户标签页分钟带单位、租户标签页手机紧凑卡片、「话单已删除」标签同一行、期初为负标红、重新生成对话框电脑上无遮罩与 ×、门户 1024 宽度顶栏与标题精简、手机详情标题居中。共用组件（`ModalDialog`、`AppShell`、`AccountMenu`、`StatementList`、`MonthField`）只加可选参数，默认行为不变，阶段 4 至 6 已验收的页面没有改动（见[差异清单](evidence/phase-7-web/visual-diff.md#本轮修正)）。复拍时又看到的 U10（门户头像圆底）、U11（后台账单页副标题位置）来自共用的 `AccountMenu`、`PageBody`，用户 2026-10-23 决定接受、不改。其余差异分为已决定、种子或夹具数据、画框外壳，记为接受。没有未决的视觉差异。
- **HTTP 耗时**：见[耗时记录](evidence/phase-7/README.md#经-http-的耗时)。用性能库 `fs_billing_perf_pr3_uuid_v4` 的副本 `fs_billing_perf_p7`（迁移到 0017，原库未动），经回环 HTTP：门户列表中位数 368.7 ms、已存月份详情 4.6 ms、进行中月份详情（实时聚合）367.4 ms、汇总 CSV 5.7 ms；后台月份列表 5.2 ms、租户账单标签页 360.4 ms、租户详情 4.3 ms；300 万话单租户的一次生成（HTTP 补建）573.9 ms，无变化的重新生成约 556 至 566 ms。列表与标签页的约 360 ms 与进行中月份详情的耗时相当，推测来自列表里那一行进行中月份的实时聚合（没有单独验证），已存月份本身读取只是取一行加明细。plan 对这些端点没有性能验收标准，这里只记录数字。
- **plan 勾选**：阶段 7 的 5 项验收全部勾选，每项附测试名与证据链接。第 2、4 项里「自动」指每日定时任务；调度元数据与手动 `send` 有测试，真实时钟触发是阶段 9 遗留项，勾选依据是用户决定 27 把「告警」定为 `system_alerts` 记录（页面与邮件属阶段 9）；用户 2026-10-23 确认这一解读，该项保持勾选（[决定 31](#已决定)）。
- **完整检查**：`pnpm check`、`pnpm test:db`、`pnpm test:idor`、`pnpm test:e2e` 全部通过，数字见验收记录。

## 与其他阶段的依赖

| 阶段              | 关系                                                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段 8 话单运维   | 删除话单依赖本阶段的账单存在性和 `details_deleted`；删除对话框月份选择器复用 `month-field`；阶段 8 验收「删除 8 月话单后，8 月账单数字不变，导出提示已删除，重新生成不可用」（`plan.md:317`）由本阶段的置灰与守卫实现一半。未归属话单分配后补扣费，产生的是迟到流水，会让相应月份 `stale`，这是预期的 |
| 阶段 9 通知与告警 | 本阶段产生并恢复 `statement_mismatch` 记录；页面显示、邮件、去重规则由阶段 9 决定。阶段 9 遗留的「pg-boss 关闭 advisory locking 假设单实例」（`plan.md:349`）与「真实每分钟 cron 触发测试」（`plan.md:348`）同样约束本阶段的两个定时任务；本设计已保证任务幂等，多触发不产生重复账单                  |
| 阶段 10 部署      | 新队列需要重新执行 `queue:migrate`；备份恢复演练要覆盖账单表；核对任务耗时随流水总量增长，要用有历史数据的库再测                                                                                                                                                                                      |

## 风险

- **种子重写体量大，牵动旧测试。** 9,642 与 12,804 条话单加同样数量的流水，约 2.2 万行；`portal-ledger`、`portal-home` e2e 和 `ledger.db.test.ts` 的断言要重写，阶段 6 视觉证据 R5 的文字过时（见[种子](#种子决定-20)的清单）。漏改会表现为 e2e 失败。
- **设计稿的日分钟与日通话数可能无整数解。** 国家单价、日费用和各合计同时成立时，日分钟、日通话数只能取最接近的可行值；若日费用也无解，PR 1 回到用户确认。
- **种子流水若不用 `call:<uuid>` 键，对账会重扣。** 近 30 天内有费用而无该键的话单会被 Worker 的补扣对账再扣一次（`apps/worker/src/reconcile.ts:25-28`）；决定 20 因此要求逐通流水使用生产键，并有测试。现有 3 条示例话单今天就在这个窗口里没有对应流水，这是已有的行为，PR 1 补写它们的流水后消除。
- **迟到流水让后续月份级联过期。** 补推 8 月的一笔扣费，8 月和 9 月都变为 `stale`，重新生成只处理一个月，管理员要按顺序逐月处理（决定 28）。多个月连续过期时操作繁琐。
- **分项舍入。** 分项各自舍入后与舍入后的期末可能差 0.01（决定 26，用户接受）。
- **话单与流水的差额。** `breakdown_gap` 不为零时，国家表合计不等于通话扣费。常见原因是队列延迟和 0 元通话（0 元通话计入通话数，但没有流水）；决定 20 的种子为 0。
- **明细按话单算，话单可能不完整。** 振铃超过 31 天的话单不在明细里，仍在头部里（`phase-6-design.md:169, 670`）。
- **阶段 8 漏置 `details_deleted`。** 守卫只看标志，不会发现话单已被删除；靠阶段 8 同事务置位与验收断言。
- **核对任务随流水总量线性增长。** 每天扫全部租户的全部流水，当前规模下是秒级，数据量增长一个数量级后需要改成只核对最近若干月，阶段 10 在有历史数据的库上重测。
- **`REPEATABLE READ` 下的 `ON CONFLICT DO NOTHING` 行为。** 设计预期遇到并发提交的冲突行会收到 `40001`，由包装器重试；这是对 PostgreSQL 行为的推断，PR 1 用并发测试确认，不依赖这个推断。
- **新增队列需要 owner 重新执行 `queue:migrate`。** 忘记执行会让 Worker 在 `boss.work` 时失败。
- **cron 不补发。** 每天运行加补缺是对策；如果 Worker 连续停机多日，恢复后的第一次运行会补出全部缺失月份，一次入队多个租户多个月，并发 2 逐个处理。
- **打印依赖浏览器。** 打印样式只能人工看一次。
- **进行中月份是实时聚合。** 每次打开详情约 0.15 s（热，估算），多人同时打开大租户的详情会重复聚合；没有缓存。

## 待用户确认

无。原先的 11 个问题已由用户 2026-10-22 回答，全部采用推荐项，见[已决定](#已决定)第 20 至 30 项。

## 本步验证

2026-10-22 在本机验证了以下事实，没有实现代码，没有运行 `pnpm check`。

- **种子核对。** 开发库 `fs_billing`（Docker 里的 `fs-billing-postgres-1`）上对 ABC001 做只读 `SELECT`，结果见[种子数据核对](#种子数据核对验收标准-1)。结论：按 `occurred_at` 的北京月汇总，种子产出的 9 月是 期初 0.00、充值 2,431.10（含赊账）、赠送 40.00、调账 −20.00、通话扣费 2,486.30、期末 −35.20；8 月无流水；`monthly_statements` 为空。验收标准 1 的数字不能由当前种子产出，只有 9 月通话扣费与期末对得上。
- **性能探针。** 在 `fs_billing_perf` 上以 `fs_billing_app` 身份、`BEGIN READ ONLY … ROLLBACK` 事务里执行，见[性能](#性能)。没有改任何表，也没有碰开发库的数据。查询计划确认话单汇总只扫 2026-08、2026-09 分区。
- **设计稿。** 逐个读了 `客户门户 第二批.dc.html`、`管理后台 第三批 · 运营.dc.html`、`管理后台 第三批 · 租户详情.dc.html`、`管理后台 删除话单原型.dc.html` 中的月账单相关渲染和数据脚本，并核对国家表之和等于合计。设计稿是带模板的 HTML，没有渲染截图，字段与文案取自模板与脚本源码。
- **未验证。** 迁移、任务、API、页面均未实现；`REPEATABLE READ` 下并发 `ON CONFLICT` 的行为未实测；HTTP 端到端耗时、窄屏与深色渲染、打印样式均未验证；性能数字只来自单连接本机测量。

- **2026-10-22 决定更新。** 本次只改文档，没有运行代码。依赖旧种子的测试与文档清单用 `grep` 对种子数字（33、28、2486.30、1931.10、线路故障补偿）和 e2e 断言核对，读了 `portal-ledger.spec.ts`、`portal-home.spec.ts` 的相关断言，没有运行这些测试。日分钟与日通话数是否有整数解未验证。
