# 阶段 5 step 1 设计与共享契约

## 类型与模块布局

本步交付 Zod wire contract 和实现草案。API routes、DB services、迁移、Web 页面均为后续计划。本步没有注册新端点，也不表示阶段 5 已验收。

调用方示意先于实现。Web 使用 `adminBalanceOperationRequestSchema.parse({kind: 'adjustment', currency: 'CNY', amount: '-10.00', reason: '冲正重复充值', idempotencyKey: 'manual:001'})`。API 接收验证后的 `AdminBalanceOperationRequest`，从 admin session 取得操作人，再读取路径对应租户。客户接口仍只能从客户身份取得租户，不能复用这些后台 DTO。

### 核心数据形状

| 类型 / schema                  | 结构与不变量                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdminTenantSummary`           | 租户身份带唯一币种；余额、可用额度、本月消费、待收款为 decimal strings。`status` 为 active/disabled，`health` 为 suspended/overdraft/low_balance/normal/disabled                                                                                                                 |
| `AdminTenantCreateRequest`     | 编码、名称、币种、settings、initialRates。门户账号单独创建。initialRates 为 blank/entries/csv/copy 联合，copy 必须同时提供 sourceTenantId 和 sourceVersionId。没有客户端 effectiveFrom                                                                                           |
| `AdminTenantEditRequest`       | 名称、联系人、电话、备注均必传，整体替换这些字段。空字符串明确清空联系人、电话或备注。编码和币种创建后不可改                                                                                                                                                                     |
| `AdminTenantSettingsRequest`   | overdraftLimit、lowBalanceThreshold 为非负、最多两位小数且有业务上限的 decimal strings。开户 emails 可省略，由服务填当前管理员邮箱；更新 settings 必须明确提交 emails 数组                                                                                                       |
| `AdminTenantSettingsResponse`  | 保存的 settings 快照。金额保留历史精度且不受人工输入上限约束；overdraftLimit 保持 DB 非负规则，lowBalanceThreshold 可为历史负值。emails 原样返回，不规范化或限制数组长度                                                                                                         |
| `AdminBalanceOperationRequest` | kind 联合。topup/credit_topup/gift 为正数；adjustment 为非零有符号数且 reason trim 后非空。topup/credit_topup/gift 最多两位、adjustment 最多四位，全部有业务上限。每次请求带 idempotencyKey 和 currency，服务必须核验等于租户币种                                                |
| `AdminLedgerEntry`             | 沿用 DB kind，含金额、变动后余额、操作人、时间、收款状态。credit_recharge 的 noteVisibility 必须为 admin，其余为 customer                                                                                                                                                        |
| `AdminRateSchedule`            | immediate 无时间字段；scheduled 带 ISO effectiveFrom。Zod 每次 parse 时调用 Date.now()，要求 now <= effectiveFrom <= now + horizon；默认 365 天，可配置，不限制整分钟                                                                                                            |
| `AdminRateVersion`             | 版本 id、历史 effectiveFrom、完整 entries。历史响应时间没有未来时间 refinement，entries 响应不应用可配置输入行数上限                                                                                                                                                             |
| `AdminRatePreviewResponse`     | ok=false 只有非空 errors 数组；ok=true 才有 previewId、expiresAt、encoding、currency、新增/修改/删除明细及 counts。counts 必须等于对应 changes 数量                                                                                                                              |
| `AdminCsvRowError`             | `{line: positive integer, reason: nonempty string}`，与 rating CsvError 一致，物理行从 1 开始，包含表头。一次返回所有错误行                                                                                                                                                      |
| `AdminCurrencyTotals`          | `{CNY: decimal string, USD: decimal string}`，即以 Currency 为键的完整 record。严格拒绝 total、缺币种和 number。无换算或混加字段                                                                                                                                                 |
| `AdminReceivable`              | ledgerEntryId、latestSettlementId（最新历史确认，含已撤销；从未确认为 null）、tenant、内部备注、金额、操作人、ageDays、overdue；payment 为 pending/received/voided 联合；received 含 settlementId，voided 含作废事件、冲正流水、原因与操作人。pending 且 ageDays > 30 才 overdue |
| `AuditAction` / `AuditPayload` | 以 action 区分的联合，actor、occurredAt、tenantId、target、content 必填，各 action 的 content 有独立必填字段。由服务构造，客户端不能指定 actor 或时间                                                                                                                            |

沿用 [money.ts](../packages/shared/src/api/money.ts) 的 canonical decimal string 格式，不在 wire 层使用 number 或 Decimal 对象。Money DTO 和 rating 的 `Money<C>` 不同。后续 service 在读到租户币种后用现有 `money(currency, amount)`、`rate(currency, rateText)` 创建 branded `Money<C>`、`Rate<C>`，不强转、不自行定义另一套品牌。[rating money.ts](../packages/rating/src/money.ts) 的 `addMoney` 保持跨币种编译期拒绝。显示两位小数不意味着提前舍入。

费率前缀只含数字且不能以 00 开头，rate 非负且最多四位小数，同一整表不能重复前缀。表内复制使用原字符串，不做币种转换。

### 模块归属

| 路径                                                                        | 本步 / 后续 | 责任                                                                                                           |
| --------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/api/admin/common.ts`                                   | 本步        | UUID params、分页、时间、decimal 验证、通用 mutation response                                                  |
| `packages/shared/src/api/admin/tenants.ts`                                  | 本步        | 租户读写、开户、settings、overview                                                                             |
| `packages/shared/src/api/admin/accounts.ts`                                 | 本步        | 管理员与门户账号 DTO，不泄露 auth_user_id                                                                      |
| `packages/shared/src/api/admin/balance.ts`                                  | 本步        | 余额命令联合、管理流水查询                                                                                     |
| `packages/shared/src/api/admin/rates.ts`                                    | 本步        | 版本、单条修改、CSV、预览提交、复制                                                                            |
| `packages/shared/src/api/admin/receivables.ts`                              | 本步        | 收款状态事件及分币种 totals                                                                                    |
| `packages/shared/src/api/admin/audit.ts`                                    | 本步        | AuditAction、payload 与修改字段白名单                                                                          |
| `packages/shared/src/api/admin/errors.ts`                                   | 本步        | 后台错误，复用已有认证/校验错误                                                                                |
| `packages/shared/src/api/admin/contract.ts`、`index.ts`                     | 本步        | 独立 adminApiContract 和公开导出                                                                               |
| `apps/api/src/routes/admin/{tenants,balance,rates,receivables,accounts}.ts` | 计划        | 验证、admin session、调用服务、错误映射。现有 `routes/admin.ts` 的密码重置迁入 accounts 时复用路径，不重复挂载 |
| `packages/db/src/admin/{tenants,balance,rates,receivables,audit}.ts`        | 计划        | 查询与事务边界，复用 `ledger.ts`、`rates.ts`、`client.ts`                                                      |
| `apps/api/src/auth/admin-accounts.ts`                                       | 计划        | Better Auth 1.7.7 账号开通、资料关联、凭据撤销。邮箱唯一来源为 auth.user                                       |
| `apps/web/src/routes/admin/{tenants,tenant-detail,receivables,admins}.tsx`  | 计划        | TanStack Router 页面，详情 tabs、手机卡片、Query 刷新、一次性密码显示                                          |

后续服务签名草案如下，均未实现。

```ts
createTenant({ db, actor, request }: CreateTenantInput): Promise<AdminTenantCreateResponse>
operateBalance({ db, actor, tenantId, request }: BalanceInput): Promise<AdminBalanceOperationResponse>
previewRates({ db, actor, tenantId, request }: PreviewInput): Promise<AdminRatePreviewResponse>
commitRates({ db, actor, tenantId, previewId }: CommitInput): Promise<AdminRateVersionResponse>
confirmPayment({ db, actor, ledgerEntryId, request }: PaymentInput): Promise<AdminConfirmPaymentResponse>
reversePayment({ db, actor, ledgerEntryId, request }: ReversePaymentInput): Promise<AdminReversePaymentResponse>
voidReceivable({ db, actor, ledgerEntryId, request }: VoidReceivableInput): Promise<AdminVoidReceivableResponse>
writeAudit(tx: Tx, event: AuditPayload): Promise<void>
```

每个 service 自己拥有业务策略与事务，不拆出通用 load/validate/save 转发层。路由不直接拼接账本写入。

设计比较采用两个形状。一份全量 admin.ts 可以减少文件数，但把账户生命周期、流水和费率预览的规则放在同一文件。领域模块加单一 facade 让每个规则有归属，且下一步可按领域接入。选择后者。现有路由注册器要求 exhaustive `ApiOperationId` 和错误映射。本步保留 `apiContract` 与 `ApiErrorCode`，新契约不合并进去，避免要求实现 API handlers。此选择应用 Model the Domain 与 Type System Discipline，将余额操作和预览结果编码为联合，将类型从 schema 推导。

## 端点

以下全部要求 **admin session**。复用现有 cookie、身份解析、CSRF/Origin 校验、401/403 和 no-store 约定。修改用 POST 与现有 ApiOperation method 范围一致。params 统一为 `adminTenantParamsSchema` 的 tenantId 或 `adminIdParamsSchema` 的 id。未列 request 的部分使用 `emptyRequestSchema`，无 body 为其 optional 版本。响应统一 200；密码重置两条引用已有 apiContract 定义，保持原有路径与错误映射，不能重复注册。各 operation 的错误映射仅包含其可能返回的 code，不套用全部后台错误。

路径中的 `T` 仅为表格缩写，展开为 `/api/admin/tenants/{tenantId}`。

| method | path                                             | query / body schema                       | response schema                            |
| ------ | ------------------------------------------------ | ----------------------------------------- | ------------------------------------------ |
| GET    | `/api/admin/tenants`                             | adminTenantsQuerySchema                   | adminTenantsResponseSchema                 |
| POST   | `/api/admin/tenants`                             | adminTenantCreateRequestSchema            | adminTenantCreateResponseSchema            |
| GET    | `T`                                              | emptyRequestSchema                        | adminTenantDetailResponseSchema            |
| POST   | `T/edit`                                         | adminTenantEditRequestSchema              | adminMutationResponseSchema                |
| POST   | `T/disable`                                      | emptyRequestSchema                        | adminMutationResponseSchema                |
| POST   | `T/enable`                                       | emptyRequestSchema                        | adminMutationResponseSchema                |
| GET    | `T/overview`                                     | emptyRequestSchema                        | adminTenantOverviewResponseSchema          |
| GET    | `T/ledger`                                       | adminLedgerQuerySchema                    | adminLedgerResponseSchema                  |
| POST   | `T/settings`                                     | adminTenantSettingsRequestSchema          | adminMutationResponseSchema                |
| GET    | `T/portal-accounts`                              | emptyRequestSchema                        | adminPortalAccountsResponseSchema          |
| POST   | `T/portal-accounts`                              | adminPortalAccountCreateRequestSchema     | adminPortalAccountCreateResponseSchema     |
| POST   | `/api/admin/portal-accounts/{id}/reset-password` | resetPasswordParamsSchema，空 body        | resetPasswordResponseSchema                |
| POST   | `/api/admin/portal-accounts/{id}/disable`        | emptyRequestSchema                        | adminMutationResponseSchema                |
| POST   | `/api/admin/portal-accounts/{id}/enable`         | emptyRequestSchema                        | adminMutationResponseSchema                |
| POST   | `T/balance-operations`                           | adminBalanceOperationRequestSchema        | adminBalanceOperationResponseSchema        |
| GET    | `T/rates`                                        | adminRatesQuerySchema                     | adminRatesResponseSchema                   |
| POST   | `T/rates/cancel-future-version`                  | adminRateCancelFutureVersionRequestSchema | adminRateCancelFutureVersionResponseSchema |
| POST   | `T/rates/edit-entry`                             | adminRateEditRequestSchema                | adminRateVersionResponseSchema             |
| POST   | `T/rates/import/preview`                         | adminRateImportPreviewRequestSchema       | adminRatePreviewResponseSchema             |
| POST   | `T/rates/import/commit`                          | adminRateImportCommitRequestSchema        | adminRateVersionResponseSchema             |
| POST   | `T/rates/export`                                 | adminRateExportRequestSchema（body）      | adminRateExportResponseSchema              |
| POST   | `T/rates/copy/preview`                           | adminRateCopyPreviewRequestSchema         | adminRatePreviewResponseSchema             |
| POST   | `T/rates/copy/commit`                            | adminRateImportCommitRequestSchema        | adminRateVersionResponseSchema             |
| GET    | `/api/admin/receivables`                         | adminReceivablesQuerySchema               | adminReceivablesResponseSchema             |
| POST   | `/api/admin/receivables/{id}/confirm-payment`    | adminConfirmPaymentRequestSchema          | adminConfirmPaymentResponseSchema          |
| POST   | `/api/admin/receivables/{id}/reverse-payment`    | adminReversePaymentRequestSchema          | adminReversePaymentResponseSchema          |
| POST   | `/api/admin/receivables/{id}/void`               | adminVoidReceivableRequestSchema          | adminVoidReceivableResponseSchema          |
| GET    | `/api/admin/admins`                              | adminAccountsQuerySchema                  | adminAccountsResponseSchema                |
| POST   | `/api/admin/admins`                              | adminAccountCreateRequestSchema           | adminAccountCreateResponseSchema           |
| POST   | `/api/admin/admins/{id}/reset-password`          | resetPasswordParamsSchema，空 body        | resetPasswordResponseSchema                |
| POST   | `/api/admin/admins/{id}/disable`                 | emptyRequestSchema                        | adminMutationResponseSchema                |
| POST   | `/api/admin/admins/{id}/enable`                  | emptyRequestSchema                        | adminMutationResponseSchema                |

租户详情包含余额卡片与 settings 快照，overview 使用中立模块 `packages/shared/src/api/usage.ts` 的 `tenantUsageOverviewSchema`，后台响应为其别名。字段为 `asOf`、`currency`、`monthSpend`、`monthCallMinutes`、`answeredCalls`、`unansweredCalls`、`daily[30] {date, spend}`、`dailyTotal`。消费与分钟保留非负 decimal strings，通数为非负整数。`daily` 恰好为截至 `asOf` 北京日期当天的连续 30 天，升序补零，今日为部分日；今日消费取最后一项，合计由服务端计算。后台本月总通数为两种通数之和，未来门户首页只显示已接通通数。分钟为账单计费分钟，不是原始通话秒数除以 60。门户首页以后复用中立 schema 与服务，本步不注册门户首页端点。ledger 按 occurredAt DESC、id DESC 稳定分页，支持 kind/from/to；page 默认为 1，pageSize 默认为 25，最大 100。待收款 totals 按筛选后的完整结果集统计，不仅当前页。status=pending 合计未收金额，received 合计已收金额，voided 合计所筛选的已作废原 credit 金额，仅用于历史展示，不计入 pending。币种过滤时另一键为 "0"，只为固定 wire 结构；Web 不显示未选币种的合计，避免误读为该币种没有应收。rates 的 current 为完整当前版本，scheduled 为未来版本，search 仅筛选展示条目，不改变版本基准。

状态计算优先检查手动 disabled；active 下先 balance+overdraftLimit <= 0 为 suspended，其次 balance < 0 为 overdraft，其次 balance < threshold 为 low_balance，其余 normal。列表筛选 search 编码/名称、health 状态和 currency。排序优先 suspended、overdraft、low_balance、normal、disabled；同状态先币种分组，再同币种 balance ASC，最后 code/id。不同币种之间不比较金额。

### 错误契约

错误仍为 `{error: {code, message, requestId, ...}}`。已有 `VALIDATION_ERROR` 400 带 issues，401 的 UNAUTHENTICATED/SESSION_EXPIRED，403 的 FORBIDDEN/ACCOUNT_DISABLED/IDENTITY_UNAVAILABLE，404 NOT_FOUND，429 RATE_LIMITED，500 INTERNAL_ERROR，503 SERVICE_UNAVAILABLE 均复用。

未分类异常（包括服务内部 schema 校验或不变量失败）返回 500 `INTERNAL_ERROR`；503 `SERVICE_UNAVAILABLE` 仅用于最外层重试耗尽的 40001/40P01、数据库连接故障（SQLSTATE 08 类、57P01/57P02/57P03、53300 或网络连接错误）及服务依赖不可用（包括缺失服务依赖）。按 2026-10-15 错误映射决定，存量租户缺少余额提醒设置属于持久的数据不变量失败，详情严格返回 500 `INTERNAL_ERROR`，消息为 `服务内部错误`；列表保留该租户并返回 `settingsConfigured: false`，不补造设置。两者仅返回通用消息和 requestId，不回显内部错误。

`packages/db` 在 pg 边界按以下精确消息或网络错误码将连接故障归一化为 `DatabaseUnavailableError`，保留原异常为 `cause`，API 返回 503。映射以 [`packages/db/src/unavailable.ts`](../packages/db/src/unavailable.ts) 为唯一事实来源。

- 消息：`Connection terminated unexpectedly`、`timeout exceeded when trying to connect`、`Connection terminated due to connection timeout`、`timeout expired`、`Client was closed and is not queryable`、`Client has encountered a connection error and is not queryable`。
- 网络错误码：`ECONNREFUSED`、`ECONNRESET`、`ETIMEDOUT`、`EPIPE`、`ENETUNREACH`、`EHOSTUNREACH`、`EAI_AGAIN`。

任意未分类 `Error` 仍返回 500。只在最外层重试 40001/40P01，不增加重试层。

| code                                                      | HTTP | 条件                                                                                                        |
| --------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| TENANT_CODE_EXISTS / EMAIL_EXISTS / PORTAL_ACCOUNT_EXISTS | 409  | 唯一冲突或第一版门户账号已存在                                                                              |
| CURRENCY_MISMATCH                                         | 409  | 余额请求或复制来源与租户币种不符                                                                            |
| IDEMPOTENCY_CONFLICT                                      | 409  | 同租户同 key 已用于不同命令                                                                                 |
| RATE_VERSION_CONFLICT                                     | 409  | 当前版本已变化、已有未来版本、时间不符合 DB 版本顺序，或与已有 effectiveFrom 重复                           |
| PREVIEW_STALE / PREVIEW_EXPIRED                           | 409  | 内容基准变化、提交时指定生效时间已过去，或预览已过期                                                        |
| ALREADY_RECEIVED                                          | 409  | 已存在未撤销的收款确认事件                                                                                  |
| RECEIVABLE_VOIDED                                         | 409  | 应收已作废，禁止确认、撤销确认及重复作废                                                                    |
| SETTLEMENT_CONFLICT                                       | 409  | pending 确认的 expectedLatestSettlementId 不匹配最新历史确认，或撤销请求的 settlementId 不是当前未撤销确认  |
| RECEIVABLE_REVERSAL_MISMATCH                              | 409  | 冲正流水不属于该租户、不是 adjustment、金额不匹配、未晚于 credit、已有后续反向 adjustment，或已关联其他作废 |
| SELF_DISABLE / LAST_ADMIN                                 | 409  | 自停用或会导致无启用管理员                                                                                  |
| CSV_INVALID                                               | 400  | 开户内 CSV 无效，带 rows 全部行错误。普通 preview 以 200 ok=false 返回同形错误                              |
| CSV_ENCODING_UNSUPPORTED                                  | 400  | 不能解码为 UTF-8 或 GBK                                                                                     |
| CSV_LIMIT_EXCEEDED                                        | 413  | 文件或行数超限                                                                                              |

## 流程与事务约束

### 开户与身份

新租户默认 active、余额 0；overdraftLimit 未传按 CNY 100、USD 15。默认值由共享常量 `DEFAULT_TENANT_OVERDRAFT_LIMIT` 定义；启动配置必须让 `ADMIN_AMOUNT_MAX_INTEGER_DIGITS` 容纳最大默认值的整数位数，当前至少 3 位，否则启动失败。lowBalanceThreshold 由请求明确给出。[design.md §8.1](design.md#81-余额提醒按租户设置)规定通知邮箱默认只填管理人员邮箱。开户省略 emails 时服务从已认证管理员资料取得邮箱并写入设置，不能由 Zod 静态默认值猜测；显式 [] 表示无收件人。settings 更新必须提交 emails，省略不会清空。数据库已有 tenants、tenant_balances、balance_alert_settings、rate_versions、rate_entries。费率表逻辑上属于租户，现 schema 没有单独的 rate_tables 实体。

开户在事务内创建首个完整版本，**不传 effectiveFrom**，让 DB now() 填写，保证 effectiveFrom <= 授权查询时的 now。blank 也创建空版本，空表授权拒绝是预期；填充 entries、CSV 或同币种 copy 后立刻授权能匹配。entries 模式给非 CSV 调用者使用；Web 的 CSV 方式提交原始文件，服务端必须独立解码、调用 parseRateCsv，不能信任浏览器解析结果。CSV 错误或币种不符时租户事务整体失败。copy 由服务在事务中读取 sourceVersionId，核验其 tenant_id 等于 sourceTenantId，并核验来源与新租户币种一致；copy 联合要求两个 ID 成对存在。服务读取数据库来源元数据后再调用 adminTenantCopyConsistencySchema，refine 核验版本 ID、租户归属和币种；请求中的 UUID 本身不能证明归属。本步已实现该 refinement 与拒绝错配的测试，后续服务必须接入。

租户创建响应只返回租户，不包含门户账号。Web 在租户事务成功后调用独立门户账号创建端点，第一版最多一个。门户创建失败保留已创建租户并显示可重试的未开户状态；租户行与门户 auth 用户不是同一次 HTTP 调用。账号初始密码可指定或由系统生成，创建响应以 passwordSource 区分 generated 和 supplied，temporaryPassword 仅在 generated 分支必填，supplied 分支禁止该字段。生成密码仅创建响应返回。账号不存在时返回空 items。重置在同一业务事务内更换凭据、撤销全部目标会话并写审计，响应只含 temporaryPassword，不再次查询密码。管理员经安全渠道交付临时密码。停止门户账号与停止租户是不同操作，前者不影响呼叫。

Better Auth 1.7.7 已由 [apps/api/package.json](../apps/api/package.json) 锁定；认证表在 auth schema，admins/portal_accounts 引用 auth_user_id，邮箱不在业务资料表。认证与业务共用一个数据库、使用不同角色。`fs_billing_auth` 拥有 SECURITY DEFINER 函数 `auth.insert_user`、`auth.insert_credential`、`auth.set_credential`、`auth.revoke_user_sessions`、`auth.clear_login_failures`，只授予 `fs_billing_app` 执行。门户与管理员创建在同一业务事务内先检查租户、门户是否已存在和操作者仍启用，再 `auth.insert_user`、写 profile、`auth.insert_credential` 并写审计。事务失败整体回滚，不留下永久 auth.user，也没有单独的 activate 步骤或 outbox。密码重置同样在该事务内 `auth.set_credential`、按 JavaScript 邮箱键清除登录失败、撤销全部会话并写审计。临时密码的唯一标记是 `auth.account.temporary_password_issued_at`。除 session、logout、change-password 外，该标记存在时业务请求返回 403 `PASSWORD_CHANGE_REQUIRED`。成功改密清除该列、撤销该账号全部会话并签发新会话；登录、session 和改密响应都带 `passwordChangeRequired`。临时密码默认 72 小时，只在登录时检查。无 profile 的 auth 用户不能通过身份解析进入业务 API。不开放注册。

### 租户停用与人工紧急切断 runbook

停用确认消息使用“停用后正常授权路径拒绝新呼叫；Worker 授权超时时，新呼叫仍可能按最多 1800 秒放行；已接通电话按原上限结束并正常计费”。消息不能承诺呼叫停止。

欺诈紧急处置由运维手动执行。先停用租户，再使用 `fs_cli -x "show channels as json"` 获取活动 UUID。对候选 UUID 执行 `fs_cli -x "uuid_getvar <uuid> billing_tenant"`，将 `billing_tenant` 的值与已核验租户编码作不区分大小写匹配并复核，避免切断其他租户。授权和 CDR ingest 均在边界将编码转大写；迁移前核对存量 FreeSWITCH billing_tenant 与数据库编码，不能只修改创建输入。对确认属于该租户的 UUID 执行 `fs_cli -x "uuid_kill <uuid>"`，重新查询直到目标通话清空。多 FreeSWITCH 节点须逐节点执行；保留运维记录并检查最终 CDR 正常入账。此人工流程不新增后台呼叫控制 API。

### 余额与并发

命令映射 topup -> recharge，credit_topup -> credit_recharge，gift -> gift，adjustment -> adjustment。币种来自租户，提交 currency 仅作一致性核验，赠送没有独立币种。credit_topup 追加流水就形成全额 pending receivable，内部备注仅在 admin 契约存在。客户接口必须构造独立 portal projection，将其显示为普通 recharge / “账户充值”，不输出 internalNote、收款状态或操作人内部字段。noteVisibility 只是后台展示约束，不能作为客户数据过滤器。门户 operation 不得引用 admin ledger 或 receivable schema；本步契约测试检查现有门户 operation 不使用 admin schema，独立 portalLedgerEntrySchema 与 projectPortalLedgerEntry 已实现并测试，credit_recharge 投影为 recharge 且 note 为空，移除 paymentStatus、actor、noteVisibility。防泄漏 integration 测试及路由接入留待门户流水实现。

adjustment 将 reason 存入 ledger.note。冲正以相反金额追加一条 adjustment，不 UPDATE/DELETE 原流水。Zod 拒绝空原因、零金额及非十进制输入；topup/credit_topup/gift 最多两位，adjustment 最多四位，全部应用独立业务上限。DB 保留原有不可变和 kind shape 约束。

所有影响余额的写入只使用 **现有 lock_tenants 每租户事务级 advisory lock**，复用 `lockTenants` 与 `appendLedgerEntry`。不增加 advisory key、进程 mutex 或另一套分布式锁。透支额度、租户状态和费率写入也在对应租户锁保护的事务内执行；锁在任何行写入之前取得。开户先生成 UUID，再取得租户锁后写入。copy commit 的变更锁与审计 tenantId 都指向目标租户。若开户 copy 还需稳定读取来源，使用同一 lock_tenants 按 ID 顺序一次拿齐来源和目标锁，不能另建锁。锁顺序保持 [client.ts](../packages/db/src/client.ts) 与迁移的现有约束。

重试只在最外层事务调用处处理可重试 DB 错误，内部服务和 appendLedgerEntry 不自行 retry。人工余额操作每个确认动作创建一个 key，重试复用。Zod 拒绝以 call: 开头的 key，保留 Worker 的计费命名空间。同租户同 key 仅允许原管理员重放，以同事务写入且不可变的 ledger_entries.created_by 核验操作人 ID（不比较姓名），无需迁移或回填。先核验操作人，再比较载荷；其他管理员复用 key，无论载荷是否相同，均返回 IDEMPOTENCY_CONFLICT（409，消息「幂等键已由其他管理员使用」），不返回原操作人或载荷，不新增流水或审计。同一管理员同 kind/amount/currency/note/reason 返回原 ledger 与 auditId，不重复审计；载荷不同返回 IDEMPOTENCY_CONFLICT。应收确认、撤销与作废使用状态和版本校验，不接受幂等键或重放已存结果。现有 appendLedgerEntry 只核验 kind 与金额，后续余额 service 必须在持锁情况下补齐备注比较，不能把现有检查当作完整请求幂等性。流水、余额缓存触发器和审计在同事务提交。

开户、门户账号创建、管理员创建未设计可重放的凭据响应，客户端不能自动 retry。若响应丢失，先查询唯一编码或邮箱确认是否已成功；已成功但生成密码丢失时走现有 reset-password 恢复，重复创建返回对应唯一冲突。confirm-payment 必填 expectedLatestSettlementId（UUID 或 null），取自最近一次查询的 latestSettlementId，重试保持原值。已有未撤销确认时返回 ALREADY_RECEIVED；若确认已被撤销而原 token 已过时，返回 SETTLEMENT_CONFLICT，不重新收款。客户端查询当前状态，只有管理员重新确认意图后才用新 token 提交；不承诺重放首次响应。rate commit 成功后再次提交同一 preview 返回 PREVIEW_STALE，客户端查询目标版本确认结果；不承诺重放首个响应或额外审计。

ledger 的 balanceAfter 定义为该租户按 occurredAt ASC、id ASC 排序后，从初始 0 到当前条目 inclusive 的 amount 累加。DB 没有 balance_after 列，服务查询计算且分页前覆盖全部先前流水。此值是确定的历史顺序累计，不保证等于管理员提交当刻看到的缓存余额，特别是同一时间戳多笔流水的 UUID 顺序。

管理员同权、禁止自停用、至少一个 active 已确定。管理员状态变更使用 SERIALIZABLE 事务中的原子条件 UPDATE，停用只在 active 管理员数大于 1 且执行者仍 active 时写入。不使用显式行锁，不新增 advisory locks 或锁表；仅在最外层重试序列化失败，避免并发快照计数导致两个管理员互相停用后清零。停用撤销目标会话。管理员启用、门户账号停用/启用已纳入阶段 5 契约。启用只恢复目标账号状态，不恢复旧会话；门户停用撤销目标全部会话且不影响呼叫，门户启用不自动启用 disabled 租户。资料状态、凭据与审计经 SECURITY DEFINER 函数在同一业务事务提交；失败整笔回滚，不提前放行账号。

管理员 status 使用 SERIALIZABLE（SSI、非阻塞谓词跟踪，冲突仅在最外层重试）符合不新增锁规则（用户批准于 2026-10-15）；所有 admins.status 修改必须经最外层 SERIALIZABLE wrapper，已有事务内请求隔离级别直接抛错。

最外层 SERIALIZABLE 事务最多执行 8 次（含首次），默认 READ COMMITTED 仍最多执行 3 次。两者遇到 40001/40P01 均先回滚，再以 full jitter 退避后重跑整个事务；第 n 次失败后的等待时间均匀分布于 `[0, min(10 × 2^(n−1), 200))` 毫秒，不在最后一次失败后等待。保存点不重试，耗尽后保留原错误，由 API 映射为 503 `SERVICE_UNAVAILABLE`。

### 费率与 CSV

取消排期请求携带 versionId，防止旧页面取消另一版本。在目标现有 lock_tenants 下读版本、核验 tenant_id 与请求 versionId、核验 `effective_from > DB now() + margin`（默认 60 秒，等于边界也拒绝）；不符返回 RATE_VERSION_CONFLICT，找不到目标返回 NOT_FOUND。将 cancelledVersionId 与完整 entries 写入 rate_schedule_cancel 审计后，在同一业务事务删除未来版本。DB 既有 guard 使用 clock_timestamp() 再次检查实际时间，禁止事务执行期间已生效版本的删除；handler 通过 trigger 错误消息“已生效的费率版本不可删除”识别该竞态，或在回滚后重读目标版本与 DB 时间确认已生效，再映射 RATE_VERSION_CONFLICT。不能只按 SQLSTATE `42501`（insufficient_privilege）映射，因为“费率版本不可修改”也使用该 SQLSTATE。竞态导致事务回滚。已生效版本、历史话单、当前表不变，不增加锁。

FreeSWITCH answeredAt 与 DB 时钟可能偏差。已决定后续服务配置取消余量，`DEFAULT_ADMIN_RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS = 60` 秒，要求 effective_from > DB now() + margin，拒绝临近生效的取消并监测两端 NTP 同步，见第 o 项。基础条件始终为 DB 时间而非客户端时间；本步不实现余量或 DB 迁移，服务阶段须验证 guard 与余量边界。

单条编辑提交 baseVersionId、完整 entry、schedule。服务用完整基准版本替换这一条，构造新整表版本，保持历史话单按 answeredAt 选版本的行为。已有未来版本时沿用 DB 的单调顺序与禁止修改当前版本规则，返回 RATE_VERSION_CONFLICT，不默默覆盖已排期条目。

导入 wire 为 filename + contentBase64，保留字节供 API 自动识别 UTF-8/GBK。推荐 UTF-8 fatal 解码，失败尝试 GBK fatal 解码；不能默默替换坏字节。复用 [csv.ts](../packages/rating/src/csv.ts) 处理 Unicode 文本，支持 BOM、CRLF、空行、可选首个非空行英文大小写不敏感表头或中文表头 `前缀,国家,费率`，禁止跨行引号和重复前缀。首个非空行若具有非数字前缀且含中文或字母的表头特征（包括全角逗号表头），但不匹配支持的表头，则在该物理行返回“表头无法识别”，不按数据行报前缀错误。CSV 替换整张表，包含与旧表相同前缀是修改，不是“重复行”。parseRateCsv 成功后，开户与 preview 服务都必须再用 adminRateEntriesSchema 校验完整 entries，包括 country <= 200 的限制。后续 handler 负责把失败映射回物理行号并返回全部错误；本步只有 schema，尚未实现该解析后调用，不能声称 CSV 服务已执行此限制。

preview 不写费率/流水。逐行校验有错误返回全部 line/reason 且不生成 previewId。成功保存或签发服务端可验证的不可篡改预览，绑定 actor、tenant、baseVersionId、文件摘要、完整目标 entries、schedule、expiry。TTL 可配置，已决定默认 60 分钟（`DEFAULT_ADMIN_RATE_PREVIEW_TTL_MS`），见第 n 项。阶段 5 单进程把预览放在进程内 Map；重启或另一进程提交会得到 PREVIEW_STALE。跨进程 HMAC 签名 token 记在 [phase-5-open-questions.md](phase-5-open-questions.md)，本阶段不新增预览表或多节点设施。不让客户端自己提交 changes/counts。commit 持租户锁重读版本、校验 preview 绑定与 expiry，再对保存的 schedule **重新调用同一配置实例的 rateRequests.schedule.parse**，防止预览时合法但提交时已过期的指定时间。成功 preview 的 counts 由 changes 逐类计数，响应 schema 拒绝不一致。提交时 stored schedule 重新 parse 若已过去，映射 PREVIEW_STALE；effectiveFrom 与已有版本重复或违反版本顺序，映射 RATE_VERSION_CONFLICT，不误报只有 previewId 的请求为 VALIDATION_ERROR。任何行错误或 stale 均整表不变。仅用 previewId 的 commit 请求无法自己做时间校验，该步骤是服务端对存储计划的 Zod 验证。

copy preview 和 commit 的路径 tenantId 始终是来源租户，preview body 的 targetTenantId 是目标。服务必须验证 sourceVersionId 属于路径来源租户，再核验来源、目标存在且不同、币种一致。预览绑定 actor、sourceTenantId、sourceVersionId、targetTenantId、目标 baseVersionId、entries、schedule 和 expiry，显示目标整表的新增/修改/删除。commit 从已验证预览恢复目标 tenantId，核验路径仍匹配来源；对目标取得现有 lock_tenants 锁并重读目标版本，写目标整表和审计，AuditPayload.tenantId 为目标租户，target 指向新建的目标费率版本，content.sourceTenantId 保存来源。commit 与导入使用同一校验和整表版本创建逻辑，preview 绑定用途，不能把 import token 当 copy token。导出按指定版本调用 formatRateCsv，返回 UTF-8 CSV 字符串、filename 和 contentType；Web 下载为文件，四位费率，表头 prefix,country,rate。导出使用 POST 和 CSRF/Origin 校验，成功响应必须含 auditId；纯 GET 不能承担写审计的导出操作。

### 收款与审计

confirm-payment 对 credit_recharge 追加 receivable_settlements，写 receivedOn、note、confirmedBy，received 响应保留 settlement note。日期只接受有效 YYYY-MM-DD 且不晚于当前北京时间日期；服务在事务中还必须核验 receivedOn 不早于该 credit 的北京时间日期，此跨记录规则不能仅由请求 schema 证明；received 响应 schema 也拒绝早于创建日的日期。后续迁移删除 settlement 的 ledger_entry_id 唯一约束；服务在现有 lock_tenants 下先检查作废状态，作废返回 RECEIVABLE_VOIDED。存在未撤销确认则 ALREADY_RECEIVED；否则核验必填 expectedLatestSettlementId 与该 credit 的最新历史 settlement ID 相同（包含已撤销事件，从未确认才为 null），不匹配返回 SETTLEMENT_CONFLICT。latestSettlementId 在 pending/received/voided 响应中都保留，不能因撤销清空。最新确认按 created_at、id 排序，received 的 latestSettlementId 必须等于 payment.settlementId。撤销后管理员重新读取最新 token，可重新全额确认并追加新的 settlement。部分到账保持 pending，管理员等全额到账后一次确认。余额和原 ledger 不变，不再写一笔充值。ageDays 暂按北京时间自然日差计算，30 天不高亮、31 天才高亮。CNY 与 USD 分别求和，币种筛选仍返回两键，未选币种为 0。

后续收款迁移新增 append-only `receivable_settlement_reversals`，每 settlement 唯一，保存 settlementId、reason、actor 与时间。新增独立 `receivable_voids`，每原 credit 唯一，且 `UNIQUE(adjustment_ledger_entry_id)`，关联原 credit 与相反金额 adjustment，保存 reason、actor 与时间。新表沿用 tenant 外键一致性、RLS、角色 grants 与不可变 guard，不 UPDATE/DELETE 旧事件。`receivables` view 保持每 credit 一行，作废优先，否则取按确认时间和 ID 排序最新的未撤销 settlement，保留 receivedOn、note、confirmedBy 与 settlementId，没有则 pending。view 另取最新历史 settlement（含已撤销）作为 latestSettlementId，从未确认才为 null。pending 合计排除 received 和 voided，30/31 天规则不变。

reverse-payment 的路径 id 是原 credit ledgerEntryId，body 必须携带当前 settlementId 与非空 reason，防止旧页面撤销重新确认后的新事件。void 的 body 为 adjustmentLedgerEntryId 与 reason；服务核验同租户的 adjustment 金额恰为原 credit 相反数，且 adjustment.created_at > credit.created_at；时间相同也拒绝，不能用随机 UUID 推断先后。不能复用其他作废的冲正。现有 adjustment 没有被冲正流水的引用，因此采用保守匹配规则：如果同租户存在 created_at >= 候选 adjustment.created_at 的另一条 adjustment，金额恰为候选的相反数，则拒绝该候选并返回 RECEIVABLE_REVERSAL_MISMATCH。这也可能拒绝无关但等额的后续调账，不能仅凭金额认定实际关联。作废后新增 adjustment 不自动撤销作废事件或恢复 pending。已收款须先撤销确认才可作废，adjustment 本身不自动关闭应收。作废后不可再确认。confirm/reverse/void 全部在同一个既有 lock_tenants 事务内检查状态、追加事件和审计，不新增锁。收款事件不改余额或原账本，只有先前追加的 adjustment 改余额。confirm/reverse/void 先检查作废，RECEIVABLE_VOIDED 优先于 ALREADY_RECEIVED、SETTLEMENT_CONFLICT 和 RECEIVABLE_REVERSAL_MISMATCH。未作废的 reverse 再核验 settlementId 是否属于当前未撤销确认，不匹配或已撤销返回 SETTLEMENT_CONFLICT。重复或过时请求返回上述 409，客户端重查状态，不重复审计。

审计新增 `receivable_void` 的 content 必含 ledgerEntryId、voidId、adjustmentLedgerEntryId、reason、amount、currency；`receivable_payment_reverse` 必含 ledgerEntryId、settlementId、reversalId、reason、amount、currency。actor 与 occurredAt 仍由服务生成。

`AuditAction` 包含 tenant_create/edit/disable/enable/settings_update、portal_account_create/disable/enable、reset_password、balance_topup/credit_topup/gift/adjustment、rate_entry_edit/import/export/copy、rate_schedule_cancel、receivable_confirm/void/payment_reverse、admin_create/disable/enable。reset_password 沿用已有 action 名，target kind 区分 admin/portal_account。

AuditPayload 映射 operation_logs 的 adminId、createdAt、tenantId、action、target、details，并以 action 为 discriminator。content 不再用一组可选字段覆盖全部操作。balance_topup、balance_credit_topup、balance_gift 必须含 ledgerEntryId、amount、currency；balance_adjustment 还必须含 reason。receivable_confirm 必须含 ledgerEntryId、settlementId、amount、currency、receivedOn。费率修改与导入必含 rateVersionId，copy 还必含 sourceTenantId 和 sourceVersionId；export 必含导出版本 ID。rate_schedule_cancel 必含 cancelledVersionId 与完整 entries 快照，因为取消后不能再从关联版本复原整表；使用 `adminRateEntriesResponseSchema`，不应用输入行数上限。租户、设置和账号操作使用各自的 content 字段。changes.field 白名单包括 amount、receivedOn、code 和 currency，支持修改前后值。费率批量日志记录关联版本 ID，取消例外保留完整 entries；changes 字段不承诺已包含完整整表差异。后台查询从关联历史版本复原完整差异为后续计划，本步 schema 不能证明重建已实现。actor/time 由 session/DB 生成。严禁把原请求整体写入 details，密码、cookie、token、CSV 原始文件不得落日志。每个成功人工修改、导入、复制、收款、账号操作及显式导出都有一条日志；纯查询、预览和校验失败不算修改。失败的安全日志不伪装为成功的操作日志。操作日志页本阶段不实现。

## 验收标准对应计划测试

以下逐条映射 [plan.md 阶段 5](plan.md#阶段-5管理后台开户与资金) 的验收。标为“计划”的文件未在本步创建，不能据此勾选整阶段验收。

| 验收标准                                                          | 具体测试文件 / name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 类型与本步状态                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 完整 ABC001 CNY 开户、CSV、赊账 500、门户账号，列表余额状态正确   | `apps/web/e2e/admin-onboarding.spec.ts` / `creates ABC001, imports rates, credits 500 and opens portal account`                                                                                                                                                                                                                                                                                                                                                                                                                                               | Playwright，计划                                                          |
| 错误 CSV 显示所有行号、表不变                                     | `packages/shared/src/api/admin/admin.test.ts` / `CSV failure retains every physical line and cannot carry a commit token`；`apps/api/src/admin-rates.db.test.ts` / `invalid CSV commits no rows or versions`；`apps/web/e2e/admin-rates.spec.ts` / `shows every CSV error line`                                                                                                                                                                                                                                                                               | vitest contract 已实现；api integration 与 Playwright 计划                |
| 调账无原因不能提交，反向追加且原记录不变                          | `packages/shared/src/api/admin/admin.test.ts` / `adjustment requires a nonblank reason and a nonzero signed amount`；`apps/api/src/admin-balance.db.test.ts` / `reversal appends opposite amount and preserves original`；`apps/web/e2e/admin-balance.spec.ts` / `blocks blank adjustment reason`                                                                                                                                                                                                                                                             | vitest contract 已实现；api integration 与 Playwright 计划                |
| ¥ 和 $ 分别合计，无混加数字                                       | `packages/shared/src/api/admin/admin.test.ts` / `currency totals keep CNY and USD separate and reject a combined total`；`apps/api/src/admin-receivables.db.test.ts` / `totals span all filtered pages by currency`；`apps/web/e2e/admin-receivables.spec.ts` / `renders CNY and USD totals separately`                                                                                                                                                                                                                                                       | vitest contract 已实现；api integration 与 Playwright 计划                |
| 各页面浅色、深色、手机逐页与种子稿比对，差异记录处理              | `apps/web/e2e/admin-visual.spec.ts` / `matches seeded admin pages in light dark and mobile`，矩阵覆盖列表、开户、详情四 tabs、余额对话框、费率与 CSV、待收款、管理员；`docs/evidence/phase-5-web/visual-differences.md`                                                                                                                                                                                                                                                                                                                                       | Playwright 截图与人工差异复核，计划                                       |
| 每个人工操作有操作人、时间、对象、内容日志                        | `packages/shared/src/api/admin/admin.test.ts` / `audit payload requires actor, time, target and content and excludes credentials`；`apps/api/src/admin-audit.db.test.ts` / `each manual action emits exactly one complete event`、`failed mutation rolls back audit`、`balance retry reuses audit`、`credential change audit survives failure recovery`                                                                                                                                                                                                       | vitest contract 已实现；api integration 计划                              |
| 开户首个立即版本 effectiveFrom <= now，立即授权匹配               | `apps/api/src/admin-tenants.db.test.ts` / `first populated rate version uses database now and authorizes immediately`                                                                                                                                                                                                                                                                                                                                                                                                                                         | api integration，计划。使用真实 DB 与 loadRatingTenant/authorize          |
| 指定时间在 [now, now + horizon] 闭区间，API Zod 拒绝过去和超上限  | `packages/shared/src/api/admin/admin.test.ts` / `scheduled effectiveFrom rejects past and accepts equality at request time`；`apps/api/src/admin-rates.db.test.ts` / `rejects past schedule before writes and revalidates at commit`                                                                                                                                                                                                                                                                                                                          | vitest contract 已实现；api integration 计划                              |
| 取消须 effective_from > DB now() + margin（默认 60 秒），完整审计 | `packages/shared/src/api/admin/admin.test.ts` / `cancellation contract requires a version and a complete audit snapshot`；`apps/api/src/admin-rates.db.test.ts` / `cancel future version snapshots entries under tenant lock`、`cancel loses activation race without deleting history`；`apps/web/e2e/admin-rates.spec.ts` / `cancels selected scheduled version`                                                                                                                                                                                             | contract 已实现；真实 DB 时间/锁竞态与 UI 计划                            |
| 管理员启用，门户停用/启用及审计                                   | `packages/shared/src/api/admin/admin.test.ts` / `%s exposes an admin-only POST and audit action`；`apps/api/src/admin-accounts.db.test.ts` / `enable admin audits without restoring sessions`、`portal disable revokes sessions without disabling calls`、`portal enable preserves disabled tenant`                                                                                                                                                                                                                                                           | contract 已实现；api integration 计划                                     |
| 人工金额与设置精度、业务上限                                      | `packages/shared/src/api/admin/admin.test.ts` / `%s accepts two decimals and ten integer digits only`、`adjustments accept four decimals and cap both signs without rounding`、`settings require nonnegative two-decimal capped values`、`saved settings preserve historical precision, amounts and recipients`；`apps/api/src/admin-balance.db.test.ts` / `rejects excess precision and cap before ledger writes`                                                                                                                                            | contract 边界已实现；DB 不写入验证计划                                    |
| CSV 中文表头、文件/行数边界及大表 TTL                             | `packages/rating/src/csv.test.ts` / `Chinese header preserves the rating dialect and physical error lines`、`near-miss header %s reports its physical line`；`packages/shared/src/api/admin/admin.test.ts` / `CSV byte limits reject the extra byte hidden by base64 padding`、`rate row caps are named defaults and configurable`、`raised row limits remain readable and cancellable with a complete audit`；`apps/api/src/admin-rates.db.test.ts` / `enforces decoded size and row configuration`、`configured preview TTL expires without changing rates` | parser/contract 已实现；handler 与 TTL 行为计划                           |
| 编码大写及唯一、收件人规范化与空邮箱警告                          | `packages/shared/src/api/admin/admin.test.ts` / `tenant codes normalize uppercase at creation`、`recipients lowercase and deduplicate before the twenty-address cap`；`apps/api/src/admin-tenants.db.test.ts` / `case insensitive code collisions fail atomically`；`apps/web/e2e/admin-settings.spec.ts` / `warns for empty recipients after load and save`                                                                                                                                                                                                  | transform 已实现；DB 唯一与 UI 计划，警告采用 UI 规则而非新 response 字段 |
| 创建失败不留下 auth 用户，停用写审计                              | `apps/api/src/admin-accounts.db.test.ts` / `failed account creation rolls back the auth user and writes no audit`、`rejects self-disable and records disable audit with session revoke`                                                                                                                                                                                                                                                                                                                                                                       | 已由 admin-accounts 数据库测试覆盖                                        |
| 停用不承诺呼叫停止及人工切断流程                                  | `apps/web/e2e/admin-tenants.spec.ts` / `disable confirmation explains live call behavior`；运维按上述 runbook 核验指定租户 UUID、切断及 CDR 入账                                                                                                                                                                                                                                                                                                                                                                                                              | UI 计划；人工演练计划，本步仅文档                                         |

### 新增决定的验收与测试

本步契约测试位于 `packages/shared/src/api/admin/decisions.test.ts`。后续行为测试均为计划，不以 schema 测试代替运行验证。

| 验收行为                                                             | 测试文件 / name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 状态与步骤                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 任意 ISO、秒/毫秒、now 与 horizon 闭区间、配置重用、历史响应不限未来 | `packages/shared/src/api/admin/decisions.test.ts` / `schedule horizon accepts any ISO instant within inclusive configurable bounds`、`configured horizon %s binds edit import copy and stored schedule reparse`；`apps/api/src/admin-rates.db.test.ts` / `configured horizon applies to edit import copy and commit`；`apps/web/e2e/admin-rates.spec.ts` / `minute picker submits Beijing schedule`                                                                                                                                                                                                                                                                                                                         | contract 本步；service/Web 后续                   |
| 撤销误确认及再确认，不能重复/并发确认，旧 settlement 不能撤销新确认  | `packages/shared/src/api/admin/decisions.test.ts` / `void and reverse payment expose admin POSTs with required reasons and event IDs`、`confirm payment requires a latest-ever settlement token and maps stale requests to conflict`、`pending receivables expose the latest-ever settlement token for reconfirmation`；`apps/api/src/admin-receivables.db.test.ts` / `confirm reverse pending reconfirm preserves immutable events`、`concurrent confirmations keep one non-reversed settlement`、`stale reversal cannot reverse newer settlement`、`repeat reversal returns conflict without extra audit`、`lost confirm response followed by reversal rejects stale retry`、`voided state wins over settlement conflict` | contract 本步；迁移/view/service 后续             |
| 独立作废，只有 pending 逾期，void 不计入 pending totals、余额不变    | `packages/shared/src/api/admin/decisions.test.ts` / `receivable states retain settlement or void details and only pending can be overdue`；`apps/api/src/admin-receivables.db.test.ts` / `void links opposite adjustment and excludes pending totals`、`void rejects received foreign mismatched and reused adjustments`、`void rejects adjustments before credit and later opposite adjustments`、`adjustment cannot link to two voids`、`void and settlement events leave ledger and balance unchanged`                                                                                                                                                                                                                   | contract 本步；迁移/view/service 后续             |
| 作废/撤销审计必有原因与事件 ID                                       | `packages/shared/src/api/admin/decisions.test.ts` / `audit %s requires reason and affected event IDs`；`apps/api/src/admin-audit.db.test.ts` / `receivable events and audits commit or roll back together`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | contract 本步；service 后续                       |
| disabled 仍可 topup/credit/gift，UI 提示不启用                       | `apps/api/src/admin-balance.db.test.ts` / `disabled tenant accepts all topups without enabling`；`apps/web/e2e/admin-balance.spec.ts` / `disabled tenant confirmation explains unchanged status`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | service/Web 后续                                  |
| 大额仅 UI 二次确认，无合同 token                                     | `packages/shared/src/api/admin/decisions.test.ts` / `large gift and credit requests require no confirmation token`；`apps/web/e2e/admin-balance.spec.ts` / `gift and credit require second confirmation only above configured currency threshold`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | contract 本步；Web 后续，覆盖恰等于阈值与配置变更 |
| 紧急改价三步、TTL 默认 60 分钟、余量默认 60 秒与 NTP                 | `apps/api/src/admin-rates.db.test.ts` / `preview expires at configured TTL and rechecks schedule`、`cancel rejects within configured clock skew margin`；`apps/web/e2e/admin-rates.spec.ts` / `cancel edit reschedule audits each step`；运维 NTP 同步检查记录                                                                                                                                                                                                                                                                                                                                                                                                                                                              | service/Web/运维后续，涵盖 TTL/余量恰等于边界     |
| 存量编码核验与唯一约束，授权和 ingest 都转大写                       | `apps/api/src/admin-tenants.db.test.ts` / `case collision preflight blocks index migration`；`apps/worker/src/authorize.db.test.ts` / `lowercase billing tenant authorizes stored uppercase code`；`apps/worker/src/ingest.db.test.ts` / `lowercase billing tenant ingests and bills stored uppercase code`；迁移前 FreeSWITCH billing_tenant 与 stored codes 核对记录                                                                                                                                                                                                                                                                                                                                                      | migration/worker 后续，不能仅测试开户 transform   |
| 首次与每次 reset 强制改密，72h 签发 TTL 登录检查                     | `apps/api/src/admin-accounts.db.test.ts` / `blocks business routes until a temporary password is changed`、`temporary credentials reject after expiry and permanent password changes clear issuance`、`enforces configured temporary credential TTL for admin and portal logins`                                                                                                                                                                                                                                                                                                                                                                                                                                            | 登录检查 TTL；改密后清除标记并放行业务路由        |
| 管理员与门户创建失败回滚 auth 用户，不重复审计                       | `apps/api/src/admin-accounts.db.test.ts` / `failed account creation rolls back the auth user and writes no audit`、`creates admins with a same-transaction audit and initial temporary credential`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 同一业务事务；失败不留下永久 orphan               |
| 受限只读审计查询、停用管理员邮箱保留标记                             | `packages/db/src/audit.db.test.ts` / `filters by case-insensitive tenant code and returns the full row newest first`、`filters by exact action, keeping logs without a tenant`、`time window includes p_from and excludes p_to`、`audit_role_violations reports %s`、`audit_role_violations is empty for the migrated role`、`migration refuses a pre-existing audit role after %s`、`application role cannot execute the audit query`、`application role cannot execute audit_role_violations`；`apps/web/src/components/admin/form-fields.test.tsx` / `flags disabled-admin emails regardless of case and keeps the saved spelling`                                                                                       | 已完成，页面仍阶段 8                              |
| 未来 6/6、1/1 精度决定推迟                                           | 启用周期时新增金额累加与调账补偿测试，本步无存储变更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 后续计费周期设计                                  |

补充计划 integration 覆盖并发 topup 与 Worker 扣费、key 冲突、低余额与停机边界、跨币种 copy 拒绝、过期/stale preview、30/31 天逾期边界、收款不影响余额、管理员互相停用竞态、认证角色 403、内部备注不进入客户投影、唯一门户账号和 password reset session 撤销。

## 已决定

以下 12 项由用户于 **2026-10-14** 最终决定。评估参考 `/workspace/fsb-runs/p5-decisions-claude.md`，最终范围以用户决定为准。本步交付共享契约与测试，服务、迁移及 UI 仍按计划实现。

| #   | 决定                                     | 契约与后续落实                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A，允许取消未来费率版本                  | 新增 `POST T/rates/cancel-future-version`，body 为 versionId，响应含 auditId、cancelledVersionId。仅在现有 lock_tenants 下核验归属及 `effective_from > DB now() + margin`（默认 60 秒，等于边界也拒绝）后取消；已生效历史不可删。审计 `rate_schedule_cancel` 保存 cancelledVersionId 与完整 entries。时钟余量见费率流程。 |
| 2   | 门户账号在租户成功后单独创建             | 租户 HTTP 成功后再创建门户账号。该次创建在同一业务事务内 `auth.insert_user`、写 profile 与审计，并 `auth.insert_credential`。失败回滚，不留下永久 auth.user，没有 activate 或 cleanup job。管理员创建同流程，见第 m 项。                                                                                                  |
| 3   | 原建议，管理员首次登录强制改密，另步设计 | 管理员和门户账号首次登录、密码重置后均强制改密。临时密码默认 72 小时失效，认证状态与流程另步实现，见 j、k、l。                                                                                                                                                                                                            |
| 4   | A，只支持整笔全额确认                    | confirm-payment 不接收 amount。部分到账先保留 pending，等全额到账后一次确认。独立作废、撤销误确认与重新确认已由 a、b 一起决定。                                                                                                                                                                                           |
| 5   | 人工金额按操作限制精度且全部有上限       | topup/credit_topup/gift 最多 2 位小数，adjustment 最多 4 位；overdraftLimit、lowBalanceThreshold 非负且最多 2 位。默认最多 10 位整数，分别最大 9999999999.99 / 9999999999.9999，以命名常量与 schema factory 配置，独立于 128 字符传输保护。                                                                               |
| 6   | B，限制 CSV 容量并保留 rating 方言       | 文件 <=2 MiB；DEFAULT_ADMIN_RATE_MAX_ROWS = 10000，可配置，已决定（2026-10-14，约 200+ 国家、每国若干费率，1 万行足够）。接受中文表头 `前缀,国家,费率`。预览 TTL 可配置，默认 60 分钟已决定（第 n 项）；提交时复查版本、时间与过期状态。                                                                                  |
| 7   | 接受文本上限，租户编码输入转大写         | name/country 200、notes/remark 2000、idempotencyKey 200、code 64。Zod transform 将 code 转大写；DB 步骤须落实不区分大小写唯一约束，并检查存量碰撞。                                                                                                                                                                       |
| 8   | A，状态内先按币种分组                    | suspended、overdraft、low_balance、normal、disabled；同状态 CNY、USD 分组，再组内 balance ASC，最后 code/id。不跨币种比较金额。                                                                                                                                                                                           |
| 9   | A，停用拒绝正常授权，不承诺呼叫停止      | 提示须说明已接通电话继续按原上限结束并正常计费；Worker 超时可能继续放行新呼叫最多 1800 秒，不能承诺呼叫停止。欺诈紧急切断采用下述人工 runbook。                                                                                                                                                                           |
| 10  | A，逾期按北京时间自然日差                | pending 且 ageDays >30 才 overdue，30 天不高亮，31 天高亮；已收款不再 overdue。                                                                                                                                                                                                                                           |
| 11  | A，阶段 5 包含管理员启用及门户停用/启用  | 三个 POST 端点均要求 admin session，返回 auditId，分别审计 admin_enable、portal_account_disable、portal_account_enable。门户停用仅影响登录/会话，不改变租户呼叫状态。                                                                                                                                                     |
| 12  | A，非负两位阈值，允许空收件人            | 邮箱先 lowercase、去重，再最多 20 个。开户省略 emails 仍由服务填当前管理员邮箱。空数组可保存；设置响应保留 emails，UI 读取该字段为空时必须显示“未配置收件人，余额提醒无法送达”，加载和保存后均显示。停用管理员邮箱保留并在设置页标记，见新增决定。                                                                        |

### 可配置默认值与边界

`DEFAULT_ADMIN_AMOUNT_MAX_INTEGER_DIGITS = 10` 是各人工操作与设置金额的默认业务上限。`createAdminInputAmountSchemas(maxIntegerDigits)` 可生成另一上限，API 与 Web 必须采用相同配置构建请求 schema；现有导出契约使用默认值。2 / 4 位精度是已决定规则，不随上限配置改变。输入超精度拒绝，不舍入。账本、余额、消费合计及 `adminTenantSettingsResponseSchema` 响应继续保留原始 decimal strings，人工输入限额不追溯改变历史数据。settings 响应的 overdraftLimit 沿用 DB 非负约束；threshold 的 DB 列无非负约束，响应允许历史负值。settings 请求使用独立 `adminTenantSettingsRequestSchema`；emails 输入先限制原始数组最多 100 项，再小写去重后最多 20 项，响应不变换或限制已保存邮箱数组。余额确认对话框显示输入的完整金额，特别是四位调账。

`DEFAULT_ADMIN_CSV_MAX_BYTES = 2 * 1024 * 1024`、`DEFAULT_ADMIN_RATE_MAX_ROWS = 10000` 分别限制原始解码字节与 entries 数量，表头和空行不算 entries。`createAdminCsvFileSchema(maxBytes)`、`createAdminRateEntriesSchema(maxRows)` 支持配置。默认 base64 最大长度 2796204 仅作传输保护，schema 还按 padding 计算解码长度，拒绝相同编码长度内的多一字节；API 解码后再次核验真实字节，防止绕过。上调行数前须核对用户最大实际表与整表版本复制的存储成本。费率读取响应与取消审计快照使用 `adminRateEntriesResponseSchema`，保持单条费率结构校验，整表不应用输入行数上限。

`DEFAULT_ADMIN_RATE_PREVIEW_TTL_MS = 60 * 60 * 1000` 已决定为默认 60 分钟，后续服务允许配置并据此生成 expiresAt。本步未实现预览存储或过期行为；TTL 不延长已过期 schedule 的合法性。

`DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000` 与 `createAdminRateScheduleSchema(horizonMs)` 定义排期上限。请求 parse 时以同一次 Date.now() 读取校验闭区间，任何带 offset 的 ISO 时间均可，包括秒和毫秒，不做整分钟限制。Web 北京时间分钟选择器是后续 UI。`createAdminRateRequestSchemas(horizonMs)` 返回 schedule、editRequest、importPreviewRequest、copyPreviewRequest，三个请求共享同一 schedule schema。API 初始化构建一次 `rateRequests = createAdminRateRequestSchemas(config.horizonMs)`，再用 `createAdminApiContract(rateRequests)` 注册 operation；import 与 copy commit 对存储计划使用 `rateRequests.schedule.parse`。不能混用默认 adminApiContract 与配置实例。默认请求导出与 adminApiContract 也由同一默认实例生成。历史 version 响应不受 horizon 限制。

`DEFAULT_ADMIN_TEMPORARY_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000` 为账号临时密码的配置默认值。后续 auth 记录签发时刻，在登录时拒绝 now >= issuedAt + TTL 的临时密码，不靠后台任务。管理员和门户创建、重置均适用，成功改密后不再受临时密码 TTL 约束。本步只交付常量，不新增认证字段或改变登录服务。

## 已决定（新增，2026-10-14）

用户决定以下 a–o 和收件人补充项全部遵循 `/workspace/fsb-runs/p5-pending-claude.md` 的意见及其修订。已决定不表示后续服务或 UI 已实现。

| 项         | 决定                                           | 本步与后续落实                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a          | credit 冲正后独立作废应收，与 b 一起决定       | 本步新增 void 端点、reason/冲正关联 schema、voided 状态和审计。后续新增每 credit 唯一的作废事件，原流水不可变；adjustment 不自动关闭应收。                                                                                                                                                                                                                   |
| b          | 追加撤销确认事件，允许再次确认                 | 本步新增 reverse-payment schema/端点/审计及 received.settlementId，confirm 必填 expectedLatestSettlementId，响应保留 latestSettlementId，保留 ALREADY_RECEIVED。后续新增 receivable_settlement_reversals，每 settlement 唯一，reason、actor 必填；删除每 credit 只可一个 settlement 的 unique；持既有 lock_tenants 检查无未撤销确认，view 取最新未撤销确认。 |
| c          | disabled 租户允许全部充值、赊账、赠送          | 后续余额 service 允许操作且保持 disabled；Web 确认对话框明确不会自动启用。                                                                                                                                                                                                                                                                                   |
| d          | 有排期时取消、修改当前、重新排期               | 后续 Web 使用既有三步端点，各自审计并提示中间状态；不加原子替换端点。                                                                                                                                                                                                                                                                                        |
| e          | 大额 gift/credit 仅前端二次确认                | 超过 CNY 10000 / USD 1500 时二次确认，阈值为前端配置。本步无 confirm token，API 无额外审批字段；第二审批人以后另行设计。                                                                                                                                                                                                                                     |
| f          | 阶段 5 人工审计用受限只读 DB                   | 迁移 `0014_audit_reader.sql` 新增运维只读角色与按 tenant/action/time 的保存查询，用法见下文；操作日志页面仍阶段 8，不新增审计读写 API。                                                                                                                                                                                                                      |
| g          | 前端分钟选择器，服务任意 ISO 且有 horizon      | 本步 Zod 接受 now 至 now+可配置 horizon，默认 365 天，边界有测试；不要求 +08:00 或整分钟。Web 北京时间分钟输入后续实现。                                                                                                                                                                                                                                     |
| h          | 未来 6/6、1/1 精度届时决定                     | 启用这些计费周期前确定 scale 与舍入时点，scale 8、每话单最终金额 half-up 仍是未来评估候选。现 DB numeric 无固定 scale，无需本步迁移；四位 adjustment 不承诺精确冲正未来周期。                                                                                                                                                                                |
| i          | 存量碰撞检测、人工重命名，授权与 ingest 均大写 | 创建输入 transform 已有。后续在不区分大小写 unique index 前检测碰撞并核对现有 FreeSWITCH billing_tenant 与 stored codes，人工重命名，不留永久别名；worker 授权与 CDR ingest 两个边界都规范化。                                                                                                                                                               |
| j          | 门户与管理员首次登录同样强制改密               | `temporary_password_issued_at` 为唯一标记。除 session、logout、change-password 外返回 403 `PASSWORD_CHANGE_REQUIRED`。登录与 session 响应包含 `passwordChangeRequired`。                                                                                                                                                                                     |
| k          | 两类账号重置后再次强制改密                     | 重置在同一业务事务内 `auth.set_credential`、撤销全部会话并写审计。成功改密清除标记、撤销旧会话并签发新会话。                                                                                                                                                                                                                                                 |
| l          | 临时密码默认 72 小时过期，可配置               | 登录时按签发时间拒绝过期临时密码，不新增后台任务。成功改密后不再受该 TTL 约束。                                                                                                                                                                                                                                                                              |
| m          | 管理员与门户同一事务创建                       | 同一业务事务内 `auth.insert_user`、profile、审计、`auth.insert_credential`。失败回滚，不留下永久 orphan，也没有单独 activate。                                                                                                                                                                                                                               |
| n          | 预览 TTL 可配置，默认 60 分钟                  | 本步已有默认常量；后续存储与 commit 检查 expiry、base version 和 schedule。                                                                                                                                                                                                                                                                                  |
| o          | 取消排期余量可配置，默认 60 秒                 | 本步导出默认常量；后续 service 在 DB 时间下拒绝临近生效取消，并监测 NTP；trigger guard 保留，不增加锁。                                                                                                                                                                                                                                                      |
| 收件人补充 | 停用管理员邮箱保留并标记                       | 后续设置页面加载和保存后标记“属于已停用管理员，请确认收件人”，查询管理员资料用于展示；不自动移除或改为兜底，不改变保存的 emails。                                                                                                                                                                                                                            |

### 运维审计查询（决定 f）

`fs_billing_audit` 是不能登录的组角色。它没有任何表权限，只能执行 `audit_operation_logs(tenant_code, action, from, to)`。参数为 NULL 时不过滤该条件。租户编码不区分大小写，时间窗为 `[from, to)`。运维用自己的登录角色加入该组：

```sql
CREATE ROLE alice LOGIN PASSWORD '...' IN ROLE fs_billing_audit;
SELECT * FROM audit_operation_logs('ABC001', 'tenant_create', '2026-10-01', '2026-11-01');
```

每次手工执行 GRANT 或 ALTER DEFAULT PRIVILEGES 后，以库属主执行 `SELECT * FROM audit_role_violations();`，结果应为零行。

## 已决定（概况与门户首页，2026-10-15 01:56 PT）

用户已确定以下六项业务口径。

1. 消费仅统计 `ledger_entries.kind = 'call_charge'`，金额为扣费金额取正。不含充值、赊账、赠送、调账、应收作废及撤销确认事件。消费按流水 `occurred_at` 对应的接通时间归属。
2. 分钟为 `cdrs.billed_minutes` 的账单计费分钟，按现有逐分钟向上取整规则，不按实际通话秒数换算。
3. 已接通通数与分钟按 `answered_at` 归属；未接通通数按 `started_at` 归属。跨月开始、次月接通的电话计入接通月份。
4. 余额不足等计费拒绝呼叫计入后台未接通通数。后台显示已接通与未接通，未来门户首页只显示已接通。共享服务返回两种通数，本步不实现门户端点。未归属话单尚未有租户，不计入概况。
5. 最近 30 天包括今天，恰好为今天及之前 29 个自然日，缺失日期补零，最后一柱为当前快照内的今日消费。
6. 所有租户，包括 USD，均使用 `Asia/Shanghai` 的日期与月份边界。

`readTenantUsageOverview(tx, tenantId, now?)` 在一个 SQL statement 内读取租户、流水、话单与日期序列，以同一快照计算全部指标。默认 `asOf = statement_timestamp()`，测试可注入时间。`asOf` 表示读取快照的时间，不是事件时间上限。本月指标使用 `< 下月月初`，最近 30 天消费使用 `< 明日零点`，边界均按 `Asia/Shanghai` 计算，因此 FreeSWITCH 时钟略快于数据库时仍能计入当前期间内已入库的事件。读取不获取租户锁、行锁或 advisory locks；后台使用 `withAdmin`，未来门户使用登录租户的 `withTenant`，不可见租户返回 NOT_FOUND。列表和详情的 `monthConsumption` 保留现有字段名，与概况 `monthSpend` 共用 SQL 定义。迁移 `0010_cdrs_tenant_started_at.sql` 为 `cdrs (tenant_id, started_at)` 添加索引，现有与新建月分区通过 PostgreSQL 分区索引继承。该普通 `CREATE INDEX` 会阻塞写入，仅适用于上线前的开发、CI 或空库。当前 migrator 在事务内运行；上线后为 `cdrs` 等大分区表新增索引，必须按运维手册在迁移事务外逐分区执行 `CREATE INDEX CONCURRENTLY`，再附加到以 `ON ONLY` 创建的父索引，见[阶段 10 检查项](plan.md#阶段-10部署与上线)。

流水扣费异步入账，消费可能落后于话单分钟和通数；reconcile 的 5 分钟是扫描最小年龄，不是延迟上限。按接通时间归属的历史扣费和阶段 8 归属回填会改变历史日消费。已关闭月份的话单清理不影响当前月分钟，账本消费不依赖话单保留。种子通话扣费位于 2026 年 9 月，其他月份实时查询可能为零；未来界面验收需要相对当前日期的 fixture。

## 已决定（阶段 5 Web 缺口，2026-10-15）

用户于 2026-10-15 接受 `/workspace/fsb-runs/p5web-gaps-claude.md` 的**全部**建议（G1–G11，以及费率、待收款、账号管理和 e2e 相关项），并决定本阶段契约不支持的设计稿元素直接省略，不为此修改后端。本节只记录决定，实现以 phase-5-web 分支各 chunk 为准。

| 项  | 决定                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | 待收款页加「待收款 / 已收款 / 已作废」分段，对应契约 `status` 筛选；待收款行可确认收款或作废，已收款行可撤销确认，已作废只读。                                                                                                                                                      |
| G2  | 作废对话框读取该租户 adjustment 流水，列出金额恰为赊账相反数且晚于赊账的候选供选择；没有候选时说明须先调账（调账不自动关闭应收），并给出预填的调账入口。是否匹配最终由服务端判定（RECEIVABLE_REVERSAL_MISMATCH）。                                                                  |
| G3  | 验收补充 Web e2e：`admin-receivables.spec.ts` / `reverses then reconfirms with fresh token`、`voids with linked adjustment`、`refreshes after settlement conflict`；`admin-accounts.spec.ts` / `shows temporary password once`、`blocks self disable`、`portal reset and disable`。 |
| G4  | 已有排定的未来版本时，单条编辑、导入、复制按钮禁用并提示「请先取消排定」，保留 409 RATE_VERSION_CONFLICT 兜底；流程按决定 d（取消 → 改当前 → 重新排期）。                                                                                                                           |
| G5  | 导入/复制遇 PREVIEW_EXPIRED、PREVIEW_STALE、RATE_VERSION_CONFLICT 退回第 1 步，保留已选文件（或目标）与生效时间，提示重新预览；commit 响应丢失后再收到 STALE 时刷新费率表并提示「可能已导入，请核对」，不自动重试。                                                                 |
| G6  | 错误列表的「原始内容」列由浏览器本地解码文件（UTF-8 fatal，失败再 GBK fatal）按服务端行号取出，只用于显示；行号规则与服务端一致（含表头、从 1 开始）。                                                                                                                              |
| G7  | 上传步只显示文件名和大小，编码与行数放到预览步标题。                                                                                                                                                                                                                                |
| G8  | 「下载 CSV 模板」由前端静态生成：UTF-8 带 BOM，表头 `前缀,国家,费率`，示例一行 `1,美国,0.0500`。无后端接口。                                                                                                                                                                        |
| G9  | 复制对话框按方向参数化：费率标签页「复制到其他租户」（推）与空表状态「从其他租户复制」（拉）共用；路径 tenantId 始终为来源，body.targetTenantId 为目标，只列同币种租户。                                                                                                            |
| G10 | 已收、已作废行的确认人、作废人姓名用管理员列表把 UUID 映射为姓名，找不到显示「—」，不改后端。                                                                                                                                                                                       |
| G11 | 排期版本卡片也提供导出 CSV，按 versionId 调用既有导出接口。                                                                                                                                                                                                                         |

**契约不支持、阶段 5 省略的设计稿元素**（不改后端，不做占位或伪造显示）：待收款「超过 30 天 N 笔 · ¥X」卡片及各币种笔数；待收款按已欠天数排序（沿用 API 默认顺序）；排期版本的排定人与排定时间；费率表每行「生效时间」列（契约只有版本级生效时间）；复制目标列表中各租户的费率条数；门户账号「停用于 … 操作人」与「密码最后修改」；CSV 原型中同时叠加多条排定的单条修改（契约同一时间只允许一个未来整表版本）；由后端补充确认人/作废人姓名字段（改用 G10 前端映射）。

**2026-10-16 补充（待收款作废，B3）**，用户接受以下建议：

- 作废时预填的冲正调账备注格式如「冲正 2026-08-18 充值 ¥2,000.00」：客户可见，不含内部 ID，管理员可编辑。
- 作废候选由服务端最终判定（已被其他作废使用、被后续反向调账抵消等前端看不到的情况）；被拒时显示错误并刷新，前端不模拟服务端规则。
- 接受同一毫秒内（服务端微秒更晚）调账不被列为候选的罕见情况，不改后端。

**2026-10-16 补充（视觉对照）**，Bot 决定：

- 设置页低余额提示保持「余额低于此值时发送提醒」：后端 low_balance 判定为 balance < threshold（`packages/db/src/admin/tenants.ts:55`），不采用设计稿「可用额度低于此值」的写法。
- 确认收款日期使用原生日期输入，显示格式随浏览器语言环境（如 headless Chromium 显示 10/16/2026），接受，不另做文本输入。

此前已定口径同样适用于 Web：强制改密页复用门户账号设置卡片并放在登录布局；门户可选初始密码由服务端生成；开户时 CSV 随创建一起提交，全有或全无；概况口径见上一节。

## 待用户确认

无。CSV 行数上限已于 2026-10-14 决定为 10000（`DEFAULT_ADMIN_RATE_MAX_ROWS`，可配置）：约 200+ 国家、每国若干费率，1 万行足够。

## 本步验证

此前记录保留如下。本轮新增决定的验证结果在本节末尾更新。

2026-10-14 本轮修复使用 Node 24.21.0 运行 `PATH=/tmp/phase-5-bin:/usr/bin:$PATH pnpm check`，退出码为 0。lint、format:check、全仓 typecheck、367 个仓库测试（另 1 个跳过）、76 个 Web 测试和 Web production build 全部通过。后台契约与 CSV 两个测试文件共 79 项通过。完整输出保存在 `/tmp/p5-dec-check.log`。

API integration、CSV handler 解析后限制、portal projection 路由接入、凭据失败补偿与 Playwright 均为计划，不能用 schema 通过代替这些行为验证。本步包含独立门户流水 schema 与投影测试，以及现有 customer operation 的 schema 图不引用 admin schema 的检查；它们不能替代后续真实门户路由防泄漏测试。收款响应测试覆盖 settlement note、已收不逾期、早于赊账日期的拒绝与北京时间日期边界。审计测试覆盖缺失 actor、occurredAt、target、content、操作专属字段，以及单独 content 联合的验证。

2026-10-14 新增 16 项决定本轮验证使用 `PATH=/tmp/phase-5-bin:/usr/bin:$PATH pnpm check`，退出码 0。lint、format:check、全仓 typecheck、374 项仓库测试（另 1 项跳过）、76 项 Web 测试与 Web production build 通过。shared admin 两个文件共 58 项通过，其中新增 7 项契约测试覆盖 horizon、void/reverse 端点和事件、状态、审计、无 confirm token 及配置默认值。完整输出 `/tmp/p5-pending-check.log`。本轮未实现迁移、服务、Worker、auth 或 Web 行为，验收映射中的后续测试仍为计划。

2026-10-14 pending review 的 7 项修复使用 `PATH=/tmp/phase-5-bin:/usr/bin:$PATH pnpm check`，退出码 0。lint、format:check、全仓 typecheck、378 项仓库测试（另 1 项跳过）、76 项 Web 测试与 Web production build 通过。shared admin 测试共 62 项，新增 4 项覆盖确认 token 必填与冲突映射、pending 最新历史 token、短于与长于默认值的统一 horizon 及提交时重新验证。完整输出 `/tmp/p5-pend-review-check.log`。服务的 stale-request 状态比较、作废唯一约束、冲正时序和错误优先级仍按上述映射留待后续实现。

## 阶段 5 后端补强，2026-10-17

### 费率预览使用 Postgres 存储

补强前 `createAdminRatesService` 把预览保存在进程 Map。预览和提交落在不同实例时无法读取，进程重启也会丢失预览。公开接口继续使用现有 previewId，不增加请求或响应字段。

比较以下方案后，推荐并实现 Postgres 表。

| 方案                                   | 优点                                                 | 代价与限制                                           |
| -------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Postgres `admin_rate_previews`，带 TTL | 多实例共享；重启保留；使用状态与版本、审计同事务提交 | 增加迁移和预览读写；需要清理过期数据                 |
| 保留 Map，文档限制单实例               | 无迁移，改动少                                       | 必须始终单实例；滚动重启丢失预览；扩容前仍需重做存储 |

数据库方案不要求粘性会话，也不把部署限制当作业务正确性的前提。

表以 UUID previewId 为主键，保存目标 tenant_id、预览 payload、expires_at 和 consumed_at。payload 使用 import/copy 联合，绑定 actorId、路径租户、基准版本、完整费率快照、排期及文件摘要或来源版本。读回时按 Zod schema 解析；存储 schema 复用 shared 的静态排期形状，当前时间与 horizon 规则仍在提交时校验。不兼容的旧 payload 返回 PREVIEW_STALE。Drizzle 描述包含与迁移同名的外键、payload check 和过期索引，JSONB 类型从 payload schema 推导。RLS 仅允许 admin scope 读写，门户不可读取预览。预览不保存原始 CSV。

`savePreview(tx, tenantId, preview, before, currency, encoding)` 在事务提交后返回现有预览响应。`commit(kind, mutation)` 在管理员事务内先读取目标 tenant_id、consumed_at 和 payload 的 kind、pathTenantId、actorId 文本投影；已使用或身份不符的请求立即返回 PREVIEW_STALE。取得现有目标 `lock_tenants` 后才读取和解析完整 payload，重新执行全部校验。锁后校验 actor、路径、用途和 consumed_at，并使用数据库 `clock_timestamp()` 检查 TTL，再校验基准版本和排期。复制使用预览中展示的来源版本快照，并验证来源版本仍存在。版本、审计和 consumed_at 在同一事务中写入，失败一起回滚。不显式获取预览行锁，不添加 advisory lock 或外部副作用。

重复提交及不存在、用途或身份不符的 token 返回现有 `PREVIEW_STALE`；未使用但已过期的预览返回 `PREVIEW_EXPIRED`。并发提交通过同一个目标租户锁串行，后到者重读 used 状态后拒绝。新预览创建时清理过期超过一天的记录，保留一天用于返回明确的过期错误。TTL 是提交校验，不依赖清理是否执行；没有新预览时旧记录暂留但不可提交。

此决定按 Model the Domain 使用 import/copy 联合和明确的 consumed_at 状态，按 Prove It Works 用跨 service、跨连接池及并发提交的真实数据库测试验证。数据库未分类错误继续交由现有映射返回 500 INTERNAL_ERROR，只有现有分类中的暂时性错误返回 503。

### 其他补强的边界

连接池在共享 `connect` 入口注册空闲连接错误处理器。API 的业务、认证池及 worker 的业务、队列池分别记录 api.business、api.auth、worker.business、worker.queue 标签。日志包含固定事件和 SQLSTATE 或白名单网络错误码；无错误码的已知连接终止消息转为固定 CONNECTION_TERMINATED。不记录原始错误、client、连接串或密钥。API 与 worker 在连接前创建 pino 实例，并把同一实例传给连接池和 Fastify loggerInstance。连接池日志保留 pino 的数字 level、time、pid 和 hostname，回调不引用尚未初始化的 app。API 四条 redact 规则仍覆盖 cookie、authorization、req.body 和 set-cookie。db 的 poolName 为 string，应用自行指定名称。连接清理由 pg 自己完成。

应收事件继续使用现有复合外键绑定同一 tenant_id，币种由不可修改的 tenants.currency 决定。新迁移补充已收款不可直接作废、已作废不可追加撤销收款事件。现有确认触发器和 append-only 触发器保护确认及修改。门户写入仍先返回权限错误，不暴露状态校验结果。

CSV 文件上限继续使用 shared 的 2 MiB，行数上限继续为 10000。文件 schema 和 `DEFAULT_ADMIN_CSV_BODY_LIMIT` 使用同一 Base64 长度函数，后者再加 256 KiB JSON 元数据余量，仅用于支持 CSV 的开户和导入预览路由。传输和解码字节超限均沿用 413 CSV_LIMIT_EXCEEDED，前端使用已有错误展示。

`listAdmins` 使用一条数据查询，先按状态筛选再 JOIN 批量邮箱结果，排序、搜索、状态和分页保持原有语义。门户列表使用 MATERIALIZED CTE 共用租户筛选结果，再 JOIN 读取邮箱。密码重置在现有管理员事务中通过同一受限函数读取邮箱，管理员服务不再依赖 authPool。每租户最多一个门户账号，密码重置只查一个账号，均不属于随列表增长的 N+1。列表结果只做一次完整行 schema 校验。迁移新增 `auth.lookup_user_emails(text[])`，只返回指定 ID 的邮箱，仅 admin scope 可读。应用角色仍不可 SELECT auth.user，函数固定 search_path 并撤销 PUBLIC 权限。原始 SQL 时间值经 schema 转换后按原有 ISO 格式返回。

各项验证分别位于 `packages/db/src/client.test.ts`、`client.db.test.ts`、`admin/rates.db.test.ts`、`admin/receivables.db.test.ts`、`apps/api/src/admin-rates.test.ts`、`admin-accounts.db.test.ts` 及 `apps/web/src/lib/api-problem.test.ts`。包含空闲连接替换、跨实例预览、并发提交一次、锁等待后的 TTL、审计失败回滚、直接违规 SQL、CSV 等于和超过边界、固定查询次数及前端错误展示。验收运行日志保存在本地 `.audit/phase5-backend/`，不提交。
