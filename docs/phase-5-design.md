# 阶段 5 step 1 设计与共享契约

## 类型与模块布局

本步交付 Zod wire contract 和实现草案。API routes、DB services、迁移、Web 页面均为后续计划。本步没有注册新端点，也不表示阶段 5 已验收。

调用方示意先于实现。Web 使用 `adminBalanceOperationRequestSchema.parse({kind: 'adjustment', currency: 'CNY', amount: '-10.00', reason: '冲正重复充值', idempotencyKey: 'manual:001'})`。API 接收验证后的 `AdminBalanceOperationRequest`，从 admin session 取得操作人，再读取路径对应租户。客户接口仍只能从客户身份取得租户，不能复用这些后台 DTO。

### 核心数据形状

| 类型 / schema                  | 结构与不变量                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdminTenantSummary`           | 租户身份带唯一币种；余额、可用额度、本月消费、待收款为 decimal strings。`status` 为 active/disabled，`health` 为 suspended/overdraft/low_balance/normal/disabled |
| `AdminTenantCreateRequest`     | 编码、名称、币种、settings、initialRates、可选门户账号。initialRates 为 blank/entries/csv/copy 联合。没有客户端 effectiveFrom                                    |
| `AdminTenantEditRequest`       | 仅名称、联系人、电话、备注。编码和币种创建后不可改                                                                                                               |
| `AdminTenantSettings`          | overdraftLimit、lowBalanceThreshold 为非负 decimal strings，emails 为邮箱数组                                                                                    |
| `AdminBalanceOperationRequest` | kind 联合。topup/credit_topup/gift 为正数；adjustment 为非零有符号数且 reason trim 后非空。每次请求带 idempotencyKey 和 currency，服务必须核验等于租户币种       |
| `AdminLedgerEntry`             | 沿用 DB kind，含金额、变动后余额、操作人、时间、收款状态。credit_recharge 的 noteVisibility 必须为 admin，其余为 customer                                        |
| `AdminRateSchedule`            | immediate 无时间字段；scheduled 带 ISO effectiveFrom。Zod 每次 parse 时调用 Date.now()，要求 effectiveFrom >= now                                                |
| `AdminRateVersion`             | 版本 id、历史 effectiveFrom、完整 entries。历史响应时间没有未来时间 refinement                                                                                   |
| `AdminRatePreviewResponse`     | ok=false 只有非空 errors 数组；ok=true 才有 previewId、expiresAt、encoding、currency、新增/修改/删除明细及 counts                                                |
| `AdminCsvRowError`             | `{line: positive integer, reason: nonempty string}`，与 rating CsvError 一致，物理行从 1 开始，包含表头。一次返回所有错误行                                      |
| `AdminCurrencyTotals`          | `{CNY: decimal string, USD: decimal string}`，即以 Currency 为键的完整 record。严格拒绝 total、缺币种和 number。无换算或混加字段                                 |
| `AdminReceivable`              | ledgerEntryId、tenant、内部备注、金额、操作人、ageDays、overdue；payment 为 pending 或 received 联合。pending 且 ageDays > 30 才 overdue                         |
| `AuditAction` / `AuditPayload` | enum、actor、occurredAt、tenantId、target、content。由服务构造，客户端不能指定 actor 或时间                                                                      |

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

设计比较采用两个形状。一份全量 admin.ts 可以减少文件数，但把账户生命周期、流水和费率预览的规则放在同一文件。领域模块加单一 facade 让每个规则有归属，且下一步可按领域接入。选择后者。独立设计阅读者确认了现有路由注册器的 exhaustive `ApiOperationId` 和错误映射约束。本步保留 `apiContract` 与 `ApiErrorCode`，新契约不合并进去，避免要求实现 API handlers。此选择应用 Model the Domain 与 Type System Discipline，将余额操作和预览结果编码为联合，将类型从 schema 推导。

## 端点

以下全部要求 **admin session**。复用现有 cookie、身份解析、CSRF/Origin 校验、401/403 和 no-store 约定。修改用 POST 与现有 ApiOperation method 范围一致。params 统一为 `adminTenantParamsSchema` 的 tenantId 或 `adminIdParamsSchema` 的 id。未列 request 的部分使用 `emptyRequestSchema`，无 body 为其 optional 版本。响应统一 200；密码重置两条为已有端点。

路径中的 `T` 仅为表格缩写，展开为 `/api/admin/tenants/{tenantId}`。

| method | path                                             | query / body schema                   | response schema                        |
| ------ | ------------------------------------------------ | ------------------------------------- | -------------------------------------- |
| GET    | `/api/admin/tenants`                             | adminTenantsQuerySchema               | adminTenantsResponseSchema             |
| POST   | `/api/admin/tenants`                             | adminTenantCreateRequestSchema        | adminTenantCreateResponseSchema        |
| GET    | `T`                                              | emptyRequestSchema                    | adminTenantDetailResponseSchema        |
| POST   | `T/edit`                                         | adminTenantEditRequestSchema          | adminMutationResponseSchema            |
| POST   | `T/disable`                                      | emptyRequestSchema                    | adminMutationResponseSchema            |
| POST   | `T/enable`                                       | emptyRequestSchema                    | adminMutationResponseSchema            |
| GET    | `T/overview`                                     | emptyRequestSchema                    | adminTenantOverviewResponseSchema      |
| GET    | `T/ledger`                                       | adminLedgerQuerySchema                | adminLedgerResponseSchema              |
| POST   | `T/settings`                                     | adminTenantSettingsSchema             | adminMutationResponseSchema            |
| GET    | `T/portal-accounts`                              | emptyRequestSchema                    | adminPortalAccountsResponseSchema      |
| POST   | `T/portal-accounts`                              | adminPortalAccountCreateRequestSchema | adminPortalAccountCreateResponseSchema |
| POST   | `/api/admin/portal-accounts/{id}/reset-password` | resetPasswordParamsSchema，空 body    | resetPasswordResponseSchema            |
| POST   | `T/balance-operations`                           | adminBalanceOperationRequestSchema    | adminBalanceOperationResponseSchema    |
| GET    | `T/rates`                                        | adminRatesQuerySchema                 | adminRatesResponseSchema               |
| POST   | `T/rates/edit-entry`                             | adminRateEditRequestSchema            | adminRateVersionResponseSchema         |
| POST   | `T/rates/import/preview`                         | adminRateImportPreviewRequestSchema   | adminRatePreviewResponseSchema         |
| POST   | `T/rates/import/commit`                          | adminRateImportCommitRequestSchema    | adminRateVersionResponseSchema         |
| GET    | `T/rates/export`                                 | adminRateExportQuerySchema            | adminRateExportResponseSchema          |
| POST   | `T/rates/copy/preview`                           | adminRateCopyPreviewRequestSchema     | adminRatePreviewResponseSchema         |
| POST   | `T/rates/copy/commit`                            | adminRateImportCommitRequestSchema    | adminRateVersionResponseSchema         |
| GET    | `/api/admin/receivables`                         | adminReceivablesQuerySchema           | adminReceivablesResponseSchema         |
| POST   | `/api/admin/receivables/{id}/confirm-payment`    | adminConfirmPaymentRequestSchema      | adminConfirmPaymentResponseSchema      |
| GET    | `/api/admin/admins`                              | adminAccountsQuerySchema              | adminAccountsResponseSchema            |
| POST   | `/api/admin/admins`                              | adminAccountCreateRequestSchema       | adminAccountCreateResponseSchema       |
| POST   | `/api/admin/admins/{id}/reset-password`          | resetPasswordParamsSchema，空 body    | resetPasswordResponseSchema            |
| POST   | `/api/admin/admins/{id}/disable`                 | emptyRequestSchema                    | adminMutationResponseSchema            |

租户详情包含余额卡片与 settings 快照，overview 为本月消费、分钟数和最近 30 个北京时间自然日消费。ledger 按 occurredAt DESC、id DESC 稳定分页，支持 kind/from/to；page 默认为 1，pageSize 默认为 25，最大 100。待收款 totals 按筛选后的完整结果集统计，不仅当前页。rates 的 current 为完整当前版本，scheduled 为未来版本，search 仅筛选展示条目，不改变版本基准。

状态计算优先检查手动 disabled；active 下先 balance+overdraftLimit <= 0 为 suspended，其次 balance < 0 为 overdraft，其次 balance < threshold 为 low_balance，其余 normal。列表筛选 search 编码/名称、health 状态和 currency。排序优先 suspended、overdraft、low_balance、normal、disabled；同状态先币种分组，再同币种 balance ASC，最后 code/id。不同币种之间不比较金额。

### 错误契约

错误仍为 `{error: {code, message, requestId, ...}}`。已有 `VALIDATION_ERROR` 400 带 issues，401 的 UNAUTHENTICATED/SESSION_EXPIRED，403 的 FORBIDDEN/ACCOUNT_DISABLED/IDENTITY_UNAVAILABLE，404 NOT_FOUND，429 RATE_LIMITED，500 INTERNAL_ERROR，503 SERVICE_UNAVAILABLE 均复用。

| code                                                      | HTTP | 条件                                                                           |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------ |
| TENANT_CODE_EXISTS / EMAIL_EXISTS / PORTAL_ACCOUNT_EXISTS | 409  | 唯一冲突或第一版门户账号已存在                                                 |
| CURRENCY_MISMATCH                                         | 409  | 余额请求或复制来源与租户币种不符                                               |
| IDEMPOTENCY_CONFLICT                                      | 409  | 同租户同 key 已用于不同命令                                                    |
| RATE_VERSION_CONFLICT                                     | 409  | 当前版本已变化、已有未来版本或时间不符合 DB 版本顺序                           |
| PREVIEW_STALE / PREVIEW_EXPIRED                           | 409  | 内容基准变化或预览已过期                                                       |
| ALREADY_RECEIVED                                          | 409  | 已存在独立收款确认事件                                                         |
| SELF_DISABLE / LAST_ADMIN                                 | 409  | 自停用或会导致无启用管理员                                                     |
| CSV_INVALID                                               | 400  | 开户内 CSV 无效，带 rows 全部行错误。普通 preview 以 200 ok=false 返回同形错误 |
| CSV_ENCODING_UNSUPPORTED                                  | 400  | 不能解码为 UTF-8 或 GBK                                                        |
| CSV_LIMIT_EXCEEDED                                        | 413  | 文件或行数超限                                                                 |

## 流程与事务约束

### 开户与身份

新租户默认 active、余额 0；overdraftLimit 未传按 CNY 100、USD 15。lowBalanceThreshold 和 emails 明确由请求给出，不猜默认收件人。数据库已有 tenants、tenant_balances、balance_alert_settings、rate_versions、rate_entries。费率表逻辑上属于租户，现 schema 没有单独的 rate_tables 实体。

开户在事务内创建首个完整版本，**不传 effectiveFrom**，让 DB now() 填写，保证 effectiveFrom <= 授权查询时的 now。blank 也创建空版本，空表授权拒绝是预期；填充 entries、CSV 或同币种 copy 后立刻授权能匹配。entries 模式给非 CSV 调用者使用；Web 的 CSV 方式提交原始文件，服务端必须独立解码、调用 parseRateCsv，不能信任浏览器解析结果。CSV 错误、币种不符、门户账号开通失败时开户整体失败。

可先开户再单独创建门户账号，第一版最多一个。账号初始密码可指定或由系统生成，生成密码仅创建响应返回。账号不存在时返回空 items，重置复用阶段 4 路径与 temporaryPassword DTO，撤销全部目标会话，管理员安全渠道人工交付，不写日志、不再次查询密码。停止门户账号与停止租户是不同操作，前者不影响呼叫。

Better Auth 1.7.7 已由 [apps/api/package.json](../apps/api/package.json) 锁定；认证表在 auth schema，admins/portal_accounts 引用 auth_user_id，邮箱不在业务资料表。后续账号创建需设计能同时写认证与业务资料及审计的受限事务边界，不能走开放注册。现有 password reset 在认证提交之后 best-effort 写审计，这不满足本阶段“每个人工操作有日志”的完整保证，下一步需改造为同一受控事务或可恢复的审计事件交付。此步不修改认证实现。

### 余额与并发

命令映射 topup -> recharge，credit_topup -> credit_recharge，gift -> gift，adjustment -> adjustment。币种来自租户，提交 currency 仅作一致性核验，赠送没有独立币种。credit_topup 追加流水就形成全额 pending receivable，内部备注仅在 admin 契约存在。以后客户投影将其显示为普通 recharge / “账户充值”，不输出 internalNote、收款状态或操作人内部字段。

adjustment 将 reason 存入 ledger.note。冲正以相反金额追加一条 adjustment，不 UPDATE/DELETE 原流水。Zod 拒绝空原因、零金额及非十进制输入，DB 保留原有不可变和 kind shape 约束。

所有影响余额的写入只使用 **现有 lock_tenants 每租户事务级 advisory lock**，复用 `lockTenants` 与 `appendLedgerEntry`。不增加 advisory key、进程 mutex 或另一套分布式锁。透支额度、租户状态和费率写入也在对应租户锁保护的事务内执行；锁在任何行写入之前取得。开户先生成 UUID，再取得租户锁后写入。复制同时涉及来源/目标时一次按 ID 顺序拿齐必要租户锁。锁顺序保持 [client.ts](../packages/db/src/client.ts) 与迁移的现有约束。

重试只在最外层事务调用处处理可重试 DB 错误，内部服务和 appendLedgerEntry 不自行 retry。人工余额操作每个确认动作创建一个 key，重试复用。同租户同 key 同 kind/amount/currency/note/reason 返回原 ledger 与 auditId，不重复审计；载荷不同返回 IDEMPOTENCY_CONFLICT。现有 appendLedgerEntry 只核验 kind 与金额，后续余额 service 必须在持锁情况下补齐备注比较，不能把现有检查当作完整请求幂等性。流水、余额缓存触发器和审计在同事务提交。

管理员同权、禁止自停用、至少一个 active 已确定。管理员停用的并发安全使用一个 SQL 事务中的既有记录行锁与二次计数，不新增业务 advisory locks。需按稳定 ID 顺序锁住当前管理员记录并验证执行者仍 active，避免两个管理员互相停用后清零。停用撤销目标会话。管理员启用、门户账号停用/启用虽在稿中出现，但未列为本次 step 1 要求的端点，需产品决定是否纳入本阶段。

### 费率与 CSV

单条编辑提交 baseVersionId、完整 entry、schedule。服务用完整基准版本替换这一条，构造新整表版本，保持历史话单按 answeredAt 选版本的行为。已有未来版本时沿用 DB 的单调顺序与禁止修改当前版本规则，返回 RATE_VERSION_CONFLICT，不默默覆盖已排期条目。

导入 wire 为 filename + contentBase64，保留字节供 API 自动识别 UTF-8/GBK。推荐 UTF-8 fatal 解码，失败尝试 GBK fatal 解码；不能默默替换坏字节。复用 [csv.ts](../packages/rating/src/csv.ts) 处理 Unicode 文本，支持 BOM、CRLF、空行、可选首行大小写不敏感表头，禁止跨行引号和重复前缀。CSV 替换整张表，包含与旧表相同前缀是修改，不是“重复行”。

preview 不写费率/流水。逐行校验有错误返回全部 line/reason 且不生成 previewId。成功保存或签发服务端可验证的不可篡改预览，绑定 actor、tenant、baseVersionId、文件摘要、完整目标 entries、schedule、expiry。暂定 15 分钟有效，不让客户端自己提交 changes/counts。commit 持租户锁重读版本、校验 preview 绑定与 expiry，再对保存的 schedule **重新调用 adminRateScheduleSchema.parse**，防止预览时合法但提交时已过期的指定时间。任何行错误或 stale 均整表不变。仅用 previewId 的 commit 请求无法自己做时间校验，该步骤是服务端对存储计划的 Zod 验证。

copy preview 对来源、目标及版本进行存在性、不同租户、同币种校验，显示目标整表的新增/修改/删除。commit 与导入使用同一校验和整表版本创建逻辑，preview 路径绑定用途，不能把 import token 当 copy token。导出按指定版本调用 formatRateCsv，返回 UTF-8 CSV 字符串、filename 和 contentType；Web 下载为文件，四位费率，表头 prefix,country,rate。导出作为人工操作也记录审计。

### 收款与审计

confirm-payment 对 credit_recharge 追加 receivable_settlements，写 receivedOn、note、confirmedBy，唯一 ledger_entry_id 保证只能全额确认一次。余额和原 ledger 不变，不再写一笔充值。ageDays 暂按北京时间自然日差计算，30 天不高亮、31 天才高亮。CNY 与 USD 分别求和，币种筛选仍返回两键，未选币种为 0。

`AuditAction` 包含 tenant_create/edit/disable/enable/settings_update、portal_account_create/disable/enable、reset_password、balance_topup/credit_topup/gift/adjustment、rate_entry_edit/import/export/copy、receivable_confirm、admin_create/disable/enable。reset_password 沿用已有 action 名，target kind 区分 admin/portal_account。

AuditPayload 映射 operation_logs 的 adminId、createdAt、tenantId、action、target、details。content 含 summary、changes 和关联 ledger/version/settlement/sourceTenant ID。changes 的 field 使用白名单，支持修改前后值。调账内容必须含 reason 和 ledgerEntryId，费率批量操作包含完整变更明细，后台查询由关联版本复原。actor/time 由 session/DB 生成。严禁把原请求整体写入 details，密码、cookie、token、CSV 原始文件不得落日志。每个成功人工修改、导入、复制、收款、账号操作及显式导出都有一条日志；纯查询、预览和校验失败不算修改。失败的安全日志不伪装为成功的操作日志。操作日志页本阶段不实现。

## 验收标准对应计划测试

以下逐条映射 [plan.md 阶段 5](plan.md#阶段-5管理后台开户与资金) 八条验收。标为“计划”的文件未在本步创建，不能据此勾选整阶段验收。

| 验收标准                                                        | 具体测试文件 / name                                                                                                                                                                                                                                                                                                                                     | 类型与本步状态                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 完整 ABC001 CNY 开户、CSV、赊账 500、门户账号，列表余额状态正确 | `apps/web/e2e/admin-onboarding.spec.ts` / `creates ABC001, imports rates, credits 500 and opens portal account`                                                                                                                                                                                                                                         | Playwright，计划                                                 |
| 错误 CSV 显示所有行号、表不变                                   | `packages/shared/src/api/admin/admin.test.ts` / `CSV failure retains every physical line and cannot carry a commit token`；`apps/api/src/admin-rates.db.test.ts` / `invalid CSV commits no rows or versions`；`apps/web/e2e/admin-rates.spec.ts` / `shows every CSV error line`                                                                         | vitest contract 已实现；api integration 与 Playwright 计划       |
| 调账无原因不能提交，反向追加且原记录不变                        | `packages/shared/src/api/admin/admin.test.ts` / `adjustment requires a nonblank reason and a nonzero signed amount`；`apps/api/src/admin-balance.db.test.ts` / `reversal appends opposite amount and preserves original`；`apps/web/e2e/admin-balance.spec.ts` / `blocks blank adjustment reason`                                                       | vitest contract 已实现；api integration 与 Playwright 计划       |
| ¥ 和 $ 分别合计，无混加数字                                     | `packages/shared/src/api/admin/admin.test.ts` / `currency totals keep CNY and USD separate and reject a combined total`；`apps/api/src/admin-receivables.db.test.ts` / `totals span all filtered pages by currency`；`apps/web/e2e/admin-receivables.spec.ts` / `renders CNY and USD totals separately`                                                 | vitest contract 已实现；api integration 与 Playwright 计划       |
| 各页面浅色、深色、手机逐页与种子稿比对，差异记录处理            | `apps/web/e2e/admin-visual.spec.ts` / `matches seeded admin pages in light dark and mobile`，矩阵覆盖列表、开户、详情四 tabs、余额对话框、费率与 CSV、待收款、管理员；`docs/evidence/phase-5-web/visual-differences.md`                                                                                                                                 | Playwright 截图与人工差异复核，计划                              |
| 每个人工操作有操作人、时间、对象、内容日志                      | `packages/shared/src/api/admin/admin.test.ts` / `audit payload requires actor, time, target and content and excludes credentials`；`apps/api/src/admin-audit.db.test.ts` / `each manual action emits exactly one complete event`、`failed mutation rolls back audit`、`balance retry reuses audit`、`credential change audit survives failure recovery` | vitest contract 已实现；api integration 计划                     |
| 开户首个立即版本 effectiveFrom <= now，立即授权匹配             | `apps/api/src/admin-tenants.db.test.ts` / `first populated rate version uses database now and authorizes immediately`                                                                                                                                                                                                                                   | api integration，计划。使用真实 DB 与 loadRatingTenant/authorize |
| 指定时间 >= now，API Zod 拒绝过去                               | `packages/shared/src/api/admin/admin.test.ts` / `scheduled effectiveFrom rejects past and accepts equality at request time`；`apps/api/src/admin-rates.db.test.ts` / `rejects past schedule before writes and revalidates at commit`                                                                                                                    | vitest contract 已实现；api integration 计划                     |

补充计划 integration 覆盖并发 topup 与 Worker 扣费、key 冲突、低余额与停机边界、跨币种 copy 拒绝、过期/stale preview、30/31 天逾期边界、收款不影响余额、管理员互相停用竞态、认证角色 403、内部备注不进入客户投影、唯一门户账号和 password reset session 撤销。

## 需要用户决定的问题

只列已核对但未定的规则。已明确的管理员同权/自停用限制、赊账形成应收、adjustment 正负、gift 使用租户币种、同币种复制、CSV UTF-8/GBK 和文件内重复拒绝、密码人工交付不重复提问。下列均不阻塞本步 schema，暂按推荐选项实现契约。涉及上限的推荐已经进入 schema，后续确认后可统一调整。

| 问题与来源                                                                                                                                                                                                                                                                                        | 选项                                           | 推荐与 TODO(decision)                                                                                                                                                           | 是否阻塞契约                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 已排期版本如何取消/修改。[pages.md §3.6](pages.md#36-费率表租户详情内的标签页)未说明冲突处理；[第二批](../design/设计系统规范确认/管理后台%20第二批.dc.html)费率页与[CSV 原型](../design/设计系统规范确认/管理后台%20CSV%20导入原型.dc.html)有“取消排定”，DB `createRateVersion` 禁止早于最新版本 | 保持顺序并拒绝当前修改；提供未来版本取消/替换  | TODO(decision) 保留现有规则，暂不提供取消端点，后续如纳入需明确保留历史和审计规则                                                                                               | 否，RATE_VERSION_CONFLICT 已定义 |
| 首次登录必须改密。[系统与账号](../design/设计系统规范确认/管理后台%20第三批%20·%20系统与账号.dc.html) §2c/2d 要求管理员首次改密；[design.md §10](design.md#10-账号与权限)与现 auth 表/会话契约无强制状态                                                                                          | 提示自行修改；强制阻止其他功能直到改密         | TODO(decision) 推荐强制管理员首次改密，但需另一步认证状态设计；本步复用 temporaryPassword 响应，不虚构 forceChange 已生效                                                       | 否，本步无认证行为改动           |
| 部分付款。[第二批](../design/设计系统规范确认/管理后台%20第二批.dc.html) §6c 只有整笔确认；DB receivable_settlements 唯一且无 amount；[design.md §7.2](design.md#72-流水类型)只列状态转换                                                                                                         | 全额一次确认；支持部分付款与余款               | TODO(decision) 全额确认，不传 amount；部分付款需后续迁移和账务定义                                                                                                              | 否                               |
| 人工金额精度/上限。[design.md §12](design.md#12-时间币种与格式)规定显示两位但无人工金额限制；[pages.md §3.7](pages.md#37-余额操作对话框)明确正负但未限定精度                                                                                                                                      | 任意精确小数；只允许两位；另设业务上限         | TODO(decision) 沿用 existing moneyAmountSchema，128 字符是传输保护，无擅定业务限额                                                                                              | 否                               |
| CSV 容量和兼容方言。[pages.md §3.6](pages.md#36-费率表租户详情内的标签页)与[第二批上传稿](../design/设计系统规范确认/管理后台%20第二批.dc.html)无大小/行数上限；[csv.ts](../packages/rating/src/csv.ts)接受可选表头/BOM/空行/尾空列，不接受多行引号                                               | 无限制；限定大小行数；严格要求表头并收紧方言   | TODO(decision) 暂定解码字节 <= 2 MiB、10000 entries；base64 长度上限 2796204，API 必须再检查实际字节。保留 rating 方言及 BOM 行号，不再写第二解析器。UTF-8/GBK 已确定，不是选项 | 否，CSV_LIMIT_EXCEEDED 已定义    |
| 跨币种状态内顺序。[pages.md §3.3](pages.md#33-租户列表)与[第一批列表](../design/设计系统规范确认/管理后台%20第一批.dc.html)只规定不比不同币种余额                                                                                                                                                 | 状态内 CNY/USD 分组；要求先筛选币种            | TODO(decision) 状态优先，再 CNY、USD，组内余额升序，code/id 保持稳定                                                                                                            | 否                               |
| 租户停用对已接通电话。[design.md §4.2](design.md#42-呼叫前授权)拒绝新呼叫；[租户详情](../design/设计系统规范确认/管理后台%20第三批%20·%20租户详情.dc.html)停用提示暂停呼叫，未定义踢出已接通电话                                                                                                  | 只拒绝新授权；立即断开通话                     | TODO(decision) 新授权拒绝，门户登录/会话已由阶段 4 拒绝，已接通电话按原上限结束并正常计费。不添加 FreeSWITCH 控制接口                                                           | 否                               |
| 逾期 30 天的起算。[pages.md §3.8](pages.md#38-待收款)和[第二批 §6](../design/设计系统规范确认/管理后台%20第二批.dc.html)只有已欠天数；[design.md §12](design.md#12-时间币种与格式)规定北京时区                                                                                                    | 自然日差；满 24 小时计天                       | TODO(decision) 北京时间自然日差，严格 >30，确认后不再 overdue                                                                                                                   | 否                               |
| 启用管理员、停用/启用门户账号的阶段范围。[plan.md 阶段 5](plan.md#阶段-5管理后台开户与资金)只列管理员停用与门户创建/重置；[pages.md §3.5](pages.md#35-租户详情)与[两份第三批稿](../design/设计系统规范确认/管理后台%20第三批%20·%20系统与账号.dc.html)展示这些操作                                | 纳入阶段 5；推迟                               | TODO(decision) 推荐后续纳入以恢复误停用账号，此步只保留 AuditAction 名，不扩展指定端点范围                                                                                      | 否                               |
| 阈值与收件人边界。[design.md §8.1](design.md#81-余额提醒按租户设置)只称数值/多个邮箱；[租户详情设置稿](../design/设计系统规范确认/管理后台%20第三批%20·%20租户详情.dc.html)无负阈值或禁用通知规则                                                                                                 | 非负阈值且允许空邮箱；允许负阈值；独立通知开关 | TODO(decision) 非负，最多 20 邮箱，空数组表示未配置收件人，通知行为到阶段 9 再落实。preview 有效期暂定 15 分钟也是实现默认，非既定产品保证                                      | 否                               |

## 本步验证

共享契约测试覆盖 adjustment 原因、金额符号、内部备注字段、动态时间 refinement、CSV 行错误、重复前缀、currency totals、不可编辑编码币种、独立端点表和审计必填字段。完整 `pnpm check` 的结果以本次实际运行记录为准，不把计划中的 integration 或 Playwright 测试当成已完成。
