# 阶段 5 step 1 设计与共享契约

## 类型与模块布局

本步交付 Zod wire contract 和实现草案。API routes、DB services、迁移、Web 页面均为后续计划。本步没有注册新端点，也不表示阶段 5 已验收。

调用方示意先于实现。Web 使用 `adminBalanceOperationRequestSchema.parse({kind: 'adjustment', currency: 'CNY', amount: '-10.00', reason: '冲正重复充值', idempotencyKey: 'manual:001'})`。API 接收验证后的 `AdminBalanceOperationRequest`，从 admin session 取得操作人，再读取路径对应租户。客户接口仍只能从客户身份取得租户，不能复用这些后台 DTO。

### 核心数据形状

| 类型 / schema                  | 结构与不变量                                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdminTenantSummary`           | 租户身份带唯一币种；余额、可用额度、本月消费、待收款为 decimal strings。`status` 为 active/disabled，`health` 为 suspended/overdraft/low_balance/normal/disabled                                                                  |
| `AdminTenantCreateRequest`     | 编码、名称、币种、settings、initialRates。门户账号单独创建。initialRates 为 blank/entries/csv/copy 联合，copy 必须同时提供 sourceTenantId 和 sourceVersionId。没有客户端 effectiveFrom                                            |
| `AdminTenantEditRequest`       | 名称、联系人、电话、备注均必传，整体替换这些字段。空字符串明确清空联系人、电话或备注。编码和币种创建后不可改                                                                                                                      |
| `AdminTenantSettings`          | overdraftLimit、lowBalanceThreshold 为非负、最多两位小数且有业务上限的 decimal strings。开户 emails 可省略，由服务填当前管理员邮箱；更新 settings 必须明确提交 emails 数组                                                        |
| `AdminBalanceOperationRequest` | kind 联合。topup/credit_topup/gift 为正数；adjustment 为非零有符号数且 reason trim 后非空。topup/credit_topup/gift 最多两位、adjustment 最多四位，全部有业务上限。每次请求带 idempotencyKey 和 currency，服务必须核验等于租户币种 |
| `AdminLedgerEntry`             | 沿用 DB kind，含金额、变动后余额、操作人、时间、收款状态。credit_recharge 的 noteVisibility 必须为 admin，其余为 customer                                                                                                         |
| `AdminRateSchedule`            | immediate 无时间字段；scheduled 带 ISO effectiveFrom。Zod 每次 parse 时调用 Date.now()，要求 effectiveFrom >= now                                                                                                                 |
| `AdminRateVersion`             | 版本 id、历史 effectiveFrom、完整 entries。历史响应时间没有未来时间 refinement                                                                                                                                                    |
| `AdminRatePreviewResponse`     | ok=false 只有非空 errors 数组；ok=true 才有 previewId、expiresAt、encoding、currency、新增/修改/删除明细及 counts。counts 必须等于对应 changes 数量                                                                               |
| `AdminCsvRowError`             | `{line: positive integer, reason: nonempty string}`，与 rating CsvError 一致，物理行从 1 开始，包含表头。一次返回所有错误行                                                                                                       |
| `AdminCurrencyTotals`          | `{CNY: decimal string, USD: decimal string}`，即以 Currency 为键的完整 record。严格拒绝 total、缺币种和 number。无换算或混加字段                                                                                                  |
| `AdminReceivable`              | ledgerEntryId、tenant、内部备注、金额、操作人、ageDays、overdue；payment 为 pending 或 received 联合。pending 且 ageDays > 30 才 overdue                                                                                          |
| `AuditAction` / `AuditPayload` | 以 action 区分的联合，actor、occurredAt、tenantId、target、content 必填，各 action 的 content 有独立必填字段。由服务构造，客户端不能指定 actor 或时间                                                                             |

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
| POST   | `T/settings`                                     | adminTenantSettingsSchema                 | adminMutationResponseSchema                |
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
| GET    | `/api/admin/admins`                              | adminAccountsQuerySchema                  | adminAccountsResponseSchema                |
| POST   | `/api/admin/admins`                              | adminAccountCreateRequestSchema           | adminAccountCreateResponseSchema           |
| POST   | `/api/admin/admins/{id}/reset-password`          | resetPasswordParamsSchema，空 body        | resetPasswordResponseSchema                |
| POST   | `/api/admin/admins/{id}/disable`                 | emptyRequestSchema                        | adminMutationResponseSchema                |
| POST   | `/api/admin/admins/{id}/enable`                  | emptyRequestSchema                        | adminMutationResponseSchema                |

租户详情包含余额卡片与 settings 快照，overview 为本月消费、分钟数和最近 30 个北京时间自然日消费。monthCallMinutes 是非负 decimal string 表示的分钟数，使用独立分钟字符串校验，不带金额语义。ledger 按 occurredAt DESC、id DESC 稳定分页，支持 kind/from/to；page 默认为 1，pageSize 默认为 25，最大 100。待收款 totals 按筛选后的完整结果集统计，不仅当前页。status=pending 合计未收金额，received 合计已收金额。币种过滤时另一键为 "0"，只为固定 wire 结构；Web 不显示未选币种的合计，避免误读为该币种没有应收。rates 的 current 为完整当前版本，scheduled 为未来版本，search 仅筛选展示条目，不改变版本基准。

状态计算优先检查手动 disabled；active 下先 balance+overdraftLimit <= 0 为 suspended，其次 balance < 0 为 overdraft，其次 balance < threshold 为 low_balance，其余 normal。列表筛选 search 编码/名称、health 状态和 currency。排序优先 suspended、overdraft、low_balance、normal、disabled；同状态先币种分组，再同币种 balance ASC，最后 code/id。不同币种之间不比较金额。

### 错误契约

错误仍为 `{error: {code, message, requestId, ...}}`。已有 `VALIDATION_ERROR` 400 带 issues，401 的 UNAUTHENTICATED/SESSION_EXPIRED，403 的 FORBIDDEN/ACCOUNT_DISABLED/IDENTITY_UNAVAILABLE，404 NOT_FOUND，429 RATE_LIMITED，500 INTERNAL_ERROR，503 SERVICE_UNAVAILABLE 均复用。

| code                                                      | HTTP | 条件                                                                              |
| --------------------------------------------------------- | ---- | --------------------------------------------------------------------------------- |
| TENANT_CODE_EXISTS / EMAIL_EXISTS / PORTAL_ACCOUNT_EXISTS | 409  | 唯一冲突或第一版门户账号已存在                                                    |
| CURRENCY_MISMATCH                                         | 409  | 余额请求或复制来源与租户币种不符                                                  |
| IDEMPOTENCY_CONFLICT                                      | 409  | 同租户同 key 已用于不同命令                                                       |
| RATE_VERSION_CONFLICT                                     | 409  | 当前版本已变化、已有未来版本、时间不符合 DB 版本顺序，或与已有 effectiveFrom 重复 |
| PREVIEW_STALE / PREVIEW_EXPIRED                           | 409  | 内容基准变化、提交时指定生效时间已过去，或预览已过期                              |
| ALREADY_RECEIVED                                          | 409  | 已存在独立收款确认事件                                                            |
| SELF_DISABLE / LAST_ADMIN                                 | 409  | 自停用或会导致无启用管理员                                                        |
| CSV_INVALID                                               | 400  | 开户内 CSV 无效，带 rows 全部行错误。普通 preview 以 200 ok=false 返回同形错误    |
| CSV_ENCODING_UNSUPPORTED                                  | 400  | 不能解码为 UTF-8 或 GBK                                                           |
| CSV_LIMIT_EXCEEDED                                        | 413  | 文件或行数超限                                                                    |

## 流程与事务约束

### 开户与身份

新租户默认 active、余额 0；overdraftLimit 未传按 CNY 100、USD 15。lowBalanceThreshold 由请求明确给出。[design.md §8.1](design.md#81-余额提醒按租户设置)规定通知邮箱默认只填管理人员邮箱。开户省略 emails 时服务从已认证管理员资料取得邮箱并写入设置，不能由 Zod 静态默认值猜测；显式 [] 表示无收件人。settings 更新必须提交 emails，省略不会清空。数据库已有 tenants、tenant_balances、balance_alert_settings、rate_versions、rate_entries。费率表逻辑上属于租户，现 schema 没有单独的 rate_tables 实体。

开户在事务内创建首个完整版本，**不传 effectiveFrom**，让 DB now() 填写，保证 effectiveFrom <= 授权查询时的 now。blank 也创建空版本，空表授权拒绝是预期；填充 entries、CSV 或同币种 copy 后立刻授权能匹配。entries 模式给非 CSV 调用者使用；Web 的 CSV 方式提交原始文件，服务端必须独立解码、调用 parseRateCsv，不能信任浏览器解析结果。CSV 错误或币种不符时租户事务整体失败。copy 由服务在事务中读取 sourceVersionId，核验其 tenant_id 等于 sourceTenantId，并核验来源与新租户币种一致；copy 联合要求两个 ID 成对存在。服务读取数据库来源元数据后再调用 adminTenantCopyConsistencySchema，refine 核验版本 ID、租户归属和币种；请求中的 UUID 本身不能证明归属。本步已实现该 refinement 与拒绝错配的测试，后续服务必须接入。

租户创建响应只返回租户，不包含门户账号。Web 在租户事务成功后调用独立门户账号创建端点，第一版最多一个。门户创建失败保留已创建租户并显示可重试的未开户状态，不声称租户和 Better Auth 用户写入原子提交。账号初始密码可指定或由系统生成，创建响应以 passwordSource 区分 generated 和 supplied，temporaryPassword 仅在 generated 分支必填，supplied 分支禁止该字段。生成密码仅创建响应返回。账号不存在时返回空 items，重置复用阶段 4 路径与 temporaryPassword DTO，撤销全部目标会话，管理员安全渠道人工交付，不写日志、不再次查询密码。停止门户账号与停止租户是不同操作，前者不影响呼叫。

Better Auth 1.7.7 已由 [apps/api/package.json](../apps/api/package.json) 锁定；认证表在 auth schema，admins/portal_accounts 引用 auth_user_id，邮箱不在业务资料表。Better Auth 使用不同角色和连接，业务事务不能回滚认证写入。后续门户与管理员账号创建采用受控的分步流程，先创建不可登录的 auth.user，再在业务事务关联资料并写审计；创建 auth.user 时必须处于不可登录状态，优先 banned，或在启用前没有可用凭据；随后在业务事务关联 profile 并写审计，提交后才启用。关联失败保留 disabled orphan，清理任务后续实现；启用失败保留已关联的 disabled 用户，按 profile 与审计记录恢复，恢复不得重复创建或重复写审计。业务 API 拒绝无 profile 的 auth 用户，不能依赖删除补偿保证安全。该方案仍需实现和故障测试，不能走开放注册。现有 password reset 在认证提交之后 best-effort 写审计，这不满足本阶段“每个人工操作有日志”的完整保证，下一步需改造为同一受控事务或可恢复的审计事件交付。此步不修改认证实现。

### 租户停用与人工紧急切断 runbook

停用确认消息使用“停用后拒绝新呼叫授权；已接通电话按原上限结束并正常计费”。Worker 授权超时仍沿用既有最多 1800 秒放行策略，消息不能承诺立即停止呼叫。

欺诈紧急处置由运维手动执行。先停用租户，再使用 `fs_cli -x "show channels as json"` 获取活动 UUID。对候选 UUID 执行 `fs_cli -x "uuid_getvar <uuid> billing_tenant"`，按已核验的租户编码筛选并复核，避免切断其他租户。对确认属于该租户的 UUID 执行 `fs_cli -x "uuid_kill <uuid>"`，重新查询直到目标通话清空。多 FreeSWITCH 节点须逐节点执行；保留运维记录并检查最终 CDR 正常入账。此人工流程不新增后台呼叫控制 API。

### 余额与并发

命令映射 topup -> recharge，credit_topup -> credit_recharge，gift -> gift，adjustment -> adjustment。币种来自租户，提交 currency 仅作一致性核验，赠送没有独立币种。credit_topup 追加流水就形成全额 pending receivable，内部备注仅在 admin 契约存在。客户接口必须构造独立 portal projection，将其显示为普通 recharge / “账户充值”，不输出 internalNote、收款状态或操作人内部字段。noteVisibility 只是后台展示约束，不能作为客户数据过滤器。门户 operation 不得引用 admin ledger 或 receivable schema；本步契约测试检查现有门户 operation 不使用 admin schema，独立 portalLedgerEntrySchema 与 projectPortalLedgerEntry 已实现并测试，credit_recharge 投影为 recharge 且 note 为空，移除 paymentStatus、actor、noteVisibility。防泄漏 integration 测试及路由接入留待门户流水实现。

adjustment 将 reason 存入 ledger.note。冲正以相反金额追加一条 adjustment，不 UPDATE/DELETE 原流水。Zod 拒绝空原因、零金额及非十进制输入；topup/credit_topup/gift 最多两位，adjustment 最多四位，全部应用独立业务上限。DB 保留原有不可变和 kind shape 约束。

所有影响余额的写入只使用 **现有 lock_tenants 每租户事务级 advisory lock**，复用 `lockTenants` 与 `appendLedgerEntry`。不增加 advisory key、进程 mutex 或另一套分布式锁。透支额度、租户状态和费率写入也在对应租户锁保护的事务内执行；锁在任何行写入之前取得。开户先生成 UUID，再取得租户锁后写入。copy commit 的变更锁与审计 tenantId 都指向目标租户。若开户 copy 还需稳定读取来源，使用同一 lock_tenants 按 ID 顺序一次拿齐来源和目标锁，不能另建锁。锁顺序保持 [client.ts](../packages/db/src/client.ts) 与迁移的现有约束。

重试只在最外层事务调用处处理可重试 DB 错误，内部服务和 appendLedgerEntry 不自行 retry。人工余额操作每个确认动作创建一个 key，重试复用。Zod 拒绝以 call: 开头的 key，保留 Worker 的计费命名空间。同租户同 key 同 kind/amount/currency/note/reason 返回原 ledger 与 auditId，不重复审计；载荷不同返回 IDEMPOTENCY_CONFLICT。现有 appendLedgerEntry 只核验 kind 与金额，后续余额 service 必须在持锁情况下补齐备注比较，不能把现有检查当作完整请求幂等性。流水、余额缓存触发器和审计在同事务提交。

开户、门户账号创建、管理员创建未设计可重放的凭据响应，客户端不能自动 retry。若响应丢失，先查询唯一编码或邮箱确认是否已成功；已成功但生成密码丢失时走现有 reset-password 恢复，重复创建返回对应唯一冲突。confirm-payment 重试返回 ALREADY_RECEIVED，客户端随后查询已收状态，不重复写 settlement。rate commit 成功后再次提交同一 preview 返回 PREVIEW_STALE，客户端查询目标版本确认结果；不承诺重放首个响应或额外审计。

ledger 的 balanceAfter 定义为该租户按 occurredAt ASC、id ASC 排序后，从初始 0 到当前条目 inclusive 的 amount 累加。DB 没有 balance_after 列，服务查询计算且分页前覆盖全部先前流水。此值是确定的历史顺序累计，不保证等于管理员提交当刻看到的缓存余额，特别是同一时间戳多笔流水的 UUID 顺序。

管理员同权、禁止自停用、至少一个 active 已确定。管理员停用的并发安全使用一个 SQL 事务中的既有记录行锁与二次计数，不新增业务 advisory locks。需按稳定 ID 顺序锁住当前管理员记录并验证执行者仍 active，避免两个管理员互相停用后清零。停用撤销目标会话。管理员启用、门户账号停用/启用已纳入阶段 5 契约。启用只恢复目标账号状态，不恢复旧会话；门户停用撤销目标全部会话且不影响呼叫，门户启用不自动启用 disabled 租户。业务资料状态、auth 可登录状态与审计跨连接变更须有可恢复交付，失败中间态不得提前放行账号。

### 费率与 CSV

取消排期请求携带 versionId，防止旧页面取消另一版本。在目标现有 lock_tenants 下读版本、核验 tenant_id 与请求 versionId、核验 `effective_from > DB now()`；不符返回 RATE_VERSION_CONFLICT，找不到目标返回 NOT_FOUND。将 cancelledVersionId 与完整 entries 写入 rate_schedule_cancel 审计后，在同一业务事务删除未来版本。DB 既有 guard 使用 clock_timestamp() 再次检查实际时间，禁止事务执行期间已生效版本的删除；竞态映射 RATE_VERSION_CONFLICT，事务回滚。已生效版本、历史话单、当前表不变，不增加锁。

FreeSWITCH answeredAt 与 DB 时钟可能偏差，设计提案是后续服务配置 `RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS` 默认 60 秒，拒绝临近生效的取消并要求监测两端时钟同步。基础条件始终为 DB 时间而非客户端时间；本步不实现余量或 DB 迁移，服务阶段须验证 guard 与余量边界。

单条编辑提交 baseVersionId、完整 entry、schedule。服务用完整基准版本替换这一条，构造新整表版本，保持历史话单按 answeredAt 选版本的行为。已有未来版本时沿用 DB 的单调顺序与禁止修改当前版本规则，返回 RATE_VERSION_CONFLICT，不默默覆盖已排期条目。

导入 wire 为 filename + contentBase64，保留字节供 API 自动识别 UTF-8/GBK。推荐 UTF-8 fatal 解码，失败尝试 GBK fatal 解码；不能默默替换坏字节。复用 [csv.ts](../packages/rating/src/csv.ts) 处理 Unicode 文本，支持 BOM、CRLF、空行、可选首个非空行英文大小写不敏感表头或中文表头 `前缀,国家,费率`，禁止跨行引号和重复前缀。CSV 替换整张表，包含与旧表相同前缀是修改，不是“重复行”。parseRateCsv 成功后，开户与 preview 服务都必须再用 adminRateEntriesSchema 校验完整 entries，包括 country <= 200 的限制。后续 handler 负责把失败映射回物理行号并返回全部错误；本步只有 schema，尚未实现该解析后调用，不能声称 CSV 服务已执行此限制。

preview 不写费率/流水。逐行校验有错误返回全部 line/reason 且不生成 previewId。成功保存或签发服务端可验证的不可篡改预览，绑定 actor、tenant、baseVersionId、文件摘要、完整目标 entries、schedule、expiry。提案默认 60 分钟有效，可配置 DEFAULT_ADMIN_RATE_PREVIEW_TTL_MS，不让客户端自己提交 changes/counts。commit 持租户锁重读版本、校验 preview 绑定与 expiry，再对保存的 schedule **重新调用 adminRateScheduleSchema.parse**，防止预览时合法但提交时已过期的指定时间。成功 preview 的 counts 由 changes 逐类计数，响应 schema 拒绝不一致。提交时 stored schedule 重新 parse 若已过去，映射 PREVIEW_STALE；effectiveFrom 与已有版本重复或违反版本顺序，映射 RATE_VERSION_CONFLICT，不误报只有 previewId 的请求为 VALIDATION_ERROR。任何行错误或 stale 均整表不变。仅用 previewId 的 commit 请求无法自己做时间校验，该步骤是服务端对存储计划的 Zod 验证。

copy preview 和 commit 的路径 tenantId 始终是来源租户，preview body 的 targetTenantId 是目标。服务必须验证 sourceVersionId 属于路径来源租户，再核验来源、目标存在且不同、币种一致。预览绑定 actor、sourceTenantId、sourceVersionId、targetTenantId、目标 baseVersionId、entries、schedule 和 expiry，显示目标整表的新增/修改/删除。commit 从已验证预览恢复目标 tenantId，核验路径仍匹配来源；对目标取得现有 lock_tenants 锁并重读目标版本，写目标整表和审计，AuditPayload.tenantId 为目标租户，target 指向新建的目标费率版本，content.sourceTenantId 保存来源。commit 与导入使用同一校验和整表版本创建逻辑，preview 绑定用途，不能把 import token 当 copy token。导出按指定版本调用 formatRateCsv，返回 UTF-8 CSV 字符串、filename 和 contentType；Web 下载为文件，四位费率，表头 prefix,country,rate。导出使用 POST 和 CSRF/Origin 校验，成功响应必须含 auditId；纯 GET 不能承担写审计的导出操作。

### 收款与审计

confirm-payment 对 credit_recharge 追加 receivable_settlements，写 receivedOn、note、confirmedBy，received 响应保留 settlement note。日期只接受有效 YYYY-MM-DD 且不晚于当前北京时间日期；服务在事务中还必须核验 receivedOn 不早于该 credit 的北京时间日期，此跨记录规则不能仅由请求 schema 证明；received 响应 schema 也拒绝早于创建日的日期。唯一 ledger_entry_id 保证只能全额确认一次。部分到账保持 pending，管理员等全额到账后一次确认。余额和原 ledger 不变，不再写一笔充值。ageDays 暂按北京时间自然日差计算，30 天不高亮、31 天才高亮。CNY 与 USD 分别求和，币种筛选仍返回两键，未选币种为 0。

`AuditAction` 包含 tenant_create/edit/disable/enable/settings_update、portal_account_create/disable/enable、reset_password、balance_topup/credit_topup/gift/adjustment、rate_entry_edit/import/export/copy、rate_schedule_cancel、receivable_confirm、admin_create/disable/enable。reset_password 沿用已有 action 名，target kind 区分 admin/portal_account。

AuditPayload 映射 operation_logs 的 adminId、createdAt、tenantId、action、target、details，并以 action 为 discriminator。content 不再用一组可选字段覆盖全部操作。balance_topup、balance_credit_topup、balance_gift 必须含 ledgerEntryId、amount、currency；balance_adjustment 还必须含 reason。receivable_confirm 必须含 ledgerEntryId、settlementId、amount、currency、receivedOn。费率修改与导入必含 rateVersionId，copy 还必含 sourceTenantId 和 sourceVersionId；export 必含导出版本 ID。rate_schedule_cancel 必含 cancelledVersionId 与完整 entries 快照，因为取消后不能再从关联版本复原整表。租户、设置和账号操作使用各自的 content 字段。changes.field 白名单包括 amount、receivedOn、code 和 currency，支持修改前后值。费率批量日志记录关联版本 ID，取消例外保留完整 entries；changes 字段不承诺已包含完整整表差异。后台查询从关联历史版本复原完整差异为后续计划，本步 schema 不能证明重建已实现。actor/time 由 session/DB 生成。严禁把原请求整体写入 details，密码、cookie、token、CSV 原始文件不得落日志。每个成功人工修改、导入、复制、收款、账号操作及显式导出都有一条日志；纯查询、预览和校验失败不算修改。失败的安全日志不伪装为成功的操作日志。操作日志页本阶段不实现。

## 验收标准对应计划测试

以下逐条映射 [plan.md 阶段 5](plan.md#阶段-5管理后台开户与资金) 的验收。标为“计划”的文件未在本步创建，不能据此勾选整阶段验收。

| 验收标准                                                        | 具体测试文件 / name                                                                                                                                                                                                                                                                                                                                                                                                               | 类型与本步状态                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 完整 ABC001 CNY 开户、CSV、赊账 500、门户账号，列表余额状态正确 | `apps/web/e2e/admin-onboarding.spec.ts` / `creates ABC001, imports rates, credits 500 and opens portal account`                                                                                                                                                                                                                                                                                                                   | Playwright，计划                                                          |
| 错误 CSV 显示所有行号、表不变                                   | `packages/shared/src/api/admin/admin.test.ts` / `CSV failure retains every physical line and cannot carry a commit token`；`apps/api/src/admin-rates.db.test.ts` / `invalid CSV commits no rows or versions`；`apps/web/e2e/admin-rates.spec.ts` / `shows every CSV error line`                                                                                                                                                   | vitest contract 已实现；api integration 与 Playwright 计划                |
| 调账无原因不能提交，反向追加且原记录不变                        | `packages/shared/src/api/admin/admin.test.ts` / `adjustment requires a nonblank reason and a nonzero signed amount`；`apps/api/src/admin-balance.db.test.ts` / `reversal appends opposite amount and preserves original`；`apps/web/e2e/admin-balance.spec.ts` / `blocks blank adjustment reason`                                                                                                                                 | vitest contract 已实现；api integration 与 Playwright 计划                |
| ¥ 和 $ 分别合计，无混加数字                                     | `packages/shared/src/api/admin/admin.test.ts` / `currency totals keep CNY and USD separate and reject a combined total`；`apps/api/src/admin-receivables.db.test.ts` / `totals span all filtered pages by currency`；`apps/web/e2e/admin-receivables.spec.ts` / `renders CNY and USD totals separately`                                                                                                                           | vitest contract 已实现；api integration 与 Playwright 计划                |
| 各页面浅色、深色、手机逐页与种子稿比对，差异记录处理            | `apps/web/e2e/admin-visual.spec.ts` / `matches seeded admin pages in light dark and mobile`，矩阵覆盖列表、开户、详情四 tabs、余额对话框、费率与 CSV、待收款、管理员；`docs/evidence/phase-5-web/visual-differences.md`                                                                                                                                                                                                           | Playwright 截图与人工差异复核，计划                                       |
| 每个人工操作有操作人、时间、对象、内容日志                      | `packages/shared/src/api/admin/admin.test.ts` / `audit payload requires actor, time, target and content and excludes credentials`；`apps/api/src/admin-audit.db.test.ts` / `each manual action emits exactly one complete event`、`failed mutation rolls back audit`、`balance retry reuses audit`、`credential change audit survives failure recovery`                                                                           | vitest contract 已实现；api integration 计划                              |
| 开户首个立即版本 effectiveFrom <= now，立即授权匹配             | `apps/api/src/admin-tenants.db.test.ts` / `first populated rate version uses database now and authorizes immediately`                                                                                                                                                                                                                                                                                                             | api integration，计划。使用真实 DB 与 loadRatingTenant/authorize          |
| 指定时间 >= now，API Zod 拒绝过去                               | `packages/shared/src/api/admin/admin.test.ts` / `scheduled effectiveFrom rejects past and accepts equality at request time`；`apps/api/src/admin-rates.db.test.ts` / `rejects past schedule before writes and revalidates at commit`                                                                                                                                                                                              | vitest contract 已实现；api integration 计划                              |
| 取消未来版本，已生效不可取消，完整审计                          | `packages/shared/src/api/admin/admin.test.ts` / `cancellation contract requires a version and a complete audit snapshot`；`apps/api/src/admin-rates.db.test.ts` / `cancel future version snapshots entries under tenant lock`、`cancel loses activation race without deleting history`；`apps/web/e2e/admin-rates.spec.ts` / `cancels selected scheduled version`                                                                 | contract 已实现；真实 DB 时间/锁竞态与 UI 计划                            |
| 管理员启用，门户停用/启用及审计                                 | `packages/shared/src/api/admin/admin.test.ts` / `%s exposes an admin-only POST and audit action`；`apps/api/src/admin-accounts.db.test.ts` / `enable admin audits without restoring sessions`、`portal disable revokes sessions without disabling calls`、`portal enable preserves disabled tenant`                                                                                                                               | contract 已实现；api integration 计划                                     |
| 人工金额与设置精度、业务上限                                    | `packages/shared/src/api/admin/admin.test.ts` / `%s accepts two decimals and ten integer digits only`、`adjustments accept four decimals and cap both signs without rounding`、`settings require nonnegative two-decimal capped values`；`apps/api/src/admin-balance.db.test.ts` / `rejects excess precision and cap before ledger writes`                                                                                        | contract 边界已实现；DB 不写入验证计划                                    |
| CSV 中文表头、文件/行数边界及大表 TTL                           | `packages/rating/src/csv.test.ts` / `Chinese header preserves the rating dialect and physical error lines`；`packages/shared/src/api/admin/admin.test.ts` / `CSV byte limits reject the extra byte hidden by base64 padding`、`rate row caps are named defaults and configurable`；`apps/api/src/admin-rates.db.test.ts` / `enforces decoded size and row configuration`、`configured preview TTL expires without changing rates` | parser/contract 已实现；handler 与 TTL 行为计划                           |
| 编码大写及唯一、收件人规范化与空邮箱警告                        | `packages/shared/src/api/admin/admin.test.ts` / `tenant codes normalize uppercase at creation`、`recipients lowercase and deduplicate before the twenty-address cap`；`apps/api/src/admin-tenants.db.test.ts` / `case insensitive code collisions fail atomically`；`apps/web/e2e/admin-settings.spec.ts` / `warns for empty recipients after load and save`                                                                      | transform 已实现；DB 唯一与 UI 计划，警告采用 UI 规则而非新 response 字段 |
| 不可登录用户、事务关联与最后启用                                | `apps/api/src/admin-accounts.db.test.ts` / `link failure leaves nonloginable orphan`、`missing profile denies business access`、`enable failure preserves linked disabled user and audit`                                                                                                                                                                                                                                         | api integration 计划；本步仅设计流程                                      |
| 停用不承诺立即断线及人工切断流程                                | `apps/web/e2e/admin-tenants.spec.ts` / `disable confirmation explains live call behavior`；运维按上述 runbook 核验指定租户 UUID、切断及 CDR 入账                                                                                                                                                                                                                                                                                  | UI 计划；人工演练计划，本步仅文档                                         |

补充计划 integration 覆盖并发 topup 与 Worker 扣费、key 冲突、低余额与停机边界、跨币种 copy 拒绝、过期/stale preview、30/31 天逾期边界、收款不影响余额、管理员互相停用竞态、认证角色 403、内部备注不进入客户投影、唯一门户账号和 password reset session 撤销。

## 已决定

以下 12 项由用户于 **2026-10-14** 最终决定。评估参考 `/workspace/fsb-runs/p5-decisions-claude.md`，最终范围以用户决定为准。本步交付共享契约与测试，服务、迁移及 UI 仍按计划实现。

| #   | 决定                                    | 契约与后续落实                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A，允许取消未来费率版本                 | 新增 `POST T/rates/cancel-future-version`，body 为 versionId，响应含 auditId、cancelledVersionId。仅在现有 lock_tenants 下核验归属及 `effective_from > DB now()` 后取消；已生效历史不可删。审计 `rate_schedule_cancel` 保存 cancelledVersionId 与完整 entries。时钟余量见费率流程。 |
| 2   | 分两步开户，认证用户先不可登录          | 租户成功后独立创建门户账号；先建 banned/无凭据用户，在业务事务关联 profile 与审计，最后启用。关联失败留下 disabled orphan，后续 cleanup job 清理；无 profile 的 auth 用户一律拒绝业务访问。                                                                                         |
| 3   | B，强制首次登录改密，另步设计           | 管理员和门户账号均适用，密码重置后再次强制。认证状态与临时密码在强制改密上线前的过期策略作为后续工作（必须落实期限与执行），本步不加入虚构的强制状态或到期字段。                                                                                                                    |
| 4   | A，只支持整笔全额确认                   | confirm-payment 不接收 amount。部分到账先保留 pending，等全额到账后一次确认。撤销应收、撤销误确认分别待确认。                                                                                                                                                                       |
| 5   | 人工金额按操作限制精度且全部有上限      | topup/credit_topup/gift 最多 2 位小数，adjustment 最多 4 位；overdraftLimit、lowBalanceThreshold 非负且最多 2 位。默认最多 10 位整数，分别最大 9999999999.99 / 9999999999.9999，以命名常量与 schema factory 配置，独立于 128 字符传输保护。                                         |
| 6   | B，限制 CSV 容量并保留 rating 方言      | 文件 <=2 MiB；DEFAULT_ADMIN_RATE_MAX_ROWS 暂为 10000，可配置，**须按用户最大实际费率表复核**，用户尚未提供规模。接受中文表头 `前缀,国家,费率`。预览 TTL 提案改为可配置 60 分钟，仍在提交时复查版本、时间与过期状态。                                                                |
| 7   | 接受文本上限，租户编码输入转大写        | name/country 200、notes/remark 2000、idempotencyKey 200、code 64。Zod transform 将 code 转大写；DB 步骤须落实不区分大小写唯一约束，并检查存量碰撞。                                                                                                                                 |
| 8   | A，状态内先按币种分组                   | suspended、overdraft、low_balance、normal、disabled；同状态 CNY、USD 分组，再组内 balance ASC，最后 code/id。不跨币种比较金额。                                                                                                                                                     |
| 9   | A，停用拒绝新授权，不承诺立即断线       | 提示须说明已接通电话继续按原上限结束并正常计费；Worker 超时沿用既有放行规则，不能宣称立即停止所有呼叫。欺诈紧急切断采用下述人工 runbook。                                                                                                                                           |
| 10  | A，逾期按北京时间自然日差               | pending 且 ageDays >30 才 overdue，30 天不高亮，31 天高亮；已收款不再 overdue。                                                                                                                                                                                                     |
| 11  | A，阶段 5 包含管理员启用及门户停用/启用 | 三个 POST 端点均要求 admin session，返回 auditId，分别审计 admin_enable、portal_account_disable、portal_account_enable。门户停用仅影响登录/会话，不改变租户呼叫状态。                                                                                                               |
| 12  | A，非负两位阈值，允许空收件人           | 邮箱先 lowercase、去重，再最多 20 个。开户省略 emails 仍由服务填当前管理员邮箱。空数组可保存；设置响应保留 emails，UI 读取该字段为空时必须显示“未配置收件人，余额提醒无法送达”，加载和保存后均显示。停用管理员邮箱规则见下方待确认提案。                                            |

### 可配置默认值与边界

`DEFAULT_ADMIN_AMOUNT_MAX_INTEGER_DIGITS = 10` 是各人工操作与设置金额的默认业务上限。`createAdminInputAmountSchemas(maxIntegerDigits)` 可生成另一上限，API 与 Web 必须采用相同配置构建请求 schema；现有导出契约使用默认值。2 / 4 位精度是已决定规则，不随上限配置改变。输入超精度拒绝，不舍入。账本、余额和消费合计响应继续保留原始 decimal strings，人工输入限额不追溯改变历史数据。余额确认对话框显示输入的完整金额，特别是四位调账。

`DEFAULT_ADMIN_CSV_MAX_BYTES = 2 * 1024 * 1024`、`DEFAULT_ADMIN_RATE_MAX_ROWS = 10000` 分别限制原始解码字节与 entries 数量，表头和空行不算 entries。`createAdminCsvFileSchema(maxBytes)`、`createAdminRateEntriesSchema(maxRows)` 支持配置。默认 base64 最大长度 2796204 仅作传输保护，schema 还按 padding 计算解码长度，拒绝相同编码长度内的多一字节；API 解码后再次核验真实字节，防止绕过。上调行数前须核对用户最大实际表与整表版本复制的存储成本。

`DEFAULT_ADMIN_RATE_PREVIEW_TTL_MS = 60 * 60 * 1000` 是大表审核的 60 分钟实现提案，后续服务允许配置 TTL，并据该值生成 expiresAt。本步未实现预览存储或过期行为；更长 TTL 不延长已过期 schedule 的合法性。

### 待用户确认的收件人补充提案

**待用户确认**。停用管理员的邮箱若仍在 settings.emails，选项为保留并标记、自动移除、改为系统兜底地址。DEFAULT 提案是保留地址，设置页面标记“属于已停用管理员，请确认收件人”。本步仅记录提案，未加入 disabled-admin 标记字段，也未自动删改 emails；后续确认后再定义资料查询与 response 字段。

## 待用户确认（新增）

以下 9 项均保留记录，DEFAULT 为提案，不代表批准。除第 i 项已有编码大写决定外，本步未新增这些业务行为、端点、状态或限制；第 d 项仅具备已批准的取消端点，未实现一键工作流。第 g 项沿用既有 ISO offset 与 >=now 校验，未新增分钟精度或最长排期限制。

| 项  | 待用户确认的问题                      | 选项                                                                  | DEFAULT 提案与本步边界                                                                                                                                                                                                      |
| --- | ------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | credit_topup 冲正后应收如何作废       | 独立 void-receivable；关联冲正自动关闭；保留待收款人工处理            | **待用户确认**。DEFAULT 独立作废事件，关联原 credit 与冲正流水、必填原因并审计，原流水保持不变。本步无 void 状态或端点，adjustment 不自动关闭应收。                                                                         |
| b   | 如何撤销误确认收款                    | 追加撤销确认事件；完全禁止撤销；双重确认后不可撤销                    | **待用户确认**。DEFAULT 有原因与审计的追加撤销事件，重新成为 pending。本步仍 ALREADY_RECEIVED，不提供 undo。                                                                                                                |
| c   | disabled 租户可否充值、赊账、赠送     | 全部允许且不自动启用；仅允许 topup；全部禁止                          | **待用户确认**。DEFAULT 全部允许以便先补款再启用，保持 disabled。本步未加入状态关联校验，不能视为允许政策已批准。                                                                                                           |
| d   | 有排期时紧急修正当前费率              | cancel→fix→reschedule；原子替换当前与未来；禁止紧急改价               | **待用户确认**。DEFAULT 取消后修改当前、再重新排期，三步分别审计并提示可能的中间状态。本步仅补取消契约，既有版本冲突保持。                                                                                                  |
| e   | 大额 gift/credit 是否额外审批         | 单管理员二次确认；第二审批人；仅金额上限                              | **待用户确认**。DEFAULT 达可配置阈值时二次确认，先提案 CNY 10000 / USD 1500，第二审批人另议。阈值与确认 token 未进入契约，普通金额上限已获批准。                                                                            |
| f   | 阶段 5 如何人工检查审计，页面在阶段 8 | 受限只读 DB 查询；导出；提前做页面；等阶段 8                          | **待用户确认**。DEFAULT 运维只读 DB 查询按 tenant/action/time 检查完整字段，自动 integration 验证事务一致性。本步无审计读取或导出端点。                                                                                     |
| g   | 指定时间的输入规则                    | 北京时间分钟精度并限 365 天；秒精度不限 horizon；可配置精度与 horizon | **待用户确认**。DEFAULT 北京时间展示/输入，分钟精度，最大 365 天且可配置。本步保持 ISO offset 时间与 >=now，不强制 +08:00、整分钟或 horizon。                                                                               |
| h   | 未来 6/6、1/1 计费的金额存储精度      | 固定 scale 与舍入规则；保留 decimal.js 精度；有理数存储               | **待用户确认**。DEFAULT 启用这些周期前定义固定 scale 与舍入时点，先提案 scale 8、每话单最终金额 half-up；须验证余额累加和调账补偿规则。当前四位 adjustment 不承诺精确冲正未来周期的全部扣费。本步不改计费存储。             |
| i   | 租户编码大小写及存量兼容              | 大写规范化并合并碰撞；大写规范化、碰撞人工重命名；保留旧别名          | **已决定** 输入大写及 DB 不区分大小写唯一。仅存量大小写碰撞处置/旧 SIP 编码兼容仍**待用户确认**。DEFAULT 迁移前检测碰撞，人工重命名，并让授权边界规范化输入；不保留永久别名。本步仅实现创建输入 transform，未改授权或迁移。 |

## 本步验证

2026-10-14 使用 Node 24.21.0 运行 `PATH=/tmp/phase-5-bin:/usr/bin:$PATH pnpm check`，退出码为 0。lint、format:check、全仓 typecheck、358 个仓库测试（另 1 个跳过）、76 个 Web 测试和 Web production build 全部通过。后台契约文件包含 49 个通过的测试。完整输出保存在 `/tmp/p5-decisions-check.log`。

API integration、CSV handler 解析后限制、portal projection 路由接入、凭据失败补偿与 Playwright 均为计划，不能用 schema 通过代替这些行为验证。本步包含独立门户流水 schema 与投影测试，以及现有 customer operation 的 schema 图不引用 admin schema 的检查；它们不能替代后续真实门户路由防泄漏测试。收款响应测试覆盖 settlement note、已收不逾期、早于赊账日期的拒绝与北京时间日期边界。审计测试覆盖缺失 actor、occurredAt、target、content、操作专属字段，以及单独 content 联合的验证。
