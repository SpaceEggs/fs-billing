# 阶段 6 step 1 设计与共享契约

## 类型与模块布局

本步交付 Zod wire contract、三个纯函数模块（挂断原因表、CSV 单元格转义、日期范围规则）、契约测试和补测的性能证据。API routes、DB services、迁移、Web 页面均为后续 PR。本步没有向 `liveApiContract` 注册任何端点，也不表示阶段 6 已验收。

依据是 [plan.md 阶段 6](plan.md#阶段-6客户门户)、[pages.md](pages.md) §2.2、§2.3、§2.6、§2.7 与后台租户详情行、客户门户第一至第三批和后台租户详情设计稿，以及 [docs/perf/portal-cdrs.md](perf/portal-cdrs.md)。数据口径见[已决定](#已决定)，没有待用户确认的问题。

调用方示意先于实现。Web 使用 `portalCdrsQuerySchema.parse({from: '2026-09-01', to: '2026-09-29', callee: '+44 7700 900123'})`，得到 `{from, to, callee: '447700900123', status: 'answered', page: 1}`。API 收到验证后的 `PortalCdrsQuery`，从客户会话取得租户，再在该租户的 `withTenant` 事务里查询。请求里没有租户字段，带了也会被 strict schema 拒绝。后台话单使用另一组 schema，多一个 `unverified`，两组 schema 共享 `cdrFields`，互不继承。

### 核心数据形状

| 类型 / schema                                        | 结构与不变量                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PortalCdr`                                          | strict。`callUuid`、`startedAt`（振铃开始）、`answeredAt`（接通，未接通为 null）、`endedAt`（挂断）、`caller`、`callee`、`country`、`iso`（大写两位字母或 null）、`description`（字符串或 null，未接通为 null）、`matchedPrefix`、`durationSeconds`、`billedMinutes`、`rate`、`charge`、`hangupCause`。没有 `status`，已接通即 `answeredAt` 非空。没有 `unverified`，带该键的数据解析失败。`callee` 是客户拨出的原始号码（决定 31）。形状检查与 `cdrs` 的检查约束一致：未接通的时长、分钟、费用必须为 0，已接通必须有国家、前缀、费率 |
| `AdminCdr`                                           | `PortalCdr` 的全部字段加 `unverified: boolean`。两者各自 strict，互相拒绝对方的行                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PortalCdrsQuery` / `AdminCdrsQuery`                 | `from`、`to` 为北京日 `YYYY-MM-DD`，含两端，跨度不超过一个日历月。`callee` 先归一化成 billing_number 写法。`country` 按国家名精确匹配，不含说明，选某国家会包含它的所有说明。`status` 为 `answered`（默认）或 `all`。`page` 从 1 起，上限 100000，每页固定 50 条。后台另有 `unverifiedOnly`，查询串只接受 `'true'` 或 `'false'`                                                                                                                                                                                                       |
| `PortalCdrsResponse` / `AdminCdrsResponse`           | `currency`、`items`（至多 50）、`pagination {page, pageSize: 50, total}`、`summary {billedMinutes, charge, unansweredCalls}`。通话数取 `pagination.total`，不在 summary 里重复。后台 summary 另有 `unverifiedCalls`，不能大于 total。所有金额与分钟为 decimal string                                                                                                                                                                                                                                                                  |
| `CdrCountriesResponse`                               | `{countries: string[]}`，所选日期范围内该租户话单出现过的国家（不含说明），按通话数降序                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MergedChargeRow`                                    | 通话扣费按北京日合并的一行：`kind: 'call_charge'`、`day`、`calls`（正整数）、`amount`（负数）、`balanceAfter`、`occurredAt`（当天最后一笔扣费的接通时间，必须落在 `day` 当天）、`partial`（`day` 是读取时的北京当天）。门户与后台共用同一个 schema                                                                                                                                                                                                                                                                                    |
| `PortalLedgerRow`                                    | `recharge`、`gift`、`adjustment` 逐笔，字段 `id`、`amount`、`balanceAfter`、`occurredAt`、`note`，加 `MergedChargeRow`。strict。没有 `credit_recharge`、收款状态、操作人、备注可见性、内部备注。赊账充值在这里是 `recharge`，备注是 `账户充值`                                                                                                                                                                                                                                                                                        |
| `AdminMergedLedgerRow`                               | 人工流水加收款状态、操作人、备注可见性，加同一个 `MergedChargeRow`。`credit_recharge` 的备注仅内部可见且收款状态非空，其余类型收款状态为 null                                                                                                                                                                                                                                                                                                                                                                                         |
| `PortalLedgerQuery` / `AdminMergedLedgerQuery`       | 同样的北京日范围与一个月上限，`kind` 筛选，`page`。门户每页固定 `PORTAL_LEDGER_PAGE_SIZE`，后台保留 `pageSize`（默认 25，最大 100）。门户 `kind=recharge` 同时包含赊账充值，后台 `kind` 保持五种                                                                                                                                                                                                                                                                                                                                      |
| `PortalLedgerResponse` / `AdminMergedLedgerResponse` | `currency`、`balance`（读取时的当前余额，页头显示）、`totalAmount`（筛选后全部行的金额合计）、`items`、`pagination`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PortalHomeResponse`                                 | `currency`、`balance`、`overdraftLimit`、`availableBalance`、`health`、`usage`、`recentCalls`（至多 10）。`usage` 取 `tenantUsageWindowFields`，没有未接通通数，也没有重复的币种                                                                                                                                                                                                                                                                                                                                                      |
| `TenantHealth`                                       | `suspended`、`overdraft`、`low_balance`、`normal`、`disabled`，从 `adminTenantHealthSchema` 移到中立模块 `tenant-health.ts`，后台与门户共用                                                                                                                                                                                                                                                                                                                                                                                           |
| `AuditPayload`（`cdr_export`）                       | 新增 action。content 必含 `rowCount` 和 `filters {from, to, status, callee?, country?, unverifiedOnly}`，`callee` 存归一化后的数字。target 为租户                                                                                                                                                                                                                                                                                                                                                                                     |
| `HANGUP_CAUSE_LABELS`、`formatHangupCause`           | 46 个 FreeSWITCH 原因到中文的对照。`formatHangupCause('NORMAL_CLEARING')` 返回 `NORMAL_CLEARING（正常挂断）`，未收录的原因和空串原样返回                                                                                                                                                                                                                                                                                                                                                                                              |
| `csvCell`、`csvRecord`                               | 先中和公式再按 RFC 4180 加引号。话单与流水两种 CSV 共用                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `latestRangeEnd`、`checkDayRange`                    | 日期范围规则：结束日最晚为「开始日加一个日历月」的前一天，下月没有同一天时取下月最后一天。不提供 JS 侧的区间换算，数据库查询直接收 `YYYY-MM-DD` 并在 SQL 里换算（见时间口径）                                                                                                                                                                                                                                                                                                                                                         |
| `normalizeCalleeSearch`                              | 被叫搜索词归一化，见[被叫号码搜索](#被叫号码搜索)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

金额与分钟沿用 [money.ts](../packages/shared/src/api/money.ts) 的 canonical decimal string，不在 wire 层使用 number。时间是带偏移的 ISO，日期是 `YYYY-MM-DD` 北京日。页面显示时间一律由前端转成北京时间，已有 `formatDateTime`。

### 模块归属

| 路径                                                                            | 本步 / 后续 | 责任                                                                                                                      |
| ------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/api/tenant-health.ts`                                      | 本步        | 租户状态枚举，后台与门户共用                                                                                              |
| `packages/shared/src/api/usage.ts`                                              | 本步        | 拆出 `tenantUsageWindowFields` 与 `checkUsageDailyWindow`，后台概况与门户首页各自组合                                     |
| `packages/shared/src/api/day-range.ts`                                          | 本步        | 北京日范围字段、一个月上限                                                                                                |
| `packages/shared/src/api/cdr-fields.ts`                                         | 本步        | 话单行公共字段、筛选字段、被叫归一化、分页与汇总字段                                                                      |
| `packages/shared/src/api/ledger-merge.ts`                                       | 本步        | 合并行 schema、金额符号规则、合并行备注文本                                                                               |
| `packages/shared/src/api/export.ts`                                             | 本步        | CSV 响应媒体类型、文件名与 `Content-Disposition`                                                                          |
| `packages/shared/src/api/portal/{home,cdrs,ledger,contract}.ts`                 | 本步        | 门户 schema 与 `portalHomeApiContract`、`portalCdrApiContract`、`portalLedgerApiContract`，`portalApiContract` 为三组之和 |
| `packages/shared/src/api/admin/{ledger,cdrs}.ts`                                | 本步        | 后台合并流水与话单 schema                                                                                                 |
| `packages/shared/src/api/admin/contract.ts`                                     | 本步        | 新增 `adminCdrApiContract`，不并入 `adminApiContract`                                                                     |
| `packages/shared/src/api/admin/audit.ts`                                        | 本步        | 新增 `cdr_export`                                                                                                         |
| `packages/shared/src/hangup-cause.ts`                                           | 本步        | 挂断原因表与格式化                                                                                                        |
| `packages/rating/src/csv.ts`                                                    | 本步        | `neutralizeCsvFormula`、`csvCell`、`csvRecord`、`CSV_BOM`、`CSV_EOL`                                                      |
| `packages/db/migrations/0015_rls_initplan.sql`                                  | 后续 PR 1   | 租户范围表的 `tenant_read` 策略改写                                                                                       |
| `packages/db/src/ledger-merge.ts`                                               | 后续 PR 2   | 合并流水查询构造器，按受众（门户或后台）拼不同的最终 select                                                               |
| `packages/db/src/portal/{ledger,cdrs,home}.ts`、`packages/db/src/admin/cdrs.ts` | 后续 PR 2–4 | 门户与后台的读服务，导出的游标生产者                                                                                      |
| `packages/db/src/tenant-health.ts`                                              | 后续 PR 4   | 从 `admin/tenants.ts:51` 抽出的 health SQL，后台列表与门户首页共用                                                        |
| `apps/api/src/export/stream-csv.ts`                                             | 后续 PR 3   | 流式 CSV 响应：hijack、响应头、背压、中途失败、导出并发上限                                                               |
| `apps/api/src/routes/portal/*.ts`、`apps/api/src/routes/admin/cdrs.ts`          | 后续 PR 2–4 | 验证、身份、调用服务、错误映射                                                                                            |
| `apps/web/src/pages/portal/*`、`apps/web/src/components/cdr/*`                  | 后续 PR 4–6 | 门户页面，后台话单标签页，共用话单组件                                                                                    |

后续服务签名草案如下，均未实现。

```ts
listPortalCdrs({ db, tenantId, query }: PortalCdrsInput): Promise<PortalCdrsResponse>
listPortalCdrCountries({ db, tenantId, query }: CountriesInput): Promise<CdrCountriesResponse>
exportPortalCdrs({ db, tenantId, filter, onBatch }: ExportInput): Promise<void>
listPortalLedger({ db, tenantId, query }: PortalLedgerInput): Promise<PortalLedgerResponse>
exportPortalLedger({ db, tenantId, filter, onBatch }: LedgerExportInput): Promise<void>
readPortalHome({ db, tenantId, now? }: PortalHomeInput): Promise<PortalHomeResponse>
listAdminLedger({ db, tenantId, query }: AdminLedgerInput): Promise<AdminMergedLedgerResponse>
listAdminCdrs({ db, tenantId, query }: AdminCdrsInput): Promise<AdminCdrsResponse>
exportAdminCdrs({ db, actor, tenantId, filter, onBatch }: AdminExportInput): Promise<void>
```

`onBatch(rows)` 返回的 Promise 在响应写缓冲排空后才完成，生产者用它做背压。每个服务拥有自己的事务，不拆通用的 load、validate、save 转发层。

设计比较采用三个形状。

- **合并流水按受众拼两个 select。** 另一种做法是一条 SQL 产出后台全字段，门户再用 TS 函数投影。投影函数能工作，但赊账的内部备注、操作人和收款状态已经进了 Node 进程，投影一旦写错就会外露。本设计让门户的 select 不读 `created_by`、不 join 收款状态，赊账备注在 SQL 里替换成常量，数据库就不会把这些值交给门户路径。门户行再过 strict schema，多一个键就抛错。窗口累计与锚点只有一份实现。阶段 5 的 `projectPortalLedgerEntry` 随之删除，它没有调用方，行为（赊账备注置空）也与已决定的 `账户充值` 不同。
- **门户与后台话单共享 `cdrFields`，互不继承。** 若门户 `omit` 后台 schema，漏掉一个 `omit` 就会泄漏。若后台 `extend` 门户 schema，门户新增的字段会自动带进后台，门户一侧的安全就依赖这条继承链不被改动。两边从同一份字段表各自组合，新增字段必须在两边显式选择。
- **契约不并入 `liveApiContract`。** 现有路由注册器要求每个 operation 都有 handler，OpenAPI 覆盖测试和 IDOR 用例也按 `liveApiContract` 枚举。登记要等后端 PR。门户操作按后端 PR 分三组导出，每个 PR 只并入自己的一组。

此设计应用 Model the Domain 与 Type System Discipline，把合并行与人工流水编码为判别联合，把「门户行不含内部字段」放进 schema 而不是靠命名约定。应用 Boundary Discipline，在 Zod 边界拒绝多余键，挂断原因表与 CSV 转义保持为无依赖的纯函数。

## 端点

门户操作要求 **customer session**，复用现有 cookie、身份解析、Origin 校验、401/403 和 no-store 约定。租户只来自会话，路径和查询里没有租户。门户的 operation 的 `access` 都是 `customer`，都是读取，`isolationCase` 一律 `tenant-read`。每个 operation 的错误映射与契约一致：400、401、403、429、500、503 都有，`portalHome` 和 `portalLedger` 另有 404。导出用 POST，原因见[话单导出](#话单导出)。

| operationId          | method path                      | 请求                                   | 200 响应                              | 说明                                      |
| -------------------- | -------------------------------- | -------------------------------------- | ------------------------------------- | ----------------------------------------- |
| `portalHome`         | `GET /api/portal/home`           | 无                                     | `portalHomeResponseSchema`            | 余额卡片、30 天消费、最近 10 通已接通话单 |
| `portalCdrs`         | `GET /api/portal/cdrs`           | query `portalCdrsQuerySchema`          | `portalCdrsResponseSchema`            | 列表、汇总、总数在同一个事务里            |
| `portalCdrCountries` | `GET /api/portal/cdrs/countries` | query `portalCdrCountriesQuerySchema`  | `cdrCountriesResponseSchema`          | 国家筛选选项                              |
| `portalCdrsExport`   | `POST /api/portal/cdrs/export`   | body `portalCdrExportRequestSchema`    | 流式 CSV（`csvExportResponseSchema`） | 不写操作日志                              |
| `portalLedger`       | `GET /api/portal/ledger`         | query `portalLedgerQuerySchema`        | `portalLedgerResponseSchema`          | 合并流水                                  |
| `portalLedgerExport` | `POST /api/portal/ledger/export` | body `portalLedgerExportRequestSchema` | 流式 CSV                              | 与页面一致，不写操作日志                  |

后台话单操作要求 **admin session**（`access` 为 `admin`），`isolationCase` 为 `admin-only`，租户在路径里，错误映射含 404。

| operationId               | method path                                        | 请求                                 | 200 响应                     | 说明                                          |
| ------------------------- | -------------------------------------------------- | ------------------------------------ | ---------------------------- | --------------------------------------------- |
| `adminTenantCdrs`         | `GET /api/admin/tenants/{tenantId}/cdrs`           | query `adminCdrsQuerySchema`         | `adminCdrsResponseSchema`    | 多 `unverified` 字段、`unverifiedOnly` 筛选   |
| `adminTenantCdrCountries` | `GET /api/admin/tenants/{tenantId}/cdrs/countries` | query `adminCdrCountriesQuerySchema` | `cdrCountriesResponseSchema` | 同门户                                        |
| `adminTenantCdrsExport`   | `POST /api/admin/tenants/{tenantId}/cdrs/export`   | body `adminCdrExportRequestSchema`   | 流式 CSV                     | 写 `cdr_export` 操作日志，POST 才能承担写审计 |

已有的 `adminTenantLedger`（`GET /api/admin/tenants/{tenantId}/ledger`）在 PR 2 改成合并流水：请求与响应换成 `adminMergedLedgerQuerySchema`、`adminMergedLedgerResponseSchema`，旧的 `adminLedgerQuerySchema`、`adminLedgerResponseSchema` 和逐行相关子查询同批删除，新名字去掉 `Merged`。`adminBalanceOperation` 响应里的单条 `adminLedgerEntrySchema` 保持不变。

账号设置不新增 operation。登录邮箱、租户名称、编码和币种来自现有 `session` 响应的 `identity`，修改密码用 `changePassword`，退出用 `logout`。

### 查询语义

- `status=answered`（默认）只列接通的话单，按 `answered_at` 归属日期。`status=all` 另列未接通的话单，按 `coalesce(answered_at, started_at)` 归属日期，与 [design.md](design.md#5-计费规则) 一致。
- 未接通话单没有国家，所以 `country` 筛选只会命中已接通话单。带 `country` 时 `summary.unansweredCalls` 为 0。
- 已接通视图的 `summary.unansweredCalls` 是同一范围、同一被叫筛选下被隐藏的未接通条数。全部视图里它是结果集内的未接通条数。
- `callee` 搜索 billing_number 的子串，不是拨号原文。归一化见[被叫号码搜索](#被叫号码搜索)。
- 页码超出末页返回空 `items`，不报错，`pagination.total` 仍为真实总数。

## 错误契约

沿用 [阶段 5 设计](phase-5-design.md#错误契约) 的错误形状和映射：400 `VALIDATION_ERROR`、401 `UNAUTHENTICATED` 与 `SESSION_EXPIRED`、403 `FORBIDDEN`、`ACCOUNT_DISABLED`、`IDENTITY_UNAVAILABLE`、`PASSWORD_CHANGE_REQUIRED`、404 `NOT_FOUND`、429 `RATE_LIMITED`、500 `INTERNAL_ERROR`、503 `SERVICE_UNAVAILABLE`。阶段 6 **不新增错误码**。

| 情形                                                                    | 响应                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 范围超过一个月、开始晚于结束、日期不存在                                | 400 `VALIDATION_ERROR`，issue 的 `path` 为 `['to']` 或 `['from']`，消息 `日期范围最长一个月` 或 `结束日期不能早于开始日期` |
| 多余键（`tenantId`、`unverified`、未知参数）                            | 400 `VALIDATION_ERROR`                                                                                                     |
| 被叫搜索词不是数字、`+`、空白、连字符、括号，或归一化后为空、超过 15 位 | 400 `VALIDATION_ERROR`，消息 `被叫号码只能包含数字、+、空格、连字符和括号`                                                 |
| 导出并发已满（每租户 1 个、全服务 4 个，初始值）                        | 429 `RATE_LIMITED`，`retryAfterSeconds` 为 5。在写出任何字节之前返回                                                       |
| 导出开始前的数据库错误（语句超时、连接失败）                            | 与其他路由相同，500 或 503 的 JSON                                                                                         |
| 导出开始后的任何失败                                                    | 无法再改状态码。服务端销毁连接，不发结束块，浏览器的 `fetch` 因网络错误拒绝，前端不保存文件                                |
| 客户访问后台话单路径                                                    | 403 `FORBIDDEN`。后台访问门户路径同样 403                                                                                  |
| 租户不存在（后台路径）                                                  | 404 `NOT_FOUND`                                                                                                            |

## 流程与事务约束

### 日期、时区与归属

数据库存 UTC，界面与统计一律北京时间（[design.md](design.md#12-时间币种与格式)）。API 的日期参数是含两端的北京日，服务把校验过的 `YYYY-MM-DD` 字符串原样交给数据库，由 SQL 换算成半开区间 `[lo, hi)`：`lo = ($from::date)::timestamp AT TIME ZONE 'Asia/Shanghai'`，`hi = (($to::date + 1))::timestamp AT TIME ZONE 'Asia/Shanghai'`。不在 JS 里算 UTC 时刻，因为 `0001-01-01` 的下界在 JS 里是 `0000-12-31T16:00:00.000Z`，PostgreSQL 不接受这种写法，而 SQL 里的 `date` 算术在 `0001-01-01` 到 `9999-12-31` 全程有效（已在 PostgreSQL 17.9 上验证）。例如 `2026-09-01` 至 `2026-09-30` 对应 UTC `2026-08-31 16:00:00+00` 至 `2026-09-30 16:00:00+00`。UTC 2026-09-28 16:30 接通的电话在北京是 2026-09-29 00:30，落在 29 日的区间，不在 28 日的区间。

话单日期归属沿用 [design.md](design.md#5-计费规则)：已接通按接通时间，未接通按开始时间，跨午夜归入接通当天。流水归属按 `occurred_at`，通话扣费的 `occurred_at` 等于接通时间（[阶段 2 的决定](phase-2-db.md)），所以话单页与流水页对同一通电话给出同一天。

**一个月上限在服务端检查。** 每个带范围的 schema 都以 `superRefine(checkDayRange)` 结尾，路由注册器按 operation 的 query 与 body schema 校验，失败映射为 400。数据库服务入口再解析一次同一个 schema，不信任调用方，与 `listTenantLedger` 现在的做法一致。Web 的日期选择器同样置灰超出的日期，但那只是便利，不是防线。规则是结束日不晚于「开始日加一个日历月再减一天」。`2026-09-01` 至 `2026-09-30` 合法，`2026-09-01` 至 `2026-10-01` 非法，`2026-01-31` 的范围最晚到 `2026-02-27`（平年）。精确规则见[已决定](#已决定)第 26 项。

### 话单列表、汇总与国家

每个请求在一个 `withTenant` 事务里按顺序执行 2 至 3 条语句，与性能原型的测法一致。列表语句的形状如下，已接通视图。

```sql
SELECT call_uuid, started_at, answered_at, ended_at, caller, callee, country, iso, description, matched_prefix,
       duration_seconds, billed_minutes, rate, charge, hangup_cause      -- 后台另加 unverified
FROM cdrs
WHERE tenant_id = $1
  AND answered_at >= $2 AND answered_at < $3     -- $2 = lo、$3 = hi，由 SQL 从 $from、$to 算出，见时间口径
  AND started_at  >= $4 AND started_at  < $3     -- 分区裁剪，$4 = $2 - interval '31 days'
  AND billing_number LIKE $5                     -- 可选，'%' || 归一化数字 || '%'
  AND country = $6                               -- 可选
  AND unverified                                 -- 仅后台，且仅 unverifiedOnly
ORDER BY answered_at DESC, call_uuid DESC
LIMIT 50 OFFSET $7;
```

全部视图把两处 `answered_at` 谓词换成 `coalesce(answered_at, started_at)`，排序为 `coalesce(answered_at, started_at) DESC, call_uuid DESC`。门户的查询构造器没有 `unverified` 分支，类型上也没有 `unverifiedOnly` 参数，所以门户 SQL 里不会出现这一列。

**`started_at` 下界是为了裁剪分区。** `cdrs` 按 `started_at` 月分区，只靠 `answered_at` 的谓词裁剪不了。已接通话单满足 `started_at <= answered_at`，所以 `started_at < end` 恒成立。下界 `$4` 由应用层算好再作为参数传入，规划期就能裁剪，`$2 - interval '31 days'` 写在 SQL 里是 STABLE 表达式，只能在执行期裁剪。下界覆盖振铃时长：一通电话在月初前开始振铃、月初后接通，仍归接通月份。性能原型取 1 天，补测对比了三种宽度。

| 下界宽度 | 汇总 ms（3 遍）  | 中间页 ms（3 遍） |
| -------- | ---------------- | ----------------- |
| 1 天     | 61.3, 46.2, 35.5 | 22.8, 15.5, 15.3  |
| 31 天    | 35.3, 34.2, 33.5 | 15.3, 14.4, 14.3  |
| 93 天    | 33.5, 33.6, 34.5 | 14.3, 14.3, 15.5  |

三者没有可测差别（InitPlan 策略下，首遍偏慢），所以取 31 天，把「振铃不超过 1 天」的假设放宽到「不超过 31 天」。入库校验只要求 `answered_at <= ended_at`，没有限制振铃时长。振铃超过 31 天的话单不会出现在列表里，但仍会计费，见[风险](#风险)。数据来自 [design-step1.txt](perf/portal-cdrs/probes/design-step1.txt)。

**汇总与总数是一条聚合。** 总数取自同一条语句的 `count(*)`，不另做 COUNT 查询，也不预聚合。

```sql
SELECT count(*)::int AS total,
       coalesce(sum(billed_minutes), 0)::text AS billed_minutes,
       coalesce(sum(charge), 0)::text AS charge
FROM cdrs WHERE <与列表相同的谓词>;
-- 仅已接通视图，另一条：被隐藏的未接通条数
SELECT count(*)::int FROM cdrs
WHERE tenant_id = $1 AND answered_at IS NULL
  AND started_at >= $2 AND started_at < $3 [AND billing_number LIKE $5] [AND country = $6];
```

全部视图把未接通条数并进同一条聚合：`count(*) FILTER (WHERE answered_at IS NULL)`。后台再加 `count(*) FILTER (WHERE unverified)` 作为 `unverifiedCalls`，在筛选后的结果集内统计。

**国家选项。**

```sql
SELECT country FROM cdrs
WHERE tenant_id = $1 AND answered_at >= $2 AND answered_at < $3
  AND started_at >= $4 AND started_at < $3 AND country IS NOT NULL
GROUP BY country ORDER BY count(*) DESC, country;
```

选项是所选日期范围内出现过的国家（不含说明），不随被叫或状态筛选变化。未接通话单没有国家，所以不影响选项。前端在日期范围改变时重新请求。

**分页用 OFFSET 加总数。** 设计稿要页码和「共 N 条」，keyset 无法跳页。性能原型里最差一页是已接通 143 ms、全部 176 ms，keyset 任意深度 1.9 ms，留作储备。排序键带 `call_uuid`，同一时刻的话单顺序确定。OFFSET 的代价是翻页期间有新话单入库时，相邻页可能重复或漏掉一行，见[风险](#风险)。

**证据。** 下表的 300 万话单、大租户 PORTALBIG、2026-09 北京月来自性能原型，补测用同一数据。

| 请求                       | 原策略         | InitPlan 策略 | 来源                      |
| -------------------------- | -------------- | ------------- | ------------------------- |
| 已接通中间页               | 142.8 p50      | 14.3 至 15.5  | 性能原型；补测第 5 段     |
| 已接通汇总                 | 100.1 p50      | 33.5 至 35.3  | 性能原型；补测第 5 段     |
| 未接通计数                 | 7.6 p50        | 未测          | 性能原型                  |
| 国家选项（group by）       | 106.5 至 123.8 | 35.6 至 36.0  | 补测第 1 段               |
| 后台汇总加未经验证计数     | 48.6 至 56.4   | 34.4 至 34.7  | 补测第 1 段（admin 身份） |
| 后台「仅看未经验证」第一页 | 0.4 至 0.7     | 未测          | 补测第 1 段               |

InitPlan 策略下，一次列表请求在数据库里约 55 至 60 ms（中间页约 15，汇总约 35，未接通计数按原策略 5.6 至 7.6，三项相加估算，不是整请求实测），国家选项是另一个请求。验收标准是每页小于 500 ms。原策略下三项 p50 相加约 250 至 290 ms，预计满足预算，但这是分开测得的单项相加，不是整请求实测。整请求（含序列化和 HTTP）的验收在 PR 3：`apps/api/scripts/portal-list-perf.ts` 经 HTTP 重复请求，结果写入 `docs/evidence/phase-6/list-latency.txt`。改写 RLS 的目的是给租户话单翻倍留余量（性能原型推算现有策略撑到约 41 万条每月，InitPlan 撑到约 6 倍，两个推算都没有实测）。

#### 被叫号码搜索

搜索匹配 `billing_number` 的子串。该列是国际号码，首位 1 至 9，最长 15 位，不含 `+`、`00` 冠字和国内长途的开头 `0`（`cdrs_billing_number_check`，由 `normalizeDialedNumber` 生成）。页面显示的是客户拨出的原始号码 `callee`，可能是 `+447700900123`、`008613800138000` 或 `075586001234`。客户会把看到的号码原样输进搜索框，所以搜索词要先变成同一种写法再匹配。

`normalizeCalleeSearch` 去掉空白、连字符和括号，去掉开头的 `+`，去掉全部开头的 `0`，剩余必须是 1 至 15 位数字，否则返回 400。结果：`+44 7700 900123` 得到 `447700900123`，`0086 138-0013 8000` 得到 `8613800138000`，`075586001234` 得到 `75586001234`，它是 `8675586001234` 的子串。只留数字也让搜索词无法带入 LIKE 的 `%` 和 `_`。

#### 查询的 RLS 与 InitPlan

上表的 InitPlan 列依赖 [PR 1](#pr-拆分) 的策略改写，见[RLS InitPlan 改写](#rls-initplan-改写)。查询本身不依赖它，改写前后结果相同。

### 话单导出

**怎么触发。** 两个导出都是 POST，body 是当前筛选条件。后台导出写操作日志，纯 GET 不能承担写审计，沿用 [阶段 5 的决定](phase-5-design.md)。门户导出为了和后台共用一套路由、一套前端下载代码，也用 POST。POST 同时经过现有的 Origin 与 Fetch-Metadata 校验。

**服务端流程。**

1. 常规 preValidation：Origin 校验、会话、身份、body 的 strict 解析（含一个月上限）。
2. 取导出名额：每租户 1 个、全服务 4 个（进程内信号量，初始值）。满则 429，此时还没有写出字节。不用 advisory lock，沿用阶段 5「不新增锁」的规则。多实例时上限按实例计。
3. 打开事务。门户 `withTenant`，后台 `withAdmin`。事务内 `SET LOCAL statement_timeout = '30s'` 和 `SET LOCAL idle_in_transaction_session_timeout = '30s'`（初始值）。
4. `DECLARE cdr_export NO SCROLL CURSOR FOR <筛选谓词，按时间升序>`，立刻 `FETCH 5000`。**在写响应头之前取第一批**，查询错误、语句超时因此还能以 JSON 状态码返回。
5. `reply.hijack()`，复制 `reply.getHeaders()`（含 request id、`Cache-Control: no-store`）加 `Content-Type: text/csv; charset=utf-8`、`Content-Disposition: attachment; filename="cdrs_ABC001_2026-09-01_2026-09-29.csv"`、`X-Content-Type-Options: nosniff`，不设 `Content-Length`，分块传输。hijack 会跳过 Fastify 的 `onSend` 与 `onResponse`，所以导出结束时要自己记一条日志（行数、耗时、结果）。
6. 写 BOM、表头、CRLF。每批 5000 行拼成一个字符串，`write` 返回 false 就等 `drain` 或 `close`。客户端断开触发 `close`，抛出后事务回滚，连接归还。
7. 取到空批为止，`COMMIT`，结束响应。

**为什么是游标加 FETCH 5000。** 性能原型：`FETCH 1000` 的游标在 5 万到 20 万条之间 RSS 只多约 15 MB，一次性查询多约 198 MB，堆峰值稳定在 66 至 74 MB，不随条数线性增长。`FETCH` 大小只影响往返次数：10 万条上 `FETCH 100` 655 ms、`FETCH 1000` 430 ms、`FETCH 5000` 305 ms，三者堆峰值都是约 68 MB。10 万条文件约 11.2 MB。大租户 PORTALBIG 的 9 月 234,277 条用游标 1.1 至 1.2 s，RSS 159 至 162 MB。验收「10 万条在 30 秒内且内存不线性增长」有 40 倍以上余量。

**防止慢客户端占住连接。** 游标要求整个导出在一个事务里，慢客户端会长期占住一个连接和一个快照。三道限制，数值是初始值，由 PR 3 用限速客户端实测后确定。

- `idle_in_transaction_session_timeout = 30s`。Node 在等 `drain` 时数据库连接处于事务内空闲，超过 30 秒数据库终止该会话。每批约 560 KB，客户端下行速度要不低于约 150 kbit/s 才能在 30 秒内排空一批。
- 总时限 5 分钟，应用层计时器到点销毁响应并回滚。
- 独立连接池，上限 4，`connectionTimeoutMillis` 2 秒，不与业务池共用，导出占满自己的池也不会拖慢其他页面。

**每条退出路径的清理（PR 3 验收项）。** 导出有四种结束方式：成功、客户端中止（`close`）、数据库出错（`FETCH`、`COMMIT`、语句超时或会话被终止）、总时限到点。另有一种失败发生在 CSV 响应开始之前：取得名额后连接、`BEGIN`、`DECLARE` 或第一次 `FETCH` 出错。它按上面的 JSON 错误约定返回，不销毁响应。下面前四件事在所有这些路径里都必须发生，且各只发生一次，第五件只在响应已开始时做。实现放在取得名额之后的同一个 `try/finally` 里，不分散在各个事件处理函数。

1. 释放每租户与全服务的导出名额。释放函数幂等，重复调用不会多放一个名额。
2. 清除总时限计时器。
3. 移除这次导出加在响应、socket 和数据库连接上的全部监听（`drain`、`close`、`error`），不留下指向已结束导出的引用。
4. 事务没有 `COMMIT` 就 `ROLLBACK`，然后归还连接。回滚本身失败时销毁这条连接而不是放回池里。
5. 只有 CSV 响应已经开始（已 `hijack`、响应头已写出）且不是成功结束时，才销毁响应（`response.destroy()`），让浏览器看到连接中断而不是一个看似完整的截断文件。响应开始之前的失败不销毁，返回正常的 JSON 错误和文档约定的状态码（名额满 429，查询错误、语句超时按错误映射）。

**生产者正在等 `drain` 时数据库出错。** 等 `drain` 期间没有查询在途，数据库会话被终止（例如 `idle_in_transaction_session_timeout` 到点，或数据库重启）时，`pg` 在连接上发出 `error` 或 `end`，不会让任何 `await` 失败。所以等待写缓冲必须是 `Promise.race([drain, response 的 close, 连接的 error 或 end, 总时限的中止信号])`：任何一个不是 `drain` 的结果都抛出，生产者循环退出，走上面的 `finally`。没有这个竞争，生产者会永远挂在 `drain` 上，名额、计时器和监听都不释放。

对应的 PR 3 测试名在[验收标准对应计划测试](#验收标准对应计划测试)。

**CSV 格式。** UTF-8，BOM 开头，CRLF 换行，每个单元格过 `csvCell`。门户列（决定 3）依次是：

| 列             | 取值                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| 接通时间       | `coalesce(answered_at, started_at)` 的北京时间 `YYYY-MM-DD HH:mm:ss`，与页面第一列一致 |
| 主叫号码       | `caller`                                                                               |
| 被叫号码       | `callee`                                                                               |
| ISO            | `iso`，未接通为空                                                                      |
| 国家           | `country`，未接通写 `未接通`，与页面一致                                               |
| 说明           | `description`，未接通为空                                                              |
| 通话时长(秒)   | `duration_seconds`                                                                     |
| 计费时长(分钟) | `billed_minutes`                                                                       |
| 费率           | 固定 4 位小数，未接通为空                                                              |
| 费用           | `charge` 的存储值，不舍入                                                              |
| 振铃开始时间   | `started_at` 的北京时间                                                                |
| 挂断时间       | `ended_at` 的北京时间                                                                  |
| 挂断原因       | `formatHangupCause`，如 `NORMAL_CLEARING（正常挂断）`                                  |
| 匹配前缀       | `matched_prefix`，未接通为空                                                           |
| 通话UUID       | `call_uuid`                                                                            |

门户导出绝不含「未经验证」信息：查询构造器没有 `unverified` 列，行类型是 `PortalCdr`。后台导出是同样的列，另加一列 `验证状态`（决定 35）。时长、金额位数、未接通行的写法和排序按决定 34。

**公式注入转义（决定 10）。** `neutralizeCsvFormula` 的规则：

- 以 `=` 或 `@` 开头，前面加单引号 `'`。
- 以 `+` 或 `-` 开头，且整个单元格不是带符号的数字，前面加单引号。
- `+447700900123`、`-35.20`、`+1300.00` 原样输出。
- 开头是制表符或回车也加单引号。

话单与流水的全部单元格都过同一个 `csvCell`，数值列是 canonical decimal string，天然通过。决定里的「纯数字」按字面会让 `-35.20` 这样的负金额也被加引号，数值列在 Excel 里变成文本，所以这里把带符号的十进制数也算数字，并加了制表符与回车。这两处是对决定 10 的解读，用户已于 2026-10-18 确认（决定 33）。

**浏览器怎么下载。** 现有 `callApi` 只处理 JSON。新增 `callDownload(operation, input)`：

1. `fetch(url, {method: 'POST', credentials: 'same-origin', body})`，cookie 自动带上，Origin 头由浏览器附加。
2. 响应 ok 时 `await response.blob()`，从 `Content-Disposition` 取文件名，用 `downloadBlob` 触发保存。浏览器内存最多一份 CSV，大租户一个月约 26 MB（234,277 条按每条约 112 字节估算，没有实测），可接受。
3. 响应不 ok 时按 JSON 错误解析，抛 `ApiRequestError`。401 `reauthenticate` 走现有登录过期对话框（`needsReauthentication`），登录后回到原页面，用户再点一次导出。400、429、5xx 在导出按钮旁显示错误和「重试」。
4. 网络中断（`fetch` 或 `blob()` 拒绝）抛 `ApiRequestError(0)`，提示「导出中断，请重试」，不保存任何内容。服务端在中途失败时销毁连接而不是正常结束，就是为了让浏览器不会把截断的文件当成完整文件。
5. 导出期间按钮显示进行中并禁用，防止重复点击占满名额。

会话只在请求开始时校验一次。下载进行中会话过期不影响这次导出，下一次请求才会 401。

**后台导出的审计时机。** 受理时先在一个短事务里 `count(*)` 同一筛选条件并写 `cdr_export`（`rowCount` 为受理时的匹配条数，`filters` 为归一化后的筛选条件），提交后再开游标事务。审计因此不依赖传输是否完成，也不让写事务跟着慢客户端一起悬着。条数是受理时的匹配数，传输期间新入库的话单不在其中，因为游标事务的快照可能晚几毫秒。审计失败时返回 500，不写任何字节。客户导出不写日志，操作日志只记管理员。时机已确认（决定 36）。

### 余额流水

**一条合并查询，两个受众。** 门户与后台的流水共用 `packages/db/src/ledger-merge.ts` 的构造器，只在最终 select 上不同。后台现状（`packages/db/src/admin/balance.ts:41`）对每一行执行一个相关子查询求所有更早流水之和，9 月一页 50 行要读 272 万行 50 次，约 54 秒。合并查询取而代之。

```sql
WITH anchor AS (                                    -- 范围开始前的余额，两种写法见下
  SELECT coalesce(sum(amount), 0) AS a FROM ledger_entries
  WHERE tenant_id = $1 AND occurred_at < $2),
merged AS (
  SELECT CASE WHEN kind = 'call_charge' THEN NULL ELSE id END AS id,
         (array_agg(id ORDER BY occurred_at DESC, id DESC))[1] AS sort_id,  -- 内部排序键，不输出
         kind,
         (occurred_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
         max(occurred_at) AS at, count(*)::int AS calls, sum(amount) AS amount,
         max(note) AS note
  FROM ledger_entries
  WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at < $3
  GROUP BY 1, 3, 4),
windowed AS (
  SELECT merged.*, anchor.a + sum(amount) OVER (ORDER BY at, sort_id) AS balance_after
  FROM merged, anchor),
filtered AS (SELECT * FROM windowed WHERE $4::text IS NULL OR <类型条件>),
stats AS (SELECT count(*)::int AS total, coalesce(sum(amount), 0) AS total_amount FROM filtered),
page AS (SELECT * FROM filtered ORDER BY at DESC, sort_id DESC LIMIT $5 OFFSET $6)
SELECT p.*, stats.total, stats.total_amount
FROM stats LEFT JOIN page p ON true                 -- stats 恒为一行，先分页再并入，页空也有元数据
ORDER BY p.at DESC NULLS LAST, p.sort_id DESC;
```

`stats` 是一行聚合，恒有一行；`page` 先取出当前页，再用 `LEFT JOIN ... ON true` 把页并到 `stats` 上。筛选结果为空，或页码超出最后一页时，`page` 没有行，结果仍是一行：`p.*` 全为 NULL，`total` 与 `total_amount` 照常返回。服务端按 `p.sort_id IS NULL` 判断这一行没有数据（合并行的 `id` 本来就是 NULL，所以不能用 `id` 判断），`items` 为空数组，`pagination.total` 与 `totalAmount` 取这一行的值，不会因为页空而丢失。早先的写法是 `filtered` 与 `stats` 直接 join 再 OFFSET，页空时零行，两个数一起消失。

门户的 select 把 `credit_recharge` 投影为 `recharge`，把它的备注换成常量 `PORTAL_CREDIT_RECHARGE_NOTE`（`账户充值`），不读 `created_by`，不 join `receivables`。后台的 select 保留原始 `kind` 和备注，只对**当前页**的人工流水行 join `receivables` 和 `admins`，不对整月 join。响应里的 `balance` 是同一条语句内读到的 `tenant_balances.balance`。

**合并行的时间与余额（决定 1）。** 通话扣费按 `occurred_at` 的北京日合并成一行。行的时间是当天最大的 `occurred_at`，即最后一笔扣费的接通时间。`balanceAfter` 是把所有行按 `(at, id)` 升序排列后，到这一行为止的累计余额，所以每一行的余额等于下一行（时间更早的一行）的余额加本行金额。同一天的充值、赠送、调账按各自时间穿插在合并行之间。

例子。范围开始前余额 100.00。9 月 23 日有三笔扣费，09:00 为 -1.00、12:00 为 -2.00、15:00 为 -3.00，10:00 有一笔充值 +50.00。合并后两行：

| 时间（北京） | 类型     | 金额  | 变动后余额 |
| ------------ | -------- | ----- | ---------- |
| 15:00        | 通话扣费 | -6.00 | 144.00     |
| 10:00        | 充值     | 50.00 | 150.00     |

充值那一行的 150.00 是显示顺序里的累计，不是 10:00 那一刻的瞬时余额（瞬时余额是 149.00，因为 09:00 那笔扣费已经发生）。这是「按天合并成一行」的必然结果：09:00 的扣费被并进 15:00 的行。合并行的余额等于逐笔窗口里当天最后一笔扣费之后的真实余额，性能原型的 `verify` 对此做了断言。

**同一时刻的排序。** 行的内部排序键是 `(at, sort_id)`。人工流水的 `sort_id` 是自己的 `id`；合并行的 `sort_id` 是当天最后一笔扣费的 `id`，也就是按 `(occurred_at, id)` 排最后的那一笔，它与 `at` 取自同一笔流水。`sort_id` 不出现在响应里，合并行的对外 `id` 仍为 NULL（响应里合并行没有 `id`）。这样合并行的位置恰好是逐笔窗口里最后一笔扣费的位置，同一时刻的人工流水与它的先后由两者的 `id` 决定，和逐笔余额一致。

例子。范围开始前余额 100.00，9 月 23 日扣费 -1.00（09:00）、-2.00（12:00）、-3.00（15:00，`id` 为 b），同在 15:00 还有一笔充值 +50.00（`id` 为 a，a 小于 b）。逐笔余额：99.00、97.00，充值后 147.00，最后一笔扣费后 144.00。合并后充值行排在合并行前面，充值行 150.00，合并行 144.00，等于逐笔里最后一笔扣费之后的真实余额。如果合并行的排序键是 NULL 且排在前面，合并行会算成 94.00，与上面的保证矛盾。降序显示时，合并行排在同一时刻、`id` 更小的人工流水之前，`id` 更大的之后。

**今天那一行。** `partial = (day = 读取时的北京当天)`，北京当天由同一条语句里的 `statement_timestamp()` 决定，与概况的 `asOf` 同一时钟。文本为 `2026-09-29 通话扣费（截至当前），共 1,702 通`，由 `formatMergedChargeNote` 生成，页面和 CSV 共用。当天后续的扣费会更新这一行的时间、金额、通数和余额。已过去的日子也会变：扣费异步入账，晚到的扣费仍按它的 `occurred_at` 落在原来那一天，同时抬高之后所有行的累计余额。

**锚点（范围开始时的余额）。** 阶段 6 没有月账单，有两种写法，查询前选便宜的那种。

- `prior`：范围开始前全部流水之和。
- `balance`：`tenant_balances.balance` 减去 `occurred_at >= 范围开始` 的全部流水之和。余额缓存由触发器与流水同事务维护，同一条语句内读到的是同一个快照。

两者代价都与要读的行数成正比。流水量随时间大致均匀，所以用时间距离估计行数：`balance` 要读「范围开始到现在」，`prior` 要读「租户创建到范围开始」，选距离短的。租户行有 `created_at`。选错只影响速度，不影响结果，DB 测试断言两种写法在每个月份给出相同余额。阶段 7 有月账单后改用「最近一张月账单期末加其后到范围开始的流水」，代价与月份新旧无关。

补测在 PORTALBIG（每月约 24 万条扣费）上测了最坏的历史中段月份。整条查询，单位 ms，3 遍，InitPlan 策略。**下表和下面的耗时都是修正排序键之前的聚合的实测**（当时按 `at, id NULLS FIRST` 排序和开窗，合并行没有 `array_agg(id ORDER BY occurred_at DESC, id DESC)` 算出的 `sort_id`，提交 2c73e71 之前）。新查询还没有测，PR 2 用同一个脚本（`packages/db/scripts/portal-perf.ts`）在 `fs_billing_perf` 上重测并把结果写进 `docs/perf/portal-cdrs.md`，验收见 PR 拆分。

| 月份    | prior 锚点          | balance 锚点        | 选取         |
| ------- | ------------------- | ------------------- | ------------ |
| 2025-12 | 140.4, 122.0, 122.9 | 344.3, 357.3, 345.2 | prior        |
| 2026-04 | 291.1, 279.4, 268.8 | 281.1, 288.8, 282.0 | 任一，约 280 |
| 2026-09 | 352.0, 356.0, 384.6 | 134.9, 124.5, 124.7 | balance      |

原策略下 2026-04 整条查询是 prior 764 至 1102、balance 810 至 910，所以锚点读取在 RLS 改写之前会超过 500 ms，改写之后最坏约 0.3 s。单独看锚点求和：现有索引原策略 548 至 551 ms，InitPlan 189 至 191 ms，覆盖索引 `(tenant_id, occurred_at) INCLUDE (amount)` 原策略 460 至 486 ms，所以 RLS 改写的收益大于覆盖索引，阶段 6 不加这个索引。

**日期与类型筛选。** 范围是整北京日，合并行不会被范围切开。顺序是先按日期取行并合并，再算窗口余额，再按类型筛选，最后分页。这样 `balanceAfter` 永远是未筛选列表里的累计余额，筛选后相邻两行的余额差不再等于金额，这是预期的。`total` 与 `totalAmount` 是筛选后全部行的条数和金额合计。分页针对合并后的行：`LIMIT` 和 `OFFSET` 在窗口与筛选之后，页空时 `total` 与 `totalAmount` 仍随单行结果返回，同一天的扣费是一行，不会被页边界切开，`pagination.total` 是合并后的行数，不是流水笔数。门户 `kind=recharge` 包含赊账充值，`kind=call_charge` 只剩合并行。

**合并流水在后台的切换（决定 2）。** `adminTenantLedger` 改用同一个构造器，行为变化有三个：通话扣费显示为按天合并的行，日期筛选从 ISO 时刻变成必填的北京日范围（Web 的 `beijingDayRange` 随之删除，页面本来就默认当月 1 日到今天），范围同样不超过一个月。后台额外显示收款状态、操作人、内部备注，赊账行仍标「仅内部可见」。

**流水 CSV（决定 4）。** 与页面一致：通话扣费按天合并（备注含通数），其他类型逐笔。列依次是 `时间`、`类型`、`金额`、`变动后余额`、`备注`，类型用中文（充值、赠送、调账、通话扣费），金额带符号的精确值，表头注明币种。范围同样不超过一个月，行数最多几十行，仍走同一个流式响应，不另写一套下载代码。

### 门户首页

`portalHome` 在一个 `withTenant` 事务里读取：租户行与余额（health 用抽出的共享 SQL，与后台列表同一份）、`readTenantUsageOverview`（只取 `tenantUsageWindowFields` 里的字段，显式逐字段构造，不展开）、最近 10 通已接通话单。

- `availableBalance` 是余额加透支额度，`health` 由 `tenantHealthSchema` 定义。已停机（`suspended`）时页面顶部显示设计稿 1c 的横幅「余额不足，已暂停呼叫」和「请联系客服充值，到账后自动恢复呼叫。」。
- 消费、分钟、30 天口径沿用 [阶段 5 设计](phase-5-design.md#已决定概况与门户首页2026-10-15-0156-pt)：消费只算 `call_charge`，分钟是计费分钟，已接通按接通时间归属，最近 30 天含今天、缺失补零，所有租户按北京时间。门户不显示未接通通数，`unansweredCalls` 在 schema 里不存在。
- 最近话单（`portalRecentCallSchema`，`answeredAt` 不可为空）：`WHERE tenant_id = $1 AND answered_at IS NOT NULL ORDER BY answered_at DESC, call_uuid DESC LIMIT 10`，不加日期下界。补测在 14 个分区上用 Merge Append 取前 10 条，热态 0.2 ms，没有任何话单的租户 26.8 ms。只含已接通（决定 29）。
- 空状态（设计稿 1d）：`recentCalls` 为空时显示「还没有通话记录」。
- `health = 'disabled'`（管理员停用租户）的显示见决定 28。
- 概况查询还会为后台统计未接通通数，门户用不到，多约 5 至 8 ms，不为此改查询。概况的接通月份 CTE 没有 `started_at` 下界，会扫描到 `month_end` 为止的所有分区的索引，这里可以顺手加上同一个 31 天下界，PR 4 实测后再决定，本步不改。

### 账号设置与强制改密页

账号设置页（设计稿第三批 2a 至 2e）显示：登录邮箱、租户名称、编码、币种（只读，来自 `session`）、修改密码、主题、退出登录。修改密码的表单与强制改密页相同：当前密码、新密码（至少 8 位）、确认新密码。

现有 `ChangePasswordPage` 把表单放在登录布局里，`forced` 为真时隐藏「返回」。PR 6 把表单和提交逻辑抽成 `ChangePasswordForm`，两处共用：

| 项目         | 强制改密页                                        | 账号设置页                                           |
| ------------ | ------------------------------------------------- | ---------------------------------------------------- |
| 布局         | 登录布局，没有导航                                | AppShell，有导航                                     |
| 进入条件     | 会话 `passwordChangeRequired` 为真                | 菜单「账号设置」                                     |
| 当前密码提示 | 「管理员提供的临时密码」                          | 无                                                   |
| 成功后       | 清除限制，回到进入前的页面                        | 留在原页，显示「密码已修改，其他设备上的登录将失效」 |
| 服务端行为   | 同一个 `changePassword`：撤销其他会话并签发新会话 | 相同                                                 |

账号设置页的错误展示、锁定提示、服务不可用提示沿用现有 `Problem` 类型。设置页的 `changePassword` 成功响应会替换 cookie，页面需要用新的 `session` 刷新缓存，沿用现有 `sessionQueryKey`。导航里不出现「月账单」，随阶段 7 加入。

### Web 复用与改动

页面细节以设计稿为准，下表只列要复用或要改的现有文件。

| 文件                                                       | 复用或改动                                                                                                                                                                   | PR   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `lib/api.ts`                                               | `webApiContract` 并入 `adminCdrApiContract` 与 `portalApiContract`。新增 `callDownload`：POST、`blob()`、读 `Content-Disposition`，错误走同一个 `ApiRequestError`            | 3–5  |
| `lib/download.ts`                                          | 现有 `downloadText` 只接字符串，新增 `downloadBlob(filename, blob)`                                                                                                          | 5    |
| `lib/day-range.ts`                                         | 复用 `rangeOrMonthToDate` 作默认值（当月 1 日到今天）。结束日上限用共享的 `latestRangeEnd`                                                                                   | 5    |
| `components/date-range-field.tsx`                          | 新增上限参数，月历把超出开始日加一个月的日期置灰，并显示设计稿 2f 的「最长一个月」。现在只有 `max` 一个上限                                                                  | 5    |
| `components/filter-sheet.tsx`                              | 手机筛选面板，话单（2e）和流水（5e）共用，已有                                                                                                                               | 5, 6 |
| `components/pagination.tsx`                                | 现有组件是前端分页（`pageSlice`）。服务端分页复用 `Pagination`，`rowCount` 传 `pagination.total`，页码来自地址；另加「第 1–50 条，共 N 条」文字                              | 5, 6 |
| `components/data-format.tsx`                               | `Money`、`Rate`、`DateTime` 已有。合并行的备注由 `formatMergedChargeNote` 生成。国家显示共用 `packages/shared` 的 `formatCountryLabel`，话单列表、详情和首页最近话单均使用它 | 5, 6 |
| `components/status-tag.tsx`                                | `answered`、`unanswered`、`unverified` 标签已有。`unverified` 只在后台话单组件里引用，门户组件不 import                                                                      | 5    |
| `components/admin/tenant-status.tsx`                       | 其中 `healthStatus` 门户首页也要用，PR 4 移到 `components/tenant-health.tsx`，后台与门户从那里取                                                                             | 4    |
| `components/cdr/*`（新）                                   | 话单表格、手机卡片、详情对话框、汇总栏，电脑与手机一套组件。组件按 `PortalCdr` 写，后台版本包一层传入 `unverified` 渲染插槽，门户不传                                        | 5    |
| `lib/admin-search.ts`                                      | `LedgerSearch` 的 `kind` 沿用，新增话单标签页的地址状态（范围、被叫、国家、状态、仅看未经验证、页码）；门户另有 `lib/portal-search.ts`，筛选写入地址，刷新与登录过期后保留   | 5, 6 |
| `pages/admin/tenant-tabs/ledger-tab.tsx`                   | 删除 `beijingDayRange`，按判别联合渲染人工流水与合并行，合并行不显示收款状态与操作人                                                                                         | 2    |
| `pages/admin/tenant-tabs/cdrs-tab.tsx`（新）、`tenantTabs` | 后台话单标签页。「删除话单」与「查看告警」不显示                                                                                                                             | 5    |
| `pages/home.tsx`                                           | `PortalHome` 换成 `pages/portal/home.tsx`；`AdminHome` 不动                                                                                                                  | 4    |
| `components/app-shell.tsx`                                 | 门户导航加「话单」「余额流水」「账号设置」，各随自己的 PR，不加「月账单」                                                                                                    | 4–6  |
| `router.tsx`                                               | 加 `/portal/cdrs`、`/portal/ledger`、`/portal/settings` 和后台租户详情的 `cdrs` 标签                                                                                         | 4–6  |
| `pages/change-password.tsx`                                | 抽出 `ChangePasswordForm`，强制改密页与账号设置页共用                                                                                                                        | 6    |

### 挂断原因表（决定 8）

`cdrs.hangup_cause` 存 FreeSWITCH 的 `switch_cause_t` 名字。页面详情和 CSV 都显示 `NAME（中文）`，未收录的原因只显示英文原文，入库默认的空串显示为空。下表是建议的全部 46 项，Q.850 编号只用于审阅，「无」表示该原因是 FreeSWITCH 或 SIP 自己的编码。**请审阅译法，增删后表和测试一起改。**

| FreeSWITCH 原因             | Q.850 | 中文                   |
| --------------------------- | ----- | ---------------------- |
| `NORMAL_CLEARING`           | 16    | 正常挂断               |
| `NORMAL_UNSPECIFIED`        | 31    | 正常结束，未说明原因   |
| `ORIGINATOR_CANCEL`         | 无    | 主叫在接通前取消       |
| `NO_ANSWER`                 | 19    | 无人应答               |
| `NO_USER_RESPONSE`          | 18    | 被叫无响应             |
| `USER_BUSY`                 | 17    | 被叫忙                 |
| `CALL_REJECTED`             | 21    | 被叫拒接               |
| `SUBSCRIBER_ABSENT`         | 20    | 被叫不在服务区         |
| `UNALLOCATED_NUMBER`        | 1     | 空号                   |
| `NO_ROUTE_DESTINATION`      | 3     | 没有到达该号码的路由   |
| `NO_ROUTE_TRANSIT_NET`      | 2     | 没有到达中转网络的路由 |
| `INVALID_NUMBER_FORMAT`     | 28    | 号码格式错误           |
| `NUMBER_CHANGED`            | 22    | 号码已变更             |
| `DESTINATION_OUT_OF_ORDER`  | 27    | 被叫线路故障           |
| `NETWORK_OUT_OF_ORDER`      | 38    | 网络故障               |
| `NORMAL_TEMPORARY_FAILURE`  | 41    | 临时故障               |
| `NORMAL_CIRCUIT_CONGESTION` | 34    | 线路拥塞               |
| `SWITCH_CONGESTION`         | 42    | 交换设备拥塞           |
| `REQUESTED_CHAN_UNAVAIL`    | 44    | 请求的通道不可用       |
| `EXCHANGE_ROUTING_ERROR`    | 25    | 路由错误               |
| `FACILITY_REJECTED`         | 29    | 业务被拒绝             |
| `FACILITY_NOT_SUBSCRIBED`   | 50    | 未开通该业务           |
| `OUTGOING_CALL_BARRED`      | 52    | 呼出受限               |
| `INCOMING_CALL_BARRED`      | 54    | 呼入受限               |
| `BEARERCAPABILITY_NOTAUTH`  | 57    | 承载能力未授权         |
| `BEARERCAPABILITY_NOTAVAIL` | 58    | 承载能力不可用         |
| `SERVICE_UNAVAILABLE`       | 63    | 服务不可用             |
| `INCOMPATIBLE_DESTINATION`  | 88    | 目的地不兼容           |
| `RECOVERY_ON_TIMER_EXPIRE`  | 102   | 信令超时               |
| `PROTOCOL_ERROR`            | 111   | 协议错误               |
| `INTERWORKING`              | 127   | 网络互通异常           |
| `ALLOTTED_TIMEOUT`          | 无    | 达到最长通话时长       |
| `MEDIA_TIMEOUT`             | 无    | 媒体超时               |
| `PROGRESS_TIMEOUT`          | 无    | 呼叫进展超时           |
| `USER_NOT_REGISTERED`       | 无    | 用户未注册             |
| `GATEWAY_DOWN`              | 无    | 网关不可用             |
| `MANAGER_REQUEST`           | 无    | 系统请求挂断           |
| `LOSE_RACE`                 | 无    | 已由其他分支应答       |
| `PICKED_OFF`                | 无    | 被代接                 |
| `BLIND_TRANSFER`            | 无    | 盲转接                 |
| `ATTENDED_TRANSFER`         | 无    | 协商转接               |
| `BUSY_EVERYWHERE`           | 无    | 所有路径均忙           |
| `DECLINE`                   | 无    | 被叫拒绝               |
| `DOES_NOT_EXIST_ANYWHERE`   | 无    | 号码不存在             |
| `NOT_ACCEPTABLE`            | 无    | 不接受该呼叫           |
| `UNWANTED`                  | 无    | 被判定为骚扰呼叫       |

名字与编号依据 FreeSWITCH `switch_types.h` 的 `switch_cause_t` 和 ITU-T Q.850，仓库里没有 FreeSWITCH 源码，部署版本是 1.11.3（[freeswitch.md](freeswitch.md)）。PR 3 实现时要对照该版本核对一遍，漏掉的常见原因再补。

### RLS InitPlan 改写

决定 9：把租户范围表的策略从逐行调用 `current_setting()` 改成 InitPlan 形式，语义不变，单独一个 PR，排在话单接口之前，跑完整 `pnpm test:db` 与 `pnpm test:idor`，交 Codex 审查后合并。

**原因。** `tenant_read` 是 `app_can_see(tenant_id)`，函数内联后每个扫描节点的 `Filter` 里逐行求值 `current_setting('app.scope')` 和 `nullif(current_setting('app.tenant_id'), '')::uuid`。汇总、搜索这类扫描月内约 24 万行的查询，约四分之三的时间花在这里。

**改写后的谓词。**

```sql
ALTER POLICY tenant_read ON <表> USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id())));
```

谓词变成只求值一次的 InitPlan。两种写法对三值逻辑等价：`app.scope` 未设置时 `app_is_operator()` 为 false，`app_scope() = 'tenant'` 为 NULL，整个 OR 为 NULL 或 false，策略把 NULL 当作不可见，与现在 `app_can_see` 返回 NULL 一致。`app.tenant_id` 未设置时 `tenant_id = NULL` 为 NULL，同样不可见。

**范围。** 迁移 0000 和 0006 里用 `app_can_see(<租户列>)` 创建了 `tenant_read` 的 13 张表，只改这 13 条 `tenant_read` 策略，不改其他策略：

| 表                                                                                                                                                                                                    | 租户列      | 来源 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---- |
| `tenants`                                                                                                                                                                                             | `id`        | 0000 |
| `portal_accounts`、`rate_versions`、`rate_entries`、`ledger_entries`、`receivable_settlements`、`tenant_balances`、`cdrs`、`monthly_statements`、`balance_alert_settings`、`balance_alert_deliveries` | `tenant_id` | 0000 |
| `receivable_settlement_reversals`、`receivable_voids`                                                                                                                                                 | `tenant_id` | 0006 |

不改的策略和理由。

- `operator_update`、`operator_insert`、`operator_delete`：只在写路径求值，每次写入一行，没有测到收益，也不碰写语义。`operator_update` 的 `USING (app_can_see(...))` 保持原样。
- `staff_only`（`admins`、`operation_logs`、`raw_cdrs`、`unassigned_cdrs`、`system_alerts`、`call_uuids`）和 `admin_previews`：不是租户范围，不在客户读路径上。
- `cdrs` 的分区子表：策略挂在父表，`ALTER POLICY` 一次生效。

**验证。**

- 迁移后查 `pg_policies`：13 张表的 `tenant_read.qual` 都是 InitPlan 形式。新增一个 DB 测试枚举所有带 `tenant_id` 且启用 RLS 的表，断言 `tenant_read` 是该形式，以后新增租户表漏写会直接失败。
- 语义测试：scope 未设置、仅设置 `app.tenant_id`、`app.tenant_id` 为空串、`tenant`、`admin`、`system` 各一组，对每张表断言可见行数与改写前相同。
- 完整 `pnpm test:db` 与 `pnpm test:idor`。
- 在同一 `fs_billing_perf` 数据和索引上交替测汇总、深翻页、搜索，并保留实际 `EXPLAIN ANALYZE` 计划；这些是 PostgreSQL 查询执行时间，不是 HTTP 页面延迟。
- 用未改动的 Worker 授权脚本、同一主机和相同数据库克隆交替测 p95。阶段 3 的 5.5–6.3 ms 是历史值，不作本次基线。用户于 2026-10-18 确认按现有 50 ms p95 上限验收，并要求完整披露两轮差异；不把通过上限解释为没有回退。结果与方法见 [PR 1 验收记录](evidence/phase-6-pr1/README.md)。

既有原型证据在 [rls-initplan.txt](perf/portal-cdrs/probes/rls-initplan.txt)；本 PR 的新测量与实际计划保存在[验收证据目录](evidence/phase-6-pr1/README.md)。

## 已决定

下表列出用户在 2026-10-17 与 2026-10-18 对话中确认的决定、既有文档已定的规则和实测决定的技术方案，每项写明来源和落实位置。已决定不表示后续实现已完成。

| #   | 决定                                                                                                                                                                                         | 来源                                        | 落实                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| 1   | 按天合并的行：时间为当天最后一笔扣费的接通时间（该日最大 `occurred_at`），变动后余额为这一笔之后的累计余额，按 `occurred_at` 排序，同日人工流水按各自时间穿插                                | 用户确认                                    | [余额流水](#余额流水)；`MergedChargeRow`；PR 2               |
| 2   | 后台租户详情的余额流水也按天合并，与门户共用合并查询，另显示收款状态、操作人、内部备注，替换逐行相关子查询（54 s）                                                                           | 用户确认                                    | [余额流水](#余额流水)；`AdminMergedLedgerRow`；PR 2          |
| 3   | 话单 CSV 列等于表格列加详情字段，门户导出不含「未经验证」。其中国家由 ISO、国家、说明三列取代，见 [rate-list-design.md](rate-list-design.md)                                                 | 用户确认                                    | [话单导出](#话单导出)；PR 3                                  |
| 4   | 余额流水 CSV 与页面一致：通话扣费按天合并（含通数），其他类型逐笔                                                                                                                            | 用户确认                                    | [余额流水](#余额流水)；PR 3                                  |
| 5   | 管理员导出话单写操作日志 `cdr_export`（租户、筛选条件、条数），客户导出不写                                                                                                                  | 用户确认                                    | `cdr_export` 审计变体；PR 3                                  |
| 6   | 验收截图：电脑透支 1a、手机透支 1b、手机停机 1c、手机无话单 1d，各含浅色与深色；电脑端停机、无话单只存档，按手机稿核对                                                                       | 用户确认                                    | PR 7                                                         |
| 7   | 国家筛选选项为所选日期范围内该租户话单中出现过的国家（不含说明）                                                                                                                             | 用户 2026-10-19 确认（费率表五列）          | `cdrCountriesResponseSchema`；PR 3                           |
| 8   | 挂断原因中文对照表放在 `packages/shared`，写进设计文档供审，未收录显示英文原文，形如 `NORMAL_CLEARING（正常挂断）`                                                                           | 用户确认                                    | `hangup-cause.ts`；[挂断原因表](#挂断原因表决定-8)           |
| 9   | RLS 策略改写为 InitPlan，单独一个 PR，在话单接口之前，跑 `pnpm test:db` 与 `pnpm test:idor`，Codex 审查                                                                                      | 用户确认（第二批）                          | [RLS InitPlan 改写](#rls-initplan-改写)；PR 1                |
| 10  | CSV 公式注入只中和危险内容，纯号码原样，话单与流水共用一个转义函数                                                                                                                           | 用户确认（第二批）                          | `csvCell`；解读见[话单导出](#话单导出)                       |
| 11  | 界面细节以设计稿为准，业务规则以 design.md 为准                                                                                                                                              | [plan.md](plan.md) 开头                     | 全部                                                         |
| 12  | 已停机横幅文字采用设计稿 1c                                                                                                                                                                  | 既有规则，用户知悉                          | [门户首页](#门户首页)；PR 4                                  |
| 13  | 话单日期归属：已接通按 `answered_at`，未接通按 `started_at`                                                                                                                                  | design.md §5、§7.7、§12                     | [话单列表](#话单列表汇总与国家)                              |
| 14  | 赊账充值对客户：类型「充值」、备注「账户充值」，内部备注不外露                                                                                                                               | plan 阶段 6 范围、设计稿                    | `PortalLedgerRow`；[余额流水](#余额流水)                     |
| 15  | 未开发功能不显示：门户「月账单」导航（阶段 7）、后台「删除话单」（阶段 8）、「查看告警」链接（阶段 9）                                                                                       | 阶段 4、5 做法                              | PR 4–6                                                       |
| 16  | 话单日期范围最长一个月，服务端同样校验                                                                                                                                                       | 既有文档与设计稿，用户知悉未提异议          | `checkDayRange`；精确规则见决定 26                           |
| 17  | 门户与后台话单使用不同的严格 schema，门户没有 `unverified` / `billing_unverified` 的任何字段或信息                                                                                           | 既有文档与设计稿，用户知悉未提异议          | `portalCdrSchema`、`adminCdrSchema`                          |
| 18  | 分页用 OFFSET 加总数，keyset 留作储备                                                                                                                                                        | 实测，[portal-cdrs.md](perf/portal-cdrs.md) | [话单列表](#话单列表汇总与国家)                              |
| 19  | 汇总每次请求一条聚合查询，总数取自同一条，已接通视图另加一条未接通计数，不做预聚合                                                                                                           | 实测                                        | 同上                                                         |
| 20  | 验收不加新索引，`cdrs_tenant_all_keys`、`cdrs_tenant_answered_keys` 不加                                                                                                                     | 实测                                        | 同上                                                         |
| 21  | 被叫模糊搜索用 `billing_number LIKE '%q%'`，不建 trigram，查询词先规范化，细节由设计文档定并注明理由                                                                                         | 实测，用户确认                              | [被叫号码搜索](#被叫号码搜索)                                |
| 22  | 国家筛选用 `country = ?`，不建索引                                                                                                                                                           | 实测                                        | 同上                                                         |
| 23  | 「全部」视图排序 `coalesce(answered_at, started_at) DESC, call_uuid DESC`                                                                                                                    | 实测                                        | 同上                                                         |
| 24  | 流水先按北京日合并再在合并行上开窗；阶段 6 锚点取「该月之前的流水合计」与「当前余额减该月之后流水合计」中便宜的一种，阶段 7 改用月结期末余额                                                 | 实测，用户确认                              | [余额流水](#余额流水)                                        |
| 25  | 导出用 `DECLARE NO SCROLL CURSOR` 加 `FETCH 5000` 流式写响应，必须配 `statement_timeout`、`idle_in_transaction_session_timeout` 和连接池上限                                                 | 实测                                        | [话单导出](#话单导出)                                        |
| 26  | 「最长一个月」的精确规则：一个月 = 结束日最晚为开始日加一个日历月的前一天，下月没有同一天时取下月最后一天（`09-15` 至 `10-14`，`01-31` 至 `02-27`）                                          | 用户 2026-10-18 确认                        | `checkDayRange`；PR 3                                        |
| 27  | 余额流水的日期范围与话单一样最长一个月，默认本月                                                                                                                                             | 用户 2026-10-18 确认                        | [余额流水](#余额流水)；PR 2、PR 6                            |
| 28  | 停用租户的门户首页显示灰色「已停用」标签，不显示停机横幅                                                                                                                                     | 用户 2026-10-18 确认                        | [门户首页](#门户首页)；PR 4                                  |
| 29  | 首页「最近 10 通话单」只含已接通，空状态为「没有通话记录」                                                                                                                                   | 用户 2026-10-18 确认                        | [门户首页](#门户首页)；PR 4                                  |
| 30  | 首页图表悬浮提示不显示通数，只显示金额                                                                                                                                                       | 用户 2026-10-18 确认                        | [门户首页](#门户首页)；PR 4                                  |
| 31  | 话单「被叫号码」列显示 `callee`（客户拨出的原始号码），CSV 同；搜索按 `billing_number` 匹配并做归一化                                                                                        | 用户 2026-10-18 确认                        | [被叫号码搜索](#被叫号码搜索)；PR 3、PR 5                    |
| 32  | 后台未经验证横幅去掉故障开始时间、关联告警、查看告警三项，其余文字不变                                                                                                                       | 用户 2026-10-18 确认                        | PR 5                                                         |
| 33  | CSV 公式转义决定 10 的两条解读都采纳：带符号十进制数（`-35.20`、`+1300.00`）算数字原样导出；开头是制表符或回车也加单引号                                                                     | 用户 2026-10-18 确认                        | `csvCell`；[话单导出](#话单导出)                             |
| 34  | CSV 列值格式按推荐方案：时长用数字加单位表头（`通话时长(秒)`、`计费时长(分钟)`），费率固定 4 位小数，费用与金额用存储的精确值，未接通行与页面一致，导出按时间升序                            | 用户 2026-10-18 确认                        | [话单导出](#话单导出)；PR 3                                  |
| 35  | 后台话单导出多一列「验证状态」，值为「未经验证」或空                                                                                                                                         | 用户 2026-10-18 确认                        | [话单导出](#话单导出)；PR 3                                  |
| 36  | `cdr_export` 审计在受理导出时写，条数为受理时匹配条数                                                                                                                                        | 用户 2026-10-18 确认                        | `cdr_export` 审计变体；PR 3                                  |
| 37  | 余额流水每页 25 条；国家下拉按通话数降序；已接通视图的汇总写「另有未接通 N 通」                                                                                                              | 用户 2026-10-18 确认                        | PR 2、PR 3、PR 5                                             |
| 38  | 挂断原因表 46 条批准。PR 3 必须对照 FreeSWITCH 1.11.3 源码（`switch_types.h`、`switch_channel.c` 原因表）核对 `packages/shared/src/hangup-cause.ts` 的每个原因名，有出入先报告用户，再改译法 | 用户 2026-10-18 确认                        | [挂断原因表](#挂断原因表决定-8)；PR 3                        |
| 39  | 话单分开保存 ISO、国家、说明；国家筛选和汇总只按国家；列表显示「国家 · 说明」                                                                                                                | 用户 2026-10-19 确认（费率表五列）          | [rate-list-design.md](rate-list-design.md)；PR A、PR 4、PR 5 |

本设计自行定的取值没有用户确认，已写明理由，其中涉及产品行为的已由用户在 2026-10-18 确认（决定 26 至 38）。仍属本设计自定的是：`started_at` 下界 31 天（有实测，无产品含义）、被叫搜索词的归一化规则、导出的超时、并发和连接池数值（初始值，PR 3 实测后定）、锚点按时间距离选择、PR 拆分。

阶段 5 留给阶段 6 的项目在这里关闭。门户流水必须是独立 projection，不引用后台流水或应收 schema（[阶段 5 设计](phase-5-design.md) 流水一节）：落实为 `portalLedgerRowSchema` 加 SQL 层不读内部列，防泄漏 integration 测试在 PR 2。门户首页只显示已接通通数，共享服务返回两种通数：落实为 `tenantUsageWindowFields` 不含 `unansweredCalls`。门户用 `withTenant`，不可见租户返回 `NOT_FOUND`：落实在 PR 4。

## 验收标准对应计划测试

以下逐条映射 [plan.md 阶段 6](plan.md#阶段-6客户门户) 的验收。「本步」指本 PR 已实现并通过的契约或纯函数测试，「计划」的文件未创建，不能据此勾选阶段验收。

| 验收标准                                                                      | 测试文件 / name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 类型与状态                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 客户账号看话单和流水，接口原始 JSON 不含 `billing_unverified` 和赊账内部备注  | `packages/shared/src/api/portal/portal.test.ts` / `reject the extra key %s instead of dropping it`、`cannot represent a credit recharge or its internal fields`、`carry no internal field name anywhere in their responses`；`apps/api/src/portal-cdrs.db.test.ts` / `raw JSON of list and export carries no unverified key or value`；`apps/api/src/portal-ledger.db.test.ts` / `raw JSON never carries the credit internal note, payment status or actor`；`apps/web/e2e/portal-cdrs.spec.ts` / `network responses omit unverified` | Schema 与 PR 2/3 原始 JSON 测试已实现；e2e 仍属 PR 7；pnpm check、pnpm test:db、pnpm test:idor 已于 2026-10-19 在本工作区通过                                                                                                                                                                                                                                                                           |
| 话单 CSV 导出 10 万条 30 秒内，内存不随条数线性增长                           | `apps/api/scripts/portal-export-perf.ts` 通过真实 HTTP 测 EXPORT50K、EXPORT100K、EXPORT200K；成功记录见 [`export-formal-pr3-20261019T1051Z-stream-hold-r2.exit.json`](evidence/phase-6/export-formal-pr3-20261019T1051Z-stream-hold-r2.exit.json)；DB/API 生命周期测试见 `apps/api/src/portal-cdr-export.db.test.ts` 与 `apps/api/src/export/stream-csv.test.ts`                                                                                                                                                                      | 14 个 100k 测量请求在 30 秒内；超时、重试与并发拒绝已实测。2026-10-19 的 42 个新进程 RSS 峰值不按行数成比例上升，首次请求的 RSS 高水位仍接近按行数上升。新增 40 次同进程导出测量保留了逐次 GC、RSS、完整行数和源码哈希，见 [`export-memory-20261019.json`](evidence/phase-6/export-memory-20261019.json)。有限样本的保留堆未随条数成比例增长，不能据此宣称冷启动 RSS 恒定。财务字段校验通过，见验收记录 |
| 话单列表 300 万条数据库上每页小于 500 ms                                      | `packages/db/scripts/portal-perf.ts` 的 SQL prototype 与 `apps/api/scripts/portal-list-perf.ts` 的完整 HTTP 原始记录 [`list-latency.txt`](evidence/phase-6/list-latency.txt)；补测 [design-step1.txt](perf/portal-cdrs/probes/design-step1.txt)                                                                                                                                                                                                                                                                                       | 112 个 HTTP 测量最大值 227.6 ms；含 warmups 的 128 个最大值 352.9 ms；SQL prototype 单独报告                                                                                                                                                                                                                                                                                                            |
| 透支中、已停机、无话单三种状态截图与设计稿一致                                | `apps/web/e2e/portal-visual.spec.ts` / `matches home frames 1a 1b 1c 1d in light and dark`，`docs/evidence/phase-6-web/visual-diff.md`；电脑端停机、无话单只存档                                                                                                                                                                                                                                                                                                                                                                      | Playwright 与人工差异复核，计划（PR 7）                                                                                                                                                                                                                                                                                                                                                                 |
| 时间全部北京时间：UTC 2026-09-28 16:30 接通显示 2026-09-29 00:30 并归入 29 日 | `packages/db/src/portal/cdrs.db.test.ts` / `lists a call answered at UTC 2026-09-28 16:30 under 2026-09-29 only`、`accepts from 0001-01-01 and returns only the rows inside that Beijing day`；`packages/db/src/ledger-merge.db.test.ts` / `puts a charge at UTC 2026-09-28 16:30 on the 29th`、`accepts from 0001-01-01`；`apps/web/e2e/portal-cdrs.spec.ts` / `shows 00:30 on the 29th for the 16:30 UTC call`                                                                                                                      | 北京日边界 DB 测试已在 PR 2/3 实现；Web 显示 e2e 属 PR 5，pnpm check、pnpm test:db、pnpm test:idor 已于 2026-10-19 在本工作区通过                                                                                                                                                                                                                                                                       |
| 余额流水按天合并按 `occurred_at` 的北京日分组，不是写入时间                   | `packages/shared/src/api/portal/portal.test.ts` / `keeps the merged row on its Beijing day and the sign rules`；`packages/db/src/ledger-merge.db.test.ts` / `groups charges by the Beijing day of occurred_at and not created_at`（9-30 23:59 接通、10-01 00:00:30 写入归 9-30）                                                                                                                                                                                                                                                      | 合并行形状本步；数据库计划（PR 2）                                                                                                                                                                                                                                                                                                                                                                      |

### 新增决定的验收与测试

| 验收行为                                         | 测试文件 / name                                                                                                                                                                                                                                                                                   | 状态与步骤                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 范围一个月上限，三个门户入口和三个后台入口都拒绝 | `packages/shared/src/api/day-range.test.ts` / `a range starting %s ends at the latest on %s`、`rejects one day past the month with the range message on to`；`portal.test.ts` / `caps the range at one month on the server`；`admin/cdrs.test.ts` / `caps the range at one month like the portal` | 本步                                                                                                                                                 |
| 被叫搜索归一化                                   | `portal.test.ts` / `normalizes the callee search %j to %s`、`rejects the callee search %j`                                                                                                                                                                                                        | 本步                                                                                                                                                 |
| 合并行时间、余额、今天一行、窗口顺序             | `packages/db/src/ledger-merge.db.test.ts` / `places the merged row at the last charge of the day and chains balances row by row`、`marks only today's row as partial`、`type filter keeps the running balance of the unfiltered list`                                                             | 计划（PR 2）                                                                                                                                         |
| 两种锚点结果相同                                 | 同文件 / `both anchors give the same balances in every month of the fixture`                                                                                                                                                                                                                      | 计划（PR 2）                                                                                                                                         |
| 页空时仍返回总数，同一时刻的先后                 | `packages/db/src/ledger-merge.db.test.ts` / `returns total and totalAmount for an empty filter result and an out-of-range page`、`orders a manual entry and the last charge of the day at the same instant by id`                                                                                 | 计划（PR 2）                                                                                                                                         |
| 后台与门户同一查询                               | 同文件 / `admin and portal agree on every merged row`；`apps/api/src/admin-ledger.db.test.ts` / `adds payment status, actor and internal note for admins only`                                                                                                                                    | 计划（PR 2）                                                                                                                                         |
| 赊账显示规则                                     | `apps/api/src/portal-ledger.db.test.ts` / `shows a credit recharge as a recharge with the account recharge note`                                                                                                                                                                                  | 计划（PR 2）                                                                                                                                         |
| 国家选项、汇总、未接通计数                       | `packages/db/src/portal/cdrs.db.test.ts` / `offers the countries seen in the range`、`counts hidden unanswered calls in the answered view`、`counts unverified calls for admins only`                                                                                                             | DB 服务测试已在 PR 3 实现；pnpm check、pnpm test:db、pnpm test:idor 已于 2026-10-19 在本工作区通过                                                   |
| 导出审计                                         | `apps/api/src/admin-cdr-export.db.test.ts` / `writes one cdr_export audit with the filters and the row count`、`customer export writes no audit`；`packages/shared/src/api/admin/cdrs.test.ts` / `records the tenant, the filters and the row count`                                              | 契约和后台短事务审计服务已实现；pnpm check、pnpm test:db、pnpm test:idor 已于 2026-10-19 在本工作区通过                                              |
| 导出每条退出路径的清理                           | `apps/api/src/portal-cdr-export.db.test.ts` 与 `apps/api/src/export/stream-csv.test.ts`；覆盖首批前 JSON 错误、首批后中断、close/drain、deadline、后端取消、回滚和重试                                                                                                                            | DB/API 与真实 HTTP lifecycle 结果见 PR 3 验收记录；RSS 与财务结果见验收记录。pnpm check、pnpm test:db、pnpm test:idor 已于 2026-10-19 在本工作区通过 |
| CSV 转义                                         | `packages/rating/src/csv.test.ts` / `csvCell neutralizes the formula in %j`、`csvCell keeps the plain number or text %j`、`csvCell applies the formula guard before RFC 4180 quoting`、`csvRecord joins guarded cells without a line terminator`                                                  | 本步                                                                                                                                                 |
| 挂断原因                                         | `packages/shared/src/hangup-cause.test.ts` / `shows %s with its Chinese name`、`shows an unknown cause as the English original only`、`does not match inherited object keys or other spellings`                                                                                                   | 本步                                                                                                                                                 |
| RLS InitPlan 语义不变                            | `packages/db/src/rls-initplan.db.test.ts` / `preserves tenant visibility and plans helper reads as InitPlans`；`pnpm test:db`；`pnpm test:idor`；[PR 1 验收证据](evidence/phase-6-pr1/README.md)                                                                                                  | 全量 check、DB 与 IDOR 通过；独立 Luna 审查 PASS+NOTES，无阻塞项；CI 与合并状态见 [PR #40](https://github.com/SpaceEggs/fs-billing/pull/40)          |
| IDOR：6 个客户操作均在越权测试里                 | `apps/api/src/idor.db.test.ts` 的 `cases` 与 `caseKinds` 覆盖 `portalHome`、`portalCdrs`、`portalCdrCountries`、`portalCdrsExport`、`portalLedger`、`portalLedgerExport`，`isolationCase` 为 `tenant-read`，由 `generateOpenApi` 的覆盖检查强制                                                   | `portalLedger` 在 PR 2；四个 CDR/导出操作在 PR 3；`portalHome` 在 PR 4；最终测试待运行                                                               |
| 门户操作不引用后台 schema                        | `portal.test.ts` / `do not reference any admin schema`                                                                                                                                                                                                                                            | 本步                                                                                                                                                 |
| 首页不含未接通通数，30 天窗口、状态              | `portal.test.ts` / `parses and has no place for unanswered counts`、`keeps unverified out of recent calls and the 30-day window honest`；`packages/db/src/portal/home.db.test.ts` / `matches the admin overview figures`                                                                          | schema 本步；服务计划（PR 4）                                                                                                                        |
| 账号设置                                         | `apps/web/e2e/portal-settings.spec.ts` / `changes the password and keeps the page`、`shows the read-only account facts`                                                                                                                                                                           | 计划（PR 6）                                                                                                                                         |

## PR 拆分

用户给的清单已经合理，调整两处并说明原因。其一，后台流水标签页的适配放进 PR 2，因为 `adminTenantLedger` 响应换形后 Web 不改就过不了类型检查，PR 6 只剩门户流水页和账号设置。其二，CSV 流式响应的公共部分和流水导出都放进 PR 3，让导出机制只在一个 PR 里出现，PR 2 保持为查询改写。

| PR  | 内容                                                                              | 依赖    | 文件边界                                                                                                                                                                                                                                                                                                   | 验收与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | 本 PR：设计文档、共享契约、纯函数、补测                                           | 无      | `docs/phase-6-design.md`、`packages/shared`、`packages/rating/src/csv.ts`、`docs/perf`                                                                                                                                                                                                                     | `pnpm check`；契约测试；补测结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 1   | RLS InitPlan 改写                                                                 | 0       | `packages/db/migrations/0015_rls_initplan.sql` 与 journal、`packages/db/src/*.db.test.ts`，不改 apps                                                                                                                                                                                                       | [验收记录](evidence/phase-6-pr1/README.md)；完整 `pnpm check`、`pnpm test:db`、`pnpm test:idor`；等待独立 Codex 审查                                                                                                                                                                                                                                                                                                                                                                                          |
| 2   | 流水后端：合并查询、`portalLedger`、后台流水切换                                  | 1       | `packages/db/src/ledger-merge.ts`、`portal/ledger.ts`、`admin/balance.ts`；`apps/api` 门户与后台流水路由、`liveApiContract` 并入 `portalLedgerApiContract`；`packages/shared` 旧后台流水 schema 删除与改名；`apps/web` 后台流水标签页适配；IDOR 一例                                                       | DB 测试（合并、锚点、赊账、过滤）；原始 JSON 防泄漏；后台一页由 54 s 降到小于 0.5 s 的实测；两种锚点在历史中段月份的耗时；**用同一个 `packages/db/scripts/portal-perf.ts` 在 `fs_billing_perf` 上重测带有序 `array_agg` 排序键的新合并查询（含计划），结果记入 `docs/perf/portal-cdrs.md`，与修正前的数字并列**；日期边界 DB 测试（`from='0001-01-01'` 被接受且区间正确，UTC 2026-09-28T16:30Z 归入 2026-09-29）                                                                                              |
| 3   | 话单后端：列表、汇总、国家、门户与后台导出、流水导出、`cdr_export` 审计           | 1、2    | `packages/db/src/portal/cdrs.ts`、`packages/db/src/admin/cdrs.ts`、`cdr-query.ts`、`cancel-postgres.ts`；`apps/api/src/export/stream-csv.ts`、门户与后台话单路由、导出池与配置；新增 4 个 IDOR 用例；`liveApiContract` 注册 `portalCdrApiContract`、`adminCdrApiContract`、`portalLedgerExportApiContract` | DB 测试；原始 JSON 无 `unverified`；导出生命周期、JSON 前置错误、响应开始后的中断与资源清理；日期边界；10 万条 HTTP 导出 14 个测量请求均在 30 s 内，默认总时限在约 300 s 中断，超时后 20 万条重试完整；每租户/全局并发拒绝；费率表五列改造 PR A 随后修改本行列出的查询与导出列，见 [rate-list-design.md](rate-list-design.md)。300 万条 profile 的门户/后台 HTTP 分页 128 个样本均小于 500 ms；挂断原因对照 FreeSWITCH 1.11.3。原始记录和仍待 RSS/财务校验的项目见[PR 3 验收记录](evidence/phase-6/README.md) |
| 4   | 首页后端与 Web：`portalHome`、health SQL 抽出、首页页面、状态横幅、图表、最近话单 | 3       | `packages/db/src/portal/home.ts`、`tenant-health.ts`；`apps/api` 首页路由、IDOR 一例；`apps/web` 门户首页与 `components/tenant-health.tsx`                                                                                                                                                                 | DB 与 API 测试；Playwright 首页冒烟；1a 至 1d 截图初稿                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 5   | Web 话单页与后台话单标签页：共用话单组件、`callDownload`、日期选择器的范围上限    | 3       | `apps/web/src/components/cdr/*`、`pages/portal/cdrs.tsx`、`pages/admin/tenant-tabs/cdrs-tab.tsx`、`lib/api.ts`、`lib/download.ts`、`components/date-range-field.tsx`                                                                                                                                       | 组件与单元测试；e2e 筛选、详情、导出、登录过期；后台未经验证标签与筛选                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | Web 流水页与账号设置                                                              | 2、3    | `apps/web/src/pages/portal/{ledger,settings}.tsx`、`pages/change-password.tsx` 抽出表单                                                                                                                                                                                                                    | e2e 流水合并行跳转当天话单、类型筛选、导出；账号设置改密                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7   | e2e、视觉对照、计划勾选                                                           | 4、5、6 | `apps/web/e2e/*`、`docs/evidence/phase-6*`、`docs/plan.md`、`README.md`                                                                                                                                                                                                                                    | 全部 e2e；对照图和差异清单；plan 阶段 6 逐项勾选并附证据                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

PR 4、5、6 是后续独立交付：PR 4 实现首页后端与 Web，PR 5 实现门户/后台话单页面，PR 6 实现门户流水页与账号设置。它们只依赖 PR 3 或 PR 2 的接口，可并行开发，不属于 PR 3 后端验收。PR 5 的话单组件被 PR 4 的「最近话单」复用时，先在 PR 4 里放一个最小的行组件，PR 5 再替换，避免 PR 4 等 PR 5。每个 PR 合并前跑 `pnpm check`，涉及数据库的跑 `pnpm test:db`，PR 1 与 PR 3 加 `pnpm test:idor`。

### PR 1 实现与验收进度（2026-10-18）

PR 1 的迁移、数据库测试和性能证据已在独立 worktree 落盘。完整检查通过，独立 Luna 审查为 PASS+NOTES，最终源码没有阻塞项。CI 与合并状态以 [PR #40](https://github.com/SpaceEggs/fs-billing/pull/40) 为准。Worker 两轮差异、50 ms p95 验收口径、首轮原始证据缺口和独立审查记录见[验收记录](evidence/phase-6-pr1/README.md)。Phase 6 仍在进行中，本记录不勾选整阶段验收。

### PR 2 实现与验收进度（2026-10-18）

PR 2 已实现共享 `mergedLedgerSql`、`listPortalLedger` 与后台流水切换，后台列表契约的 `Merged` 前缀已去掉。`adminLedgerEntrySchema` 仅保留人工余额操作的单条响应。`portalLedgerApiContract` 此时只包含列表；`portalLedgerExportApiContract` 单独留给 PR 3，没有注册导出路由。

最终 SQL 按 `(北京日, 人工 id 或 NULL)` 分组，`max(kind)` 保留每组类型；人工 id 唯一，NULL id 组中全为通话扣费。排序键仍用有序 `array_agg` 取得最后一笔扣费 id。按日优先排序减少文本比较，没有改金额、余额或分页语义。后台 Web 使用判别联合显示合并行，作废应收选择调账的旧调用方也按一个月窗口扫描历史。

[PR 2 验收记录](evidence/phase-6-pr2/README.md)保留 DB、原始 HTTP 防泄漏、IDOR、浏览器与完整检查的执行记录。[性能重测](perf/portal-cdrs.md#pr-2-实际合并查询与-http-实测)包含最初两个超 500 ms 的样本和优化后所有样本，最终 14 次后台 HTTP 全部小于 500 ms。CSV、门户流水页面和阶段 6 总体验收仍属于后续 PR。

### PR 3 实现与验收进度（2026-10-19）

PR 3 已接入门户话单列表、国家选项、话单 CSV、合并流水 CSV，以及后台话单列表、国家选项和 CSV。门户 CDR 查询和导出使用独立字段清单，类型不含 `unverified` 或 `unverifiedOnly`。后台 CDR 使用单独查询和导出行类型。门户流水导出把赊账备注替换为 `账户充值`，按页面的降序排列合并行。

PR 3 的后端列表、导出及审计已实现。导出使用独立的四连接池，单租户并发上限为 1，全进程上限为 4。后台受理计数和 `cdr_export` 审计也在该导出池中以短事务提交，释放连接后才 checkout 游标连接，不占用业务池。实现先在响应头发出前读取首批 5000 行。CSV 与后台受理共用 `withBoundedExportClient`，取消控制连接独立建立，不从已满的导出池申请连接。取消请求成功仍须等待原查询回执；原查询在中止后最多等待 2 秒，控制请求与清理最多等待 8 秒，回滚最多等待 2 秒。超时或连接损坏时销毁并淘汰原连接，只有确认事务结束且取消已完成后才允许复用。BEGIN 已成功但中止导致 Drizzle 未进入事务回调时，连接所有者仍会回滚。已开始的 CSV 响应在总时限到点立即销毁，导出名额在清理完成后释放。业务池与认证连接另计，原文按后台 prepare 借用业务池得出的 12 连接估算不再适用。

新增的 4 个客户 IDOR 用例覆盖 `portalCdrs`、`portalCdrCountries`、`portalCdrsExport` 和 `portalLedgerExport`。新增数据库测试覆盖北京时间日期边界、列表筛选与汇总、后台审计，以及真实 PostgreSQL 查询等待锁时的取消和资源回收。真实 HTTP 测试还验证了首批之前的 JSON 错误、开始传输后的连接中断、同租户重试，以及 CSV 响应的 `x-request-id` 与 `export.csv.completed` 日志关联。

此前功能 checkpoint 的 `pnpm check`、`pnpm test:db`、`pnpm test:idor` 均通过；本次修复的最终源码已通过 `pnpm check`（根目录 706 通过、1 跳过，Web 390 通过）、`pnpm test:db`（456 通过）和 `pnpm test:idor`（27 通过）；下方性能与内存记录按逐文件哈希标识同一份实现。FreeSWITCH 1.11.3 的挂断原因核对见[审计记录](evidence/phase-6/freeswitch-hangup-cause-audit.md)，项目 46 个名称均与官方枚举和映射表一致。

首次 HTTP 预检发现旧性能库中的部分合成 PostgreSQL UUID 不满足当前 `z.uuid()` 契约。用户决定保留契约，因此最终测量使用隔离的 `fs_billing_perf_pr3_uuid_v4` 数据库。旧库曾经历可回滚的原地 repair 尝试，事务已 rollback，之后复核逻辑内容未变；隔离数据集的 setup 没有对旧库留下永久写入。新旧 CDR 的业务字段相同，但 `call_uuid` 与 `received_at` 不同；新库的流水 `actor` 为 `li`、旧库为 `wang`，因为新 seed 从管理员表按 id 排序选取首个账号，不能认为 actor 相同。隔离库按固定 `asOf=2026-10-17T04:00Z` 生成 7 个租户、共 344 万条记录，其中 `PORTALBIG` 有 300 万条；来源记录见[隔离数据集 provenance](evidence/phase-6/isolated-db-provenance.json)。整请求列表 HTTP 测量已完成，导出时间、期限和并发行为已完成首轮验收；SQL prototype 作为独立的诊断类别报告，不替代真实 HTTP 结果。导出 RSS 与 financial-only 结果已写入[PR 3 验收记录](evidence/phase-6/README.md)。峰值 RSS 不按行数成比例上升。请求期间的 RSS 增量仍接近按行数上升。阶段 6 总体验收仍不勾选，Web PR 4、5、6 也未包含在 PR 3。

## 风险

- **阶段 6 的流水锚点在 RLS 改写之前会超预算。** PORTALBIG 历史中段月份整条查询约 0.8 至 1.1 s，改写后约 0.3 s（这两个数都是修正排序键之前的聚合的实测，PR 2 重测新查询）。更大的租户线性外推会再翻倍，没有实测。阶段 7 的月账单锚点把它降到 0.12 至 0.16 s。这是 PR 1 排在 PR 2 前面的原因。
- **振铃超过 31 天的话单不会出现在列表和导出里。** 它仍会计费，余额流水里有对应扣费。入库没有限制振铃时长，仓库里也没有记录 FreeSWITCH 的振铃超时配置。实际振铃通常是秒到分钟级，风险很低，但没有数据库层面的保证。
- **合并行的余额是显示顺序里的累计。** 同一天既有扣费又有人工流水时，人工流水那一行的余额不是它发生那一刻的瞬时余额。晚到的扣费会改变过去日期的行和之后所有行的余额。「共 N 通」统计有扣费流水的通话，与话单页按接通计数可能不同：接通但计费分钟为 0 的话单没有流水，尚未入账的扣费也还没有流水。
- **OFFSET 分页在翻页期间有新话单入库时，相邻页可能重复或漏一行。** 排序键稳定，下一次刷新会纠正。keyset 是储备方案。
- **列表语句不在同一个快照里。** 同一事务里的列表、汇总和未接通计数在 READ COMMITTED 下各取快照，总数与当页之间可能差在两条语句之间入库的话单。
- **导出占用连接和快照。** 10 万行真实 HTTP 导出符合 30 秒门槛，默认总时限约 300 秒终止，重试与准入拒绝均有实测；导出 RSS 已补采，见验收记录。峰值不按行数成比例上升，请求期间增量仍接近按行数上升。部署在 Caddy 后面时，反向代理对无 `Content-Length` 的响应是否立即转发、是否缓冲，需要在阶段 10 用 10 万条验证内存仍平稳。
- **hijack 绕过 Fastify 的响应钩子。** CSV 路径显式传递 `x-request-id` 并手工写结束日志；代理日志关联验证已完成。其他需要经过 Fastify response hook 的行为仍需按路由边界单独验证。
- **浏览器内存。** `blob()` 在内存里持有整个 CSV，最大月份约 26 MB（估算）。若出现问题，退路是预签名一次性下载地址加原生下载，但错误提示会变差。
- **RLS 改写碰到所有租户表的读路径。** 语义等价已经推导，但计划形状可能变化，Worker 授权路径也受影响。靠完整 DB 测试、IDOR 测试、授权 p95 重测和 Codex 审查控制。
- **挂断原因表依据 FreeSWITCH 公开的枚举，仓库里没有源码。** PR 3 已按 1.11.3 对照审计；46 个项目名称均命中官方枚举/映射，官方多出的原因保留未知原因回退。
- **公式中和会让极少数以 `=`、`@` 开头的备注或国家名在 Excel 里多一个单引号。** 这是有意的取舍。
- **补测与原型都是单连接、合成数据、不含 HTTP。** 并发、序列化、压缩和慢客户端都没覆盖，HTTP 端到端数据在 PR 2 与 PR 3 补。
- **Excel 打开带 BOM 的 UTF-8 CSV 的显示需要人工在 Windows 上看一次。** 没有自动化手段。

## 待用户确认

无。

## 本步验证

2026-10-18 在 Node 22.23.2 上运行 `pnpm check`，退出码 0。lint 无警告，`format:check` 与全仓 typecheck 通过，根目录 612 项测试通过（另 1 项跳过），Web 380 项通过，Web production build 成功。

本步的测试改动如下。

- `packages/shared` 从 5 个文件 124 项变为 10 个文件 203 项。新增 `portal/portal.test.ts`、`admin/cdrs.test.ts`、`day-range.test.ts`、`hangup-cause.test.ts`、`export.test.ts`。
- `packages/rating/src/csv.test.ts` 从 28 项变为 48 项，新增 CSV 单元格转义与记录格式。
- `admin/admin.test.ts` 删除阶段 5 的门户投影测试和旧的门户 schema 引用检查，两者分别由 `portal.test.ts` 的新用例取代。赊账备注仅内部可见的断言保留为 `credit recharge notes are visible to admins only`。

补测在本机 `fs_billing_perf` 上用 `docs/perf/portal-cdrs/probes/design-step1.sql` 运行，每段在事务内以 `fs_billing_app` 身份读取并 rollback，没有改库，也没有碰开发库 `fs_billing`。每项 3 遍，首遍常偏慢，数字是各遍的原值。耗时随读取行数线性增长，主要耗时在 RLS 谓词的逐行求值，原因见[性能原型](perf/portal-cdrs.md#rls-谓词是读路径的主要耗时)。

本步没有验证的部分：路由、DB service、迁移、Web 页面、HTTP 端到端、慢客户端、并发，以及 Windows Excel 打开 CSV 的显示。这些都在上面的后续 PR 里验证，验收映射中标为「计划」的测试此时都不存在，不能据此勾选整阶段验收。

费率表五列决定 39（用户 2026-10-19 确认）：话单分开保存 ISO、国家、说明；国家筛选与按国家汇总只按国家；列表共用 `packages/shared` 的 `formatCountryLabel` 显示「国家 · 说明」，说明为空只显示国家。首页最近话单、话单列表、详情共用此函数。旧话单不回填。实施见 [费率表五列设计](rate-list-design.md)。
