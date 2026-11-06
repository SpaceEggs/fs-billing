# 呼入计费、DID 与号码套餐设计

本文写于 2026-11-06，依据 `origin/main`（`5fff74e`，#124）。路径、函数名、表名都在这个提交上核对过；核对不到的写「未核对」。需求由用户于 2026-11-06 确认，本文只做设计，不重新询问。本批与多语言批配套：[i18n-design.md](i18n-design.md)（下称「i18n 文档」，PR 编号 I1–I9）先做，本批的新页面从一开始就用多语言键写；本批 PR 编号仍是 PR 1–PR 9。

**结论。** 号码（DID）成为计费的主键：呼出按主叫 DID 找线路和费率表，呼入按被叫 DID 找租户，租户、线路、费率类别三者决定价格；DID 归属、套餐、月租都存在数据库里，由后台维护。号码规范化改为按 DID 自己的国家码补全（不再固定补 `86`），所以呼出必须先匹配主叫 DID、再规范化被叫。FreeSWITCH 仍然持有一份本地的号码表（由 Worker 导出、服务器 A 主动拉取），这样授权超时放行时仍能路由；授权时再与数据库交叉核对。这批改动推翻 #118 的「呼入不授权、不收费」和 `design.md` 的「无月租」「客户看不到费率」「无冠字号码一律补 86」，涉及授权、入库、账本、账单、门户和 FreeSWITCH 脚本，拆成 9 个 PR（见 [9](#9-pr-拆分与顺序)），排在 i18n 批 I1–I7 之后，第一个付费客户之前全部完成。网站同时要支持英文（i18n 文档），所以国家名、说明、线路名等对客户可见的内容都带英文字段。

三件事需要先知道：用户已逐项确认了原先的待确认事项（D25–D33），[11](#11-待确认事项) 只剩 3 项要线路同事答复（toll free 收费依据、真实报价单、呼出转发主叫格式），费率结构因此仍是暂定的（D3）；有 11 处需求之间的矛盾或风险，见 [10](#10-矛盾与风险)；本文自定的取值集中在 [12](#12-自定取值)，用户 2026-11-06 已审阅、无异议（之后新增的几行单独标明，见 12 末尾）。

## 1. 已决定（用户，2026-11-06）

D25–D41 来源同样是用户 2026-11-06，是同日稍晚对原先待确认事项、多语言需求和页面安排的答复。

| #   | 类别   | 决定                                                                                                                                                                                                                                                                                        |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 线路   | 每个 DID 只属于一条线路。呼出走哪条线路、用哪张费率表，由主叫 DID 决定；主叫必须匹配该租户的 DID 才能呼出                                                                                                                                                                                   |
| D2  | 费率   | 每个租户的每条线路各有三类费率：呼出（按被叫前缀）、普通呼入（按 DID 的国家、号段）、toll free（按主叫号码前缀，区分手机和固话）。价格因租户而异                                                                                                                                            |
| D3  | 费率   | 以上结构是**暂定**的，收到运营商真实报价单后核对                                                                                                                                                                                                                                            |
| D4  | 费率   | 每条国家或地区费率行可选 60/60 或 1/1，没有租户级设置；导入费率的 CSV 多一列                                                                                                                                                                                                                |
| D5  | 费率   | 费率为 0 就是免费，程序里不写死「大陆」；大陆没有 400/800 也按此处理；免费来电仍保留话单                                                                                                                                                                                                    |
| D6  | 币种   | 仍是每租户一种（CNY 或 USD），不换算                                                                                                                                                                                                                                                        |
| D7  | 授权   | 隐藏或无法识别的主叫：只有 toll free 拒接；免费 DID 和固定费率的普通 DID 都接听，国家汇总记「未知」                                                                                                                                                                                         |
| D8  | 授权   | 余额不足：收费 DID 拒接，免费 DID 照接                                                                                                                                                                                                                                                      |
| D9  | 授权   | 租户停用：所有来电拒接（改掉 #118 的「停用也照接」）                                                                                                                                                                                                                                        |
| D10 | 授权   | 收费来电通话中额度用完：让通话打完，保留单通 4 小时上限。呼出不变，额度用完就挂断                                                                                                                                                                                                           |
| D11 | 授权   | 呼入只进客户 PBX，不转接外部号码                                                                                                                                                                                                                                                            |
| D12 | 授权   | 授权超时：放行并标记「未验证」；事后不合规的话单进待办，并通知管理员                                                                                                                                                                                                                        |
| D13 | 维护   | Frank（全局管理员，不加新角色）在后台维护线路和 DID：所属租户、国家、类型、生效时间。换租户后历史话单不能算错                                                                                                                                                                               |
| D14 | 维护   | 全局「号码前缀 → 国家」表系统内置，Frank 可改                                                                                                                                                                                                                                               |
| D15 | 套餐   | 每个 DID 一个套餐：开通费、月租、含分钟数；不同租户价格可不同。和呼入计费同期上线                                                                                                                                                                                                           |
| D16 | 套餐   | 含分钟数抵扣该 DID 的所有收费通话（呼出和 toll free 都算）；超出按正常费率                                                                                                                                                                                                                  |
| D17 | 套餐   | 首月分钟数按比例给；月底未用完清零；一通电话用完剩余分钟时，超出部分按正常费率                                                                                                                                                                                                              |
| D18 | 月租   | 按自然月，每月 1 日（北京时间）预扣当月月租；开通当天扣开通费和当月剩余天数的比例月租；月中退号不退款                                                                                                                                                                                       |
| D19 | 月租   | 余额不够扣：提前 3 天和前 1 天先发通知（目前只发管理员）；该租户所有 DID 一起停，呼入呼出都停；充值后自动恢复并补扣当月月租；号码回收由 Frank 手动决定                                                                                                                                      |
| D20 | 页面   | 话单显示 DID 并可筛选（呼入是被叫，呼出是主叫）；后台和门户都用租户名下 DID 的下拉框                                                                                                                                                                                                        |
| D21 | 页面   | 门户显示：该租户已有线路**当前生效**的三类费率（不显示未来排定的调价）；DID 列表、月租、本月已用和剩余分钟数                                                                                                                                                                                |
| D22 | 账单   | 费用合计含两个方向；分钟数和通话数按呼入、呼出分开显示；月账单要有按 DID 和按方向的汇总                                                                                                                                                                                                     |
| D23 | 账单   | 按国家汇总：呼入按主叫国家，呼出按被叫国家                                                                                                                                                                                                                                                  |
| D24 | 上线   | 内部真实线路测试继续；这批需求在第一个付费客户前完成；没有正式客户数据，不迁移历史数据，测试库可以重置                                                                                                                                                                                      |
| D25 | 授权   | 授权超时期间放行、事后判定不合规的话单，照常向客户计费；Frank 看待办后可手工调账                                                                                                                                                                                                            |
| D26 | 套餐   | 套餐条款（月租、含分钟）可以修改，只从下月 1 日起生效，当月不重复收费                                                                                                                                                                                                                       |
| D27 | 维护   | 第一版不做 DID 归属更正功能，靠未归属待办和人工调账                                                                                                                                                                                                                                         |
| D28 | 维护   | 全局前缀国家表的初始数据用国际电信联盟（ITU）的国家区号表，加北美编号计划（NANP）的区号。数据在 PR 2 准备并逐条核对来源，本文不含数据                                                                                                                                                       |
| D29 | 月租   | 指派 DID 时余额不够付开通费和首月比例月租：立即生效的指派拒绝并提示所需金额；排定生效的到期时不生效并告警，不停整个租户                                                                                                                                                                     |
| D30 | 月租   | 停号期间继续累计月租，满 3 个月告警，由 Frank 决定是否回收                                                                                                                                                                                                                                  |
| D31 | 号码   | 呼出被叫不带国家码时，按主叫 DID 的国家码补全（「号码是美国的就打美国本地」，国家码是 DID 自己的，不是线路的）                                                                                                                                                                              |
| D32 | 号码   | 呼入主叫不带国家码时，按号码本地资费计算，即当作被叫 DID 所属国家的本地号码；`caller_number_format` 默认 `domestic_when_unprefixed`，建线路时不必填                                                                                                                                         |
| D33 | 号码   | 国际来电的主叫基本符合 E.164，带 `+` 或 `00`；隐藏主叫基本没见到，非常罕见，所以 D7「隐藏主叫的 toll free 拒接」误伤的情形很少。D32 的默认值依据此答复。「基本」不是绝对：PR 9 真实来电联调时抓 SIP 头核对，`international_digits` 选项保留                                                 |
| D34 | 多语言 | 后台录入、对客户可见的内容要有英文（i18n 文档 L4）：国家名由 ISO 代码派生标准英文名；说明新增一列英文。本批新表直接带英文字段：`lines.name_en`、`dids.country_en`、`prefix_countries.country_en`；费率 CSV 的 `Description (EN)` 列由 i18n 批 I7 交付，本批在其后加 `Billing Cycle`，共七列 |
| D35 | 多语言 | 导出的 CSV 和账单跟随当前界面语言（L5）：本批新增的导出列（DID、方向、计费秒、抵扣秒、周期等）的表头和系统生成的值也按 `locale`；日期、数字仍是机器友好格式                                                                                                                                 |
| D36 | 多语言 | 顺序（L7）：先做多语言框架和现有页面的英文（i18n 文档 I1–I7），再做本批；本批新页面、新错误码、新枚举、新邮件文字从一开始就写进文案目录（`zh/did.ts`、`en/did.ts` 等），不写死中文                                                                                                          |
| D37 | 多语言 | 客户邮件按账号语言、管理员告警用中文（L3）：本批新增的 `did_fee_notice` 发管理员，用中文；门户的停机横幅要有中英文；`balance_suspended` 正文因本批语义变化而修改，两种语言同时改                                                                                                            |
| D38 | 页面   | 门户的费率和号码合并成一页：去掉单独的「费率」导航和 `/portal/rates` 页面，当前生效的费率放在 `/portal/dids` 页号码卡片的下方；接口 `GET /api/portal/rates` 保留                                                                                                                            |
| D39 | 页面   | 门户的计费周期显示为「按分钟 / 按秒」（英文界面 `Per minute` / `Per second`）；后台继续显示 `60/60`、`1/1`                                                                                                                                                                                  |
| D40 | 取值   | 第 12 节的自定取值用户已审阅，无异议                                                                                                                                                                                                                                                        |
| D41 | 实施   | 实现由外部 CLI（OpenCode，DeepSeek V4.1 flash）完成，所以第 9 节的 PR 说明能让没有本次对话上下文的开发者独立照着做；服务器和联调步骤标注「由主管会话处理」，外部 CLI 不碰服务器、SSH 和密钥                                                                                                 |

## 2. 推翻的现有决定与要改的文档

「改」栏的位置是 `5fff74e` 上的行号或章节。

### 2.1 被推翻的决定

| 原决定                                                              | 出处                                                                                                                                                                                                                                                           | 现在                                                                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 呼入暂时不收费                                                      | `docs/inbound-cdr-design.md` 开头段、「数据」「话单入库」「统计和账单」                                                                                                                                                                                        | 呼入按 D2 收费，免费靠费率 0 实现                                                                                         |
| 余额不足或停用，来电照接，不走授权（决定 #4）                       | `docs/inbound-cdr-design.md` 「已决定」表第 4 行；`freeswitch/README.md`「线路和来电」                                                                                                                                                                         | 来电走授权：停用拒接，余额不足只拒收费 DID                                                                                |
| 号码归属写在 FreeSWITCH 路由（决定 #1）                             | `docs/inbound-cdr-design.md` 「已决定」表第 1 行；`trunk-inbound.xml.example`                                                                                                                                                                                  | 归属以数据库为准，FreeSWITCH 的号码表由 Worker 导出（[4.5](#45-did-与-freeswitch-路由如何保持一致)）                      |
| 呼入不查费率、不入扣费队列、不写流水、不进对账                      | `inbound-cdr-design.md`「话单入库」；`apps/worker/src/ingest.ts`（`cdr.direction !== 'inbound'` 才入队）；`packages/db/src/cdr-intake.ts` 的 `priceAndInsertCdr`、`chargeCall`；`apps/worker/src/reconcile.ts` 的 `c.direction = 'outbound'`                   | 两个方向统一走定价、入队、对账                                                                                            |
| 呼入不进费用合计，用量统计只算呼出                                  | `inbound-cdr-design.md`「统计和账单」；`packages/db/src/usage.ts`、`overview.ts`、`statements/compute.ts`、`portal/cdrs.ts`、`admin/cdrs.ts` 里的 `direction = 'outbound'` 过滤                                                                                | 费用含两个方向，分钟和通话数分方向显示（[8](#8-账单)）                                                                    |
| 「无月租、无接通费」                                                | `docs/design.md` §5 表（第 201 行）                                                                                                                                                                                                                            | 有开通费和月租                                                                                                            |
| 每个租户一张费率表                                                  | `docs/design.md` §6.1                                                                                                                                                                                                                                          | 租户 × 线路 × 类别                                                                                                        |
| 计费周期只有默认 60/60，作为全局参数                                | `docs/design.md` §5 下方段落；`packages/rating/src/billing.ts` 的 `CYCLE_60_60`                                                                                                                                                                                | 每条费率行自带周期                                                                                                        |
| 客户门户不显示费率表                                                | `docs/design.md` §14 第 4 行（第 423 行）；`docs/pages.md` 第 115 行                                                                                                                                                                                           | 门户显示当前生效的三类费率                                                                                                |
| 授权超时放行只描述外呼                                              | `docs/design.md` §4.2；`packages/db/src/alert-list.ts` 第 335 行和 `packages/db/src/alert-notify.ts` 第 506 行的 `c.direction = 'outbound'`                                                                                                                    | 呼入也会被放行；未验证统计和告警含两个方向                                                                                |
| 呼出走固定网关 `upstream`                                           | `freeswitch/dialplan/billing.xml`（`sofia/gateway/upstream/`）                                                                                                                                                                                                 | 按主叫 DID 所属线路选网关                                                                                                 |
| 费率 CSV 五列                                                       | `docs/rate-list-design.md` D2、§5；`packages/rating/src/csv.ts`                                                                                                                                                                                                | 七列（i18n 批加 `Description (EN)`，本批加 `Billing Cycle`）                                                              |
| 「多语言（只用中文）」                                              | `docs/design.md` §2.2 第 33 行；`docs/pages.md` 第 20、37 行                                                                                                                                                                                                   | 中英文双语，见 [i18n 文档](i18n-design.md)；本批的页面、邮件、导出都要双语                                                |
| 无国际冠字的号码一律当大陆号码补 `86`（呼出被叫、呼入主叫的规范化） | `docs/design.md` §4.2 号码规则段和示例表；`docs/freeswitch.md` §3.3；`packages/rating/src/dialed.ts` 的 `normalizeDialedNumber`、`resolveBillingNumber`；`freeswitch/scripts/billing_authorize.lua`（本地投影 `'86' ..`）；`freeswitch/tests/dialed-cases.tsv` | 按所匹配 DID 的 `dids.country_code` 补全（D31、D32）；补 `86` 只是大陆线路上的结果。呼出必须先匹配主叫 DID 才能规范化被叫 |

### 2.2 要改的文档

| 文件                                                | 位置                                                                                                                                                                                                                  | 改什么                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `docs/inbound-cdr-design.md`                        | 文件头                                                                                                                                                                                                                | 标注「已被 did-inbound-design.md 取代」，保留作历史                                                                     |
| `docs/design.md`                                    | §4.1 租户标签、§4.2 授权（判断逻辑、超时、第 174 行）、§5、§6.1–6.4、§7.2 流水类型、§7.7 统计口径、§9 月账单、§14 第 4 行、§16                                                                                        | 授权加 DID 步骤和呼入；新增流水类型；月账单算式加号码费用；费率按线路和类别；客户可见当前费率                           |
| `docs/worker-api.md`                                | `POST /authorize` 段、`POST /cdr` 段、新增 `GET /fs/did-map`                                                                                                                                                          | 请求和响应加字段，SIP 码加 480                                                                                          |
| `docs/freeswitch.md`                                | §3.1 拒绝码表、§3.2 话单字段表、§4 租户配置表                                                                                                                                                                         | 加 480；话单加 `billing_did`、`billing_line`；租户配置加「租户到 PBX 的目标」「呼入并发上限」                           |
| `freeswitch/README.md`                              | 「线路和来电」「安装授权脚本与拨号计划」「测试机验收」                                                                                                                                                                | 呼入授权、号码表同步脚本、验收项                                                                                        |
| 号码规则相关                                        | `docs/design.md` §4.2（号码规则段、示例表）；`docs/freeswitch.md` §3.3；`docs/worker-api.md` `POST /authorize` 的号码段；`docs/phase-3-worker.md` 第 64 行；`freeswitch/README.md` 「安装授权脚本与拨号计划」的号码段 | 无冠字号码按 DID 的国家码补全；授权顺序（先主叫 DID，后被叫规范化）；`callee`、`billingNumber` 变为可选投影；非大陆示例 |
| `docs/pages.md`                                     | 1.3 状态标签、2.2 首页、2.3 话单、2.4–2.5 账单、2.6 流水、3.5 租户详情标签、3.6 费率表、第 115 行；新增线路、号码、前缀国家、待核对页；门户新增「号码」页（含当前费率，没有单独的费率页）                             | 见 [7](#7-api-和页面)                                                                                                   |
| `docs/rate-list-design.md`                          | D2、§5.1–5.6                                                                                                                                                                                                          | 表头改六列；标注被本文取代的部分                                                                                        |
| `docs/phase-5-design.md`                            | 第 155 行、第 264 行（停用确认文案）                                                                                                                                                                                  | 「停用后所有来电也被拒绝」                                                                                              |
| `docs/phase-9-design.md`                            | 决定 25（余额通知不抄送管理员）                                                                                                                                                                                       | 加注：号码月租通知目前只发管理员，与余额通知的收件人规则不同                                                            |
| `packages/shared/src/mail/templates.ts`             | `balance_suspended`（第 288 行附近）正文                                                                                                                                                                              | 「新的呼叫将被拒绝」改为「新的呼出和收费来电被拒绝，免费来电不受影响」；中英文同时改（PR 6）                            |
| `docs/design.md` §2.2、`docs/pages.md` 第 20、37 行 | 「多语言（只用中文）」「界面语言为简体中文」                                                                                                                                                                          | 见 i18n 文档 I9                                                                                                         |
| `docs/go-live-checklist.md`                         | 新增条目                                                                                                                                                                                                              | 号码表同步、DID 与 FS 一致性核对、月租任务演练                                                                          |
| `docs/plan.md`                                      | 阶段表                                                                                                                                                                                                                | 新增阶段「DID 与呼入计费」                                                                                              |

## 3. 数据模型

迁移编号按合并顺序排在 i18n 批的迁移之后（现在最新是 `0027_cdr_direction.sql`）。测试库可重置（D24），所以迁移不做历史回填，直接加 `NOT NULL`。下表中的「新」表都启用 RLS，授权给 `fs_billing_app`，模式同 `0017_monthly_statements.sql`。

### 3.1 总览

| 表                              | 性质 | 要点                                                                                                                                                                                                  |
| ------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lines`                         | 新   | 线路：`code` 同时是 FreeSWITCH 网关名；`name_en`（英文名）；`caller_number_format`（默认 `domestic_when_unprefixed`，见 [5.1](#51-号码规范化)）。线路本身没有国家码，一条线路可以同时有多个国家的 DID |
| `prefix_countries`              | 新   | 全局「号码前缀 → 国家」，可编辑；带 `country_en`                                                                                                                                                      |
| `dids`                          | 新   | 号码本身：规范号码、`country_code`（必填，号码必须以它开头）、线路、类型、国家、`country_en`。号码、`country_code`、线路、类型创建后不可改                                                            |
| `did_assignments`               | 新   | 归属历史与套餐条款：租户、生效区间、开通费、月租、含分钟数。只增，只能给 `effective_to` 赋值一次                                                                                                      |
| `did_term_changes`              | 新   | 套餐条款的变更，只能从下月 1 日生效（[3.2](#32-新表的关键约束)）                                                                                                                                      |
| `rate_versions`                 | 改   | 加 `line_id`、`category`，版本按（租户、线路、类别）独立                                                                                                                                              |
| `rate_entries`                  | 改   | 加 `billing_cycle`；英文列 `country_en`、`description_en` 已由 i18n 批 I7 加好                                                                                                                        |
| `did_fee_charges`               | 新   | 开通费、月租的应收记录，与流水一一对应                                                                                                                                                                |
| `did_allowances`                | 新   | 每个归属每月的含分钟额度（秒）                                                                                                                                                                        |
| `did_suspensions`               | 新   | 租户因欠月租停机的历史，有开口记录即停机                                                                                                                                                              |
| `cdr_review_items`              | 新   | 未验证话单事后核对的待办                                                                                                                                                                              |
| `cdrs`                          | 改   | DID、线路、类别、周期、抵扣等快照列；英文快照列 `country_en`、`description_en` 已由 i18n 批 I7 加好，本批入库时对呼入也写入                                                                           |
| `ledger_entries`                | 改   | 加两种流水类型                                                                                                                                                                                        |
| `monthly_statements` 及明细     | 改   | 加号码费用、呼入列；国家明细加方向；新增按 DID、按方向两张明细。国家明细的 `country_en` 已由 i18n 批 I7 加好；新增的两张明细不需要英文列                                                              |
| `system_alerts`、`email_outbox` | 改   | 各加一个枚举值                                                                                                                                                                                        |

### 3.2 新表的关键约束

```sql
CREATE TABLE lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,31}$'),   -- 即 FreeSWITCH 网关名
  name text NOT NULL CHECK (btrim(name) <> ''),                        -- 对客户可见（门户费率页显示）
  name_en text NOT NULL DEFAULT '',                                     -- 英文名（客户可见）；空则英文界面回落 name
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  caller_number_format text NOT NULL DEFAULT 'domestic_when_unprefixed'   -- D32；international_digits 见 5.1
    CHECK (caller_number_format IN ('domestic_when_unprefixed','international_digits')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prefix_countries (
  prefix text PRIMARY KEY CHECK (prefix ~ '^[0-9]+$' AND prefix !~ '^00'),
  iso text NOT NULL DEFAULT '' CHECK (iso = '' OR iso ~ '^[A-Z]{2}$'),
  country text NOT NULL CHECK (btrim(country) <> ''),
  country_en text NOT NULL CHECK (btrim(country_en) <> ''),             -- 英文名；有 ISO 的行默认取 ISO 标准英文名（i18n 文档 11.2）
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE CHECK (number ~ '^[1-9][0-9]{5,14}$'),   -- 规范号码，与 cdrs.billing_number 同格式
  country_code text NOT NULL CHECK (country_code ~ '^[1-9][0-9]{0,2}$'),   -- 本号码国内格式补全用，如 44、86、1
  line_id uuid NOT NULL REFERENCES lines,
  type text NOT NULL CHECK (type IN ('normal','toll_free')),
  country text NOT NULL CHECK (btrim(country) <> ''),
  country_en text NOT NULL DEFAULT '',                                     -- 英文名，规则同 rate_entries.country_en（i18n 文档 11.2）
  iso text NOT NULL DEFAULT '' CHECK (iso = '' OR iso ~ '^[A-Z]{2}$'),
  remark text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (number LIKE country_code || '%')                                  -- 号码必须以国家码开头
);
-- 触发器 dids_freeze：line_id、number、country_code、type 创建后不可改（同 tenants_freeze_identity 的写法）。

CREATE TABLE did_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  did_id uuid NOT NULL REFERENCES dids,
  tenant_id uuid NOT NULL REFERENCES tenants,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  activation_fee numeric NOT NULL CHECK (activation_fee >= 0 AND scale(activation_fee) <= 4),
  monthly_fee numeric NOT NULL CHECK (monthly_fee >= 0 AND scale(monthly_fee) <= 4),
  included_minutes integer NOT NULL CHECK (included_minutes >= 0),
  created_by uuid NOT NULL REFERENCES admins,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX did_assignments_open ON did_assignments (did_id) WHERE effective_to IS NULL;
```

- **归属不重叠。** 不用排他约束（需要 `btree_gist`，仓库没用过，未核对 Debian 包是否带）。改用「每个 DID 至多一条开口记录」的局部唯一索引，加 `did_assignments_guard` 触发器（风格同 `rate_versions_guard`）：新记录的 `effective_from` 不得早于同一 DID 上一条的 `effective_to`；UPDATE 只允许把 `effective_to` 从 NULL 改为不早于 `now()` 的值；其他列和 DELETE 一律拒绝。换租户 = 在一个事务里关闭旧记录并插入新记录，两个租户的锁用一次 `lockTenants` 拿齐（`lock_tenants`，`0000_init.sql`：同一事务的多个租户必须在一次调用里加锁，否则报 `object_not_in_prerequisite_state`）。
- **开通条款与条款变更。** `activation_fee`、`monthly_fee`、`included_minutes` 随归属记录固定，开通费永不变。月租和含分钟数可以变更，但**只能从下月 1 日起生效**：往 `did_term_changes(id, assignment_id, tenant_id, effective_month date, monthly_fee, included_minutes, created_by, created_at)` 追加一行（`effective_month` 必须是下月 1 日或更晚、不超过 12 个月后；`(assignment_id, effective_month)` 唯一；只增，生效月份开始之前允许删除以取消）。某月的条款 = `effective_month <= 该月` 的最后一条变更，没有则用归属记录本身（函数 `termsFor(assignment, month)`）。已生成的 `did_fee_charges` 和 `did_allowances` 行保存了当时的金额和额度，所以当月不会重复收费、不重复发额度，历史月份也不受影响。换租户仍是新建归属并重新收开通费（D26）。
- **生效归属。** 授权、入库、号码表导出判断「这个号码现在属于谁」都用同一个定义：`effective_from <= 时刻 < coalesce(effective_to, ∞)` **并且**开通单元已付清（[6.1](#61-任务与流水)）。PR 2 先建视图 `did_active_assignments`（只有区间条件，此时还没有费用），PR 6 重建视图加上付清条件。
- **费率版本按范围独立。**

```sql
ALTER TABLE rate_versions
  ADD COLUMN line_id uuid NOT NULL REFERENCES lines,
  ADD COLUMN category text NOT NULL CHECK (category IN ('outbound','inbound','toll_free')),
  DROP CONSTRAINT rate_versions_tenant_effective_from_key,
  ADD CONSTRAINT rate_versions_scope_effective_from_key UNIQUE (tenant_id, line_id, category, effective_from);
ALTER TABLE rate_entries
  ADD COLUMN billing_cycle text NOT NULL CHECK (billing_cycle IN ('60/60','1/1'));
```

`rate_versions_guard`（`0000_init.sql`）里的 `max(effective_from)` 和「已排定未来版本」判断按（租户、线路、类别）取，其余不变。`design.md` §6.3 的「同一租户同一时间最多一个排定版本」随之变成「同一范围」。

```sql
CREATE TABLE did_fee_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  assignment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('activation','monthly')),
  month date NOT NULL CHECK (extract(day FROM month) = 1),            -- 费用所属北京月
  amount numeric NOT NULL CHECK (amount >= 0),
  prorated_days integer,                                               -- 开通当月的计费天数，其余为 NULL
  status text NOT NULL CHECK (status IN ('due','paid')),
  ledger_entry_id uuid UNIQUE REFERENCES ledger_entries,
  due_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  FOREIGN KEY (assignment_id, tenant_id) REFERENCES did_assignments (id, tenant_id),
  UNIQUE (assignment_id, kind, month),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  -- 金额为 0 的应收创建时直接置 paid，不写流水（流水金额必须为负）；金额 > 0 的 paid 行必有流水
  CHECK ((ledger_entry_id IS NOT NULL) = (status = 'paid' AND amount > 0))
);
CREATE TABLE did_allowances (
  assignment_id uuid NOT NULL, tenant_id uuid NOT NULL,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  granted_seconds integer NOT NULL CHECK (granted_seconds >= 0),
  used_seconds integer NOT NULL DEFAULT 0 CHECK (used_seconds >= 0 AND used_seconds <= granted_seconds),
  PRIMARY KEY (assignment_id, month),
  FOREIGN KEY (assignment_id, tenant_id) REFERENCES did_assignments (id, tenant_id)
);
CREATE TABLE did_suspensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  suspended_at timestamptz NOT NULL DEFAULT now(),
  resumed_at timestamptz CHECK (resumed_at IS NULL OR resumed_at >= suspended_at),
  outstanding numeric NOT NULL CHECK (outstanding > 0)                 -- 停机时的欠费合计，仅作记录
);
CREATE UNIQUE INDEX did_suspensions_open ON did_suspensions (tenant_id) WHERE resumed_at IS NULL;
```

- 开通费或月租为 0 时，应收行仍然创建（保证 `(assignment_id, kind, month)` 幂等和额度行同步创建），但创建时即置 `paid`、没有流水。
- `did_allowances.granted_seconds` 创建后不可改，`used_seconds` 只能增加（触发器）。核对视图 `did_allowance_discrepancies`：`used_seconds` 必须等于该归属该月 `cdrs.included_seconds` 之和（做法同 `balance_discrepancies`）。
- `did_suspensions` 是历史表：授权判断停机 = 存在开口记录；事后核对「通话时是否停机」查 `suspended_at <= started_at < coalesce(resumed_at, 'infinity')`。
- `cdr_review_items(id, tenant_id, call_uuid, started_at, reason text, status 'pending'|'resolved', resolved_by, resolved_at, note)`，`(call_uuid)` 唯一。`reason` 取值见 [5.5](#55-未验证话单的事后处理)。

### 3.3 `cdrs` 的快照列

| 列                                      | 类型                                          | 说明                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `did_id`                                | `uuid REFERENCES dids`，可空                  | 归属判定出的 DID；未接通且没有 DID（被授权拒绝）的话单为空                                                                                                                                                                                                                                                                                          |
| `did_number`                            | `text`，可空                                  | 规范号码快照。DID 表以后不会删，但快照让话单自洽                                                                                                                                                                                                                                                                                                    |
| `billing_number`                        | 沿用，**改为可空**                            | 规范化后的号码（呼出：被叫；呼入：DID）。主叫没匹配到 DID 时被叫无法规范化（需要 DID 的国家码），此时为空，只可能出现在未接通、被授权拒绝的话单上（迁移 `billing_number_nullable` 的约束 `billing_number IS NOT NULL OR answered_at IS NULL`，迁移 `cdr_did_snapshot` 收紧为 `OR did_id IS NULL AND answered_at IS NULL`）；`callee` 仍保存原始拨号 |
| `line_id`、`line_code`                  | `uuid`、`text`，可空                          | 线路快照                                                                                                                                                                                                                                                                                                                                            |
| `assignment_id`                         | `uuid`，可空                                  | 通话开始时的归属记录，含套餐条款来源                                                                                                                                                                                                                                                                                                                |
| `rate_category`                         | `text` `outbound / inbound / toll_free`，可空 | 实际使用的费率类别                                                                                                                                                                                                                                                                                                                                  |
| `rate_version_id`                       | `uuid`，可空                                  | 接通时生效的费率版本                                                                                                                                                                                                                                                                                                                                |
| `billing_cycle`                         | `text` `60/60 / 1/1`，可空                    | 费率行的周期快照                                                                                                                                                                                                                                                                                                                                    |
| `billed_seconds`                        | `integer NOT NULL DEFAULT 0`                  | 周期取整后的计费秒数，**计费的唯一依据**                                                                                                                                                                                                                                                                                                            |
| `included_seconds`                      | `integer NOT NULL DEFAULT 0`                  | 被含分钟数抵扣的秒数，`<= billed_seconds`                                                                                                                                                                                                                                                                                                           |
| `billed_minutes`                        | 沿用                                          | 改为 `billed_seconds / 60` 四舍五入到 4 位，仅作展示和旧导出兼容；汇总用 `sum(billed_seconds) / 60`                                                                                                                                                                                                                                                 |
| `caller_billing_number`                 | `text`，可空                                  | 规范化后的主叫（呼入）；隐藏或无法识别为空                                                                                                                                                                                                                                                                                                          |
| `country`、`iso`                        | 沿用                                          | 呼出：费率行的国家（同现状）；呼入：主叫国家（来自 `prefix_countries`），无法判定记「未知」                                                                                                                                                                                                                                                         |
| `matched_prefix`、`rate`、`description` | 沿用                                          | 呼入普通：DID 前缀行；toll free：主叫前缀行；呼出：被叫前缀行                                                                                                                                                                                                                                                                                       |
| `charge`                                | 沿用                                          | `(billed_seconds - included_seconds) × rate / 60`，四舍五入到 6 位（[5.3](#53-含分钟数抵扣与金额精度)）                                                                                                                                                                                                                                             |

英文快照：`country_en`、`description_en` 由 i18n 批 I7 加好；本批入库时对呼入也写入——呼入的 `country_en` 取 `prefix_countries.country_en`，隐藏或无法识别时写 `Unknown`（与 `country` 的哨兵「未知」配对）。`cdrs_answered_shape`（`0027_cdr_direction.sql` 重建过）重写为：未接通 = 时长、`billed_seconds`、`included_seconds`、`charge` 全 0；已接通 = `did_id`、`line_id`、`rate_category`、`matched_prefix`、`rate`、`billing_cycle` 全非空，`included_seconds <= billed_seconds`，且仍有 `answered_at BETWEEN started_at AND ended_at`。呼入的「分钟和费用必须为 0」两条取消；`packages/shared/src/api/cdr-fields.ts` 的 `checkCdrShape` 同步改（该文件第 139–153 行）。新增索引 `(tenant_id, did_id, answered_at)` 支持按 DID 筛选。`unassigned_cdrs_billing_number_reason_check`（`0004`）里「`billing_number` 为空当且仅当原因是号码格式错误或话单校验失败」扩展为也包含新原因「DID 未登记」（无法规范化号码）。

### 3.4 其他表的改动

- `ledger_entries`：`kind` 的 CHECK 加 `did_activation_fee`、`did_monthly_fee`；`ledger_entries_kind_shape` 里这两种与 `call_charge` 同形（`amount < 0 AND created_by IS NULL`）。`packages/db/src/schema.ts` 的 `ledgerKinds`、`packages/db/src/ledger.ts` 的 `LedgerEntryInput` 加对应分支，系统生成的流水需要 `occurredAt`。金额为 0 的费用不写流水（上条 `kind_shape` 要求金额为负，写 0 会违反约束）。写流水仍必须经 `appendLedgerEntry` / `appendLedgerEntries`（`tooling/eslint/guardrails.ts` 的 `ledgerRestrictedSyntax` 会拒绝直接插入）。
- `monthly_statements`：见 [8](#8-账单)。
- `system_alerts_kind_check` 加 `did_suspended`、`did_noncompliant`、`did_activation_failed`、`did_suspension_long`；`schema.ts` 的 `systemAlertKinds` 同步。`email_outbox.template` 的 CHECK（`0021_email_outbox.sql` 内联约束，约束名是 PG 默认名，未核对）加 `did_fee_notice`；`schema.ts` 的 `emailTemplates` 和 `packages/shared/src/mail/templates.ts` 同步。
- `tenants`、`rate_versions` 之外的现有表不动。

### 3.5 RLS 与权限

| 表                                                                                                                | 策略                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `did_assignments`、`did_term_changes`、`did_fee_charges`、`did_allowances`、`did_suspensions`、`cdr_review_items` | 有 `tenant_id`，套用 0000 的 DO 块：`tenant_read` 用 `app_can_see(tenant_id)`，写入仅 operator（admin 或 system）                                                                       |
| `dids`                                                                                                            | 租户只读自己有归属记录的 DID：`EXISTS (SELECT 1 FROM did_assignments a WHERE a.did_id = dids.id AND a.tenant_id = (SELECT app_tenant_id()))`，写入仅 operator。用 0015 的 InitPlan 写法 |
| `lines`                                                                                                           | 租户只读自己有 DID 或费率版本的线路（同上思路）；写入仅 operator                                                                                                                        |
| `prefix_countries`                                                                                                | 任何已声明身份的会话可读（`app_scope() IS NOT NULL`），写入仅 admin；每次修改记 `operation_logs`                                                                                        |
| `rate_versions`、`rate_entries`                                                                                   | 不变（已有 `tenant_read`）                                                                                                                                                              |

必须扩展 `packages/db/src/rls.db.test.ts` 和 `apps/api/src/idor.db.test.ts`：A 租户看不到 B 的归属、费用、额度、停机记录；租户身份不能写任何新表。`GRANT` 给 `fs_billing_app`：新表 `SELECT, INSERT`，`did_assignments`、`did_allowances` 另加 `UPDATE`，`lines`、`dids`、`prefix_countries` 加 `UPDATE`。

### 3.6 迁移与重置

- 原则：**纯新增的表在 PR 1 一次建好（没有现有代码引用，main 行为不变）；任何会改变现有行为的迁移（`NOT NULL` 列、约束重建、枚举扩展、主键变更）与用到它的代码放在同一个 PR**，保证每个 PR 合并后 `pnpm check` 都通过。迁移编号取开工时 `origin/main` 的下一个，并排在 i18n 批的迁移（i18n 文档的 I3、I7、I8）之后；下表只写名字和顺序，不写编号：

| 迁移                            | PR  | 内容                                                                                                                                                                             |
| ------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*_lines_dids.sql`              | 1   | 新表：`lines`、`prefix_countries`、`dids`、`did_assignments`、`did_term_changes`、`did_fee_charges`、`did_allowances`、`did_suspensions`、`cdr_review_items`，触发器、RLS、授权  |
| `*_rate_scopes.sql`             | 3   | `rate_versions.line_id`/`category`、`rate_entries.billing_cycle`、唯一约束、`rate_versions_guard`                                                                                |
| `*_billing_number_nullable.sql` | 4   | `cdrs.billing_number` 可空与约束、`unassigned_cdrs` 的 `billing_number` 约束扩展（号码规则切换需要，见 9）                                                                       |
| `*_cdr_did_snapshot.sql`        | 5   | `cdrs` 快照列与 `cdrs_answered_shape`、`system_alerts` 加 `did_noncompliant`                                                                                                     |
| `*_did_fees.sql`                | 6   | `ledger_entries` 新类型与 `kind_shape`、`system_alerts` 加 `did_suspended` / `did_activation_failed` / `did_suspension_long`、`email_outbox` 模板、`did_active_assignments` 重建 |
| `*_statement_did.sql`           | 8   | 月账单列、主键、三张明细                                                                                                                                                         |

- 每个迁移开头 `SET LOCAL lock_timeout = '5s'`，分句用 `--> statement-breakpoint`，格式同 `0027_cdr_direction.sql`。
- 不回填：`NOT NULL` 列在已有数据的库上会失败，迁移前加预检（模式同 `0004_billing_number_not_null.sql` 的 `reset the dev database` 异常）。测试库按 D24 在 PR 3 合并时重置一次。种子（`packages/db/src/seed.ts`）随 PR 3、PR 5 逐步补：线路、DID、三类费率，保证验收数字可复现。
- `packages/db/src/migrate.db.test.ts` 会核对 `schema.ts` 与迁移的列名一致，`schema.ts` 随各迁移同步更新。

## 4. 授权流程

### 4.1 契约变化（`POST /authorize`）

`packages/shared/src/worker.ts` 的 `authorizeRequestSchema` / `authorizeResponseSchema` 改为：

| 字段                       | 方向 | 说明                                                                                                                                                                                               |
| -------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direction`                | 请求 | `outbound` / `inbound`，缺失按 `outbound`（兼容旧脚本；旧脚本因没有 `caller` 会被拒，见 [9](#9-pr-拆分与顺序) 上线顺序）                                                                           |
| `caller`                   | 请求 | 原始主叫（`caller_id_number`）。呼出必填；呼入可为空串                                                                                                                                             |
| `dialedNumber`             | 请求 | 必填：原始拨号（呼出）或原始被叫（呼入）                                                                                                                                                           |
| `callee` / `billingNumber` | 请求 | **可选**的规范化投影。Lua 只有在本地号码表里匹配到主叫 DID（得到该 DID 的 `country_code`）时才带；Worker 用数据库里 DID 的国家码重新计算并核验，不一致返回 HTTP 400 `授权计费号码不一致`。不再必填 |
| `line`                     | 请求 | 呼入必填：FreeSWITCH 来电入口（每条线路一个 profile 和 context）设置的线路 `code`；Worker 核验线路存在、启用，且被叫 DID 属于该线路                                                                |
| `tenant`                   | 请求 | 来自本地号码表或拨号计划的租户编码，Worker 只用它与数据库交叉核对                                                                                                                                  |
| `line`、`did`              | 响应 | 放行时返回：线路 `code`、规范 DID                                                                                                                                                                  |
| `tenant`                   | 响应 | 呼入放行时返回数据库判定的租户编码，FreeSWITCH 以此设置 `billing_tenant`                                                                                                                           |
| `maxSeconds`               | 响应 | 呼出：见 4.2；呼入：恒为 14400                                                                                                                                                                     |
| `sipCode`                  | 响应 | 联合类型在 403/404/402/484 之外加 **480**；Lua 的 `sip_codes` 表（`billing_authorize.lua` 第 12 行）同步加                                                                                         |

### 4.2 呼出：决策顺序

1. 路由号码语法：`dialedNumber` 符合 `^\+?[0-9]{1,17}$`（只做语法检查，不规范化、不访问数据库），否则 484。
2. 租户不存在 → 404；租户已停用 → 403。
3. **主叫 DID**：按 [5.1](#51-号码规范化) 的呼出范围规则，把 `caller` 与该租户当前**生效归属**（定义见 [3.2](#32-新表的关键约束)）的 DID 匹配，得到线路和**该 DID 的 `country_code`**。不匹配 → 403「主叫号码未登记」（新 `RejectReason`）；匹配到多个不同 DID（歧义）→ 403 并开告警。此时被叫还没有规范化，也无法规范化。
4. **被叫规范化**：`resolveBillingNumber({ dialedNumber, countryCode, callee?, billingNumber? })`，用主叫 DID 的 `country_code`（D31）。结果不是 6–15 位数字 → 484「号码格式错误」；与 Lua 传来的投影不一致 → HTTP 400 `授权计费号码不一致`（Lua 返回 SIP 503，其余同现状）。这一步现在要读数据库（只读，不写、不加锁），`design.md` §4.2 里「此路径不访问数据库」的说法随之改。
5. **欠月租停机**（存在 `did_suspensions` 开口记录）→ 402。
6. 费率：取该 DID 所属线路、该租户、`outbound` 类别、`now()` 生效版本，对被叫的 `billing_number` 做最长前缀匹配。没有 → 404「无费率」。
7. 额度：可用金额 = 余额 + 透支额度。`含分钟剩余秒数 = allowanceRemaining(归属, 当前北京月)`；`金额可打秒数 = max(0, floor(可用金额 / 费率)) × 60`——可用金额为负时取 0，**不能**让负数抵消含分钟剩余。`可打秒数 = 含分钟剩余秒数 + 金额可打秒数`（费率为 0 时不看余额也不用额度，直接 14400）。`<= 0` → 402「余额不足」。

   `allowanceRemaining`：额度行存在则取 `granted_seconds - used_seconds`；**不存在**（月初 00:00–00:05 `did-fees` 还没跑，或之后月份的额度行尚未创建）时按条款现算：`termsFor(归属, 当月).included_minutes × 60`，已用按 0，**只读不写库**。开通当月的额度行在开通单元付清时已创建，所以不会缺。这样月初几分钟内余额为零但含分钟未用完的租户不会被误拒；入库时的创建见 S28。

8. 放行：`maxSeconds = min(可打秒数, 14400)`，返回 `line`、`did`、`billingNumber`。

超时（1.5 秒）：Lua 用本地号码表（[4.5](#45-did-与-freeswitch-路由如何保持一致)）校验：主叫按 [5.1](#51-号码规范化) 规则匹配到的 DID **必须属于当前 `billing_tenant`**，且表里的归属区间包含现在。查不到、属于别的租户、或歧义 → 403，**不放行**，否则租户能在超时期间冒用别人的 DID。通过则用该 DID 的 `cc`（号码表每条都带）在本地规范化被叫，格式不合法 → 484；合法则按该 DID 的线路放行 1800 秒，设 `billing_unverified=true`，并把本地算出的 `billing_number` 随话单送出，Worker 入库时仍按数据库重新计算并核验。主叫 DID 是准入条件，不能因为计费系统故障而放过。

`packages/rating/src/authorize.ts` 的 `authorize` / `callableMinutes` 改成接收「线路费率表 + 额度剩余秒数」。`callableMinutes` 现在对 `available <= 0` 先返回 0，再判断费率 0，所以**零费率呼出在余额耗尽时今天被拒**；本设计改为零费率不看余额（见 [10](#10-矛盾与风险) 第 4 项）。

### 4.3 呼入：决策顺序

呼入由新的拨号计划入口调用同一个 Lua 授权脚本（`direction=inbound`）。线路由来电入口确定：每条线路一个 sofia profile 和 context（`freeswitch/README.md`「线路和来电」已要求线路独立 profile），context 里设置 `billing_line`，授权请求带上 `line`。被叫 DID 的匹配按 [5.1](#51-号码规范化) 的呼入范围规则，只在**该线路**的 DID 里找；每个候选用 DID 自己的 `country_code`，同一线路上有多个国家的 DID 时可能出现歧义（下表第 1 步）。

| 步  | 判断                                                                                                                                                        | 结果                                                                                        | SIP |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --- |
| 1   | 被叫在该线路上没有当前生效归属的 DID（含线路不存在或已停用），或匹配到该线路上**多个不同** DID（歧义，5.1）                                                 | 拒绝，不产生话单（`process_cdr=false`）；歧义时开 `did_noncompliant` 告警（配置问题，不猜） | 404 |
| 2   | 数据库判定的租户与本地号码表或拨号计划给的租户不一致                                                                                                        | 拒绝，开 `did_noncompliant` 告警                                                            | 404 |
| 3   | 租户已停用（D9）                                                                                                                                            | 拒绝                                                                                        | 403 |
| 4   | 租户欠月租停机                                                                                                                                              | 拒绝（免费 DID 也拒，D19）                                                                  | 480 |
| 5   | 找费率：`normal` 类型用 DID 的规范号码在 `inbound` 类别里最长前缀匹配；`toll_free` 类型用主叫在 `toll_free` 类别里匹配                                      | —                                                                                           | —   |
| 5a  | `toll_free` 类型的 DID，主叫隐藏（D7），或主叫可识别但 `toll_free` 费率表里没有匹配的前缀行（都算「无法识别」）                                             | 拒绝；**不告警**（问题在来电方，不是配置缺失）                                              | 403 |
| 5b  | **普通类型**的 DID 在 `inbound` 费率表里没有匹配行（只用于普通 DID）                                                                                        | 拒绝，开告警（配置缺失，S7）                                                                | 480 |
| 6   | 费率 > 0 且 `含分钟剩余秒数 + max(0, floor(可用金额/费率)) × 60 <= 0`（D8；剩余秒数取法同 4.2 第 6 步，额度行缺失时按条款现算，可用金额为负时金额部分取 0） | 拒绝                                                                                        | 480 |
| 7   | 其余                                                                                                                                                        | 放行，`maxSeconds = 14400`（D10），返回租户编码、线路、DID                                  | —   |

- 费率为 0 的 DID 不检查余额（D8、D5）。`toll_free` **类型**的 DID 即使所有行都是 0，主叫隐藏时也拒绝（按类型而不是按费率值判断，见 [10](#10-矛盾与风险) 第 5 项）。
- 拒绝时 Lua 仍生成 A 腿话单（未接通，`hangup_cause=CALL_REJECTED`），除第 1 步外。话单随后按 [5.4](#54-入库顺序) 入库，`did_id` 已知。
- 超时：用本地号码表路由，号码表按来电入口的线路查；该线路上没有这个号码 → 404；租户取自号码表，不取自拨号计划。其余放行 1800 秒并标记未验证。呼入通话中额度用完不挂断，所以只有 14400 秒（正常）或 1800 秒（未验证）的上限。
- 呼入只进客户 PBX（D11）：目标由 FreeSWITCH 上「租户 → PBX 目标」的配置决定，不是数据库字段，也不再按号码配置。

### 4.4 FreeSWITCH 脚本与拨号计划的改动

| 文件                                            | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freeswitch/scripts/billing_authorize.lua`      | 请求加 `direction`、`caller`、`tenant`；响应读 `line`、`did`、`tenant`；`sip_codes` 加 480；放行后设 `billing_line`（校验 `^[a-z][a-z0-9_]{1,31}$`）、`billing_did`、`billing_direction`、`billing_tenant`；超时回退读本地号码表；`allow()` 对呼入同样设 `billing_unverified`。**号码**：请求前只做路由语法检查（`^\+?[0-9]{1,17}$`，非法 484）；原来约第 42–50 行硬编码 `'86' ..` 的计费号码投影，改为用号码表里匹配到的 DID 的 `cc` 计算（`toCanonical`），匹配不到就不带投影，由 Worker 判定 |
| `freeswitch/dialplan/billing.xml`               | `bridge` 从 `sofia/gateway/upstream/${billing_destination}` 改为 `sofia/gateway/${billing_line}/${billing_destination}`；`billing_line` 为空则 503                                                                                                                                                                                                                                                                                                                                              |
| `freeswitch/dialplan/trunk-inbound.xml.example` | 去掉按号码写死的 extension。每条线路一个 context，各设 `billing_line=<线路 code>`，再设 `billing_direction=inbound`、`billing_dialed_number=${destination_number}`、执行 Lua，然后 `execute_extension` 到 `inbound-authorized`（同 outbound 的两段式，原因同：XML 条件在 Lua 执行前求值）                                                                                                                                                                                                       |
| 新增 `inbound-authorized` context               | 每个租户一个 extension，按 `${billing_tenant}` 选 PBX 目标并桥接，沿用现有 `sip_invite_to_uri` 做法；呼入并发上限 `limit hash inbound ${billing_tenant} ${billing_inbound_concurrency}`                                                                                                                                                                                                                                                                                                         |
| `packages/shared/src/worker.ts`                 | `modJsonCdrSchema` 的 `variables` 加 `billing_did`、`billing_line`（可选）；话单必填字段不变                                                                                                                                                                                                                                                                                                                                                                                                    |
| `docs/freeswitch.md` §3.2 话单字段表            | 加两个字段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

话单里的 `billing_did`、`billing_line` 与现有的 `billing_number` 一样只是投影：Worker 在入库时重新判定并核验，不一致则停放，不信任交换机（[5.4](#54-入库顺序)）。

### 4.5 DID 与 FreeSWITCH 路由如何保持一致

问题：数据库有 DID 表，FreeSWITCH 也要能路由；授权超时放行时 Worker 不可用，所以 FreeSWITCH 必须有自己的一份。

| 方案                                             | 做法                                                                                                                   | 优点                                                       | 缺点                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A 两边手工维护                                   | Frank 改数据库，运维改拨号计划（现状）                                                                                 | 不改架构                                                   | 必然漂移；换租户、退号时两边不同步会让话单算给错的租户。只靠授权交叉核对兜底 |
| B 只信数据库，FreeSWITCH 实时查                  | 每通来电都问 Worker 号码属于谁                                                                                         | 一致性最强                                                 | Worker 故障时无法路由，放行（D12）做不到；呼出的线路也无法确定               |
| C 数据库导出，FreeSWITCH 主动拉取 + 授权交叉核对 | Worker 提供 `GET /fs/did-map`；服务器 A 上的定时脚本每 60 秒拉取，原子替换 `did_map.lua`；授权时 Worker 再与数据库核对 | 数据库是唯一来源；故障时仍能路由；不放宽 A 与 B 的信任方向 | 新增一个同步脚本和一份本地文件；生效有最多约 1 分钟延迟                      |
| D 从数据库生成 XML 拨号计划并 `reloadxml`        | 同 C，但产出 XML                                                                                                       | 路由全在 XML                                               | `reloadxml` 影响全局；每次同步都要重载；比 C 的收益小                        |

**推荐 C。** 理由：（1）归属以数据库为准，换租户不会漂移；（2）Worker 故障时 Lua 读本地表，符合 D12；（3）由 A 拉取，服务器 B 不能推送配置到交换机，保持 `design.md` §3.1 的「B 被攻破也无法控制交换机」；（4）授权每次交叉核对，同步滞后只会造成拒绝，不会造成算错租户。

细节：

- `GET /fs/did-map`（Worker，同 `/authorize` 的 IP 白名单和 `X-Billing-Key`）返回 `{ generatedAt, version, dids: [{ number, tenant, line, cc, type, from, to }] }`，`cc` 是 DID 的 `country_code`（Lua 回退匹配要用）；只含**生效归属**（开通单元已付清）当前有效和未来 24 小时内将生效的记录；`version` 是内容哈希。
- 脚本在服务器 A 上由 systemd timer 运行：下载到临时文件，校验 JSON 与 `version`，`mv` 原子替换；失败保留旧文件。租户到 PBX 目标的映射**不**由数据库导出，仍是 FreeSWITCH 上的一次性配置（与 `billing_tenant`、`billing_concurrency` 同属开户步骤）。
- 新增一次心跳：脚本每次成功后向 `/clock` 同类的接口报告 `version`；Worker 超过 10 分钟没收到就开 `fs_heartbeat` 同类告警（`fs_heartbeat` 现有实现在 `apps/worker/src/clock.ts`，新告警的键和是否复用该 kind 在 PR 4 里定，**未核对**能否直接复用）。
- 授权时 Worker 用数据库判定；与 Lua 传来的 `tenant` 不一致就拒绝并告警（4.3 第 2 步）。所以最坏情况是新号码在同步前拒接（404），或旧归属在同步前被拒（404），不会静默算错。
- 每次修改线路、DID、归属后，后台提示「约 1 分钟后在交换机生效」。

## 5. 话单入库与计费

### 5.1 号码规范化

DID 以 `^[1-9][0-9]{5,14}$` 的国家码数字串存储（与 `billing_number` 同格式，`packages/rating/src/dialed.ts` 的 `parseDialedNumber`）。

**为什么不能固定补 `86`。** 现有 `normalizeDialedNumber` 把没有国际冠字的号码一律当大陆号码补 `86`（`design.md` §4.2）。这批需求的前提是多国线路：英国线路送来的国内格式被叫 `02079460000` 会变成 `862079460000`，匹配不到 DID，所有来电都被拒；英国主叫 `07700900123` 会被补成 `86…`；美国 DID 的客户拨 `3055551234` 会被当成大陆号码。用户的决定是「号码是美国的就打美国本地」（D31），呼入主叫不带国家码同样按被叫 DID 所属国家的本地号码计算（D32）。两句原话说的都是**号码**的国家，所以国家码放在 `dids.country_code` 上，不放在线路上：一条线路可以同时承载英国和美国的 DID。

**一条规则：`toCanonical(raw, cc)`**，取代 `normalizeDialedNumber` 里硬编码的 `86`，`cc` 是所匹配 DID 的 `dids.country_code`：

1. 以 `+` 开头：去掉 `+`。以 `00` 开头：去掉 `00`。冠字号码不看 `cc`。
2. 无冠字，且 `raw` 以 `cc` 开头、其后部分是 6–12 位且不以 `0` 开头、总长不超过 15 位：视为已带该 DID 的国家码，**原样使用，不重复补全**。否则 `8613800138000` 在 `cc=86` 的 DID 上会变成 `868613800138000`。
3. 其余：去掉一个开头的 `0`，前面加 `cc`。
4. 结果必须符合 `^[1-9][0-9]{5,14}$`，否则格式错误（484，或呼入「无法识别」）。

**`cc` 从哪来。**

| 号码                       | `cc`                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| 呼出被叫                   | 主叫所匹配 DID 的 `country_code`。所以**必须先匹配主叫，才能规范化被叫**（4.2 第 3、4 步） |
| DID 匹配本身（主叫或被叫） | 候选 B 逐个 DID 用它自己的 `country_code`（见下）                                          |
| 呼入主叫                   | 被叫所匹配 DID 的 `country_code`                                                           |

**会判错的边界。** 规则 2 靠「以 `cc` 开头且长度合理」判断，下面几种会错：

- 本国号码本身就以国家码数字开头，且去掉后长度合理：例如 `cc=7` 的哈萨克斯坦手机 `7701234567`（无前导 0 的国内写法）会被当成已带国家码，实际应为 `77701234567`。`cc=1`（NANP）上国内格式 `1` + 10 位恰好正确。
- 运营商或客户送**不带 `+`、不带 `00` 的外国**带国家码号码：例如 `cc=86` 的 DID 收到来电，主叫 `447700900123`，按规则 3 变成 `86447700900123`（见 [10](#10-矛盾与风险) 第 11 项）。
- 国家码后面又带了中继 `0`（`86010…`）这类非标准写法：规则 2 要求其后部分不以 `0` 开头，所以落入规则 3，得到错误号码。
- 6–12 位的范围是通用假设，没有按各国号码长度逐一核对（[13](#13-没能核对的内容)）。

**匹配 DID** `matchDidCandidates(raw, scope)`，`scope` 是可选的 DID 集合，每个 DID 带自己的 `number` 和 `country_code`：

1. 有 `+` 或 `00` 冠字：唯一候选 = 去冠字后的数字串，等于某个 DID 的 `number` 即命中。
2. 无冠字：候选 A = 原数字串（对方已带国家码但没写 `+`），等于某个 DID 的 `number` 即命中。
3. A 未命中时看候选 B：**逐个 DID 比较** `toCanonical(raw, did.country_code) = did.number`，成立的 DID 就是命中。
4. 顺序与冲突：A 命中就取 A，不再看 B。B 命中**多个不同** DID → 歧义，拒绝并告警，不猜。

范围：

- **呼入**：线路由来电入口确定，Worker 核验（见 4.3）。`scope` = 该线路上当前生效的 DID，可能有多个 `country_code`（一条线路可同时有英国和美国 DID），所以呼入也适用歧义规则：拒绝，SIP 404（同 4.3 第 1 步，不产生话单），开 `did_noncompliant` 告警。
- **呼出**：`scope` = 该租户当前生效归属的 DID。歧义 → 403（4.2 第 3 步）。命中的 DID 所属线路就是呼出线路。
- **超时回退**：Lua 在号码表里用同一规则匹配，号码表每条带 `cc`。

**`resolveBillingNumber` 的改法。** 签名加必填的 `countryCode`（调用方传所匹配 DID 的 `country_code`）：`resolveBillingNumber({ dialedNumber, countryCode, callee?, billingNumber? })`，内部调用 `toCanonical`。`callee`、`billingNumber` 仍是用来核验的投影，核验方式不变（不一致 → `mismatch`）。`normalizeDialedNumber(raw)` 删除，调用点（`apps/worker/src/app.ts`、`apps/worker/src/ingest.ts`、测试）全部改传 `countryCode`；PR 1 把函数改成带 `cc` 参数，过渡期调用点显式传 `86`，PR 4 切换（见 9）。

**主叫匹配不到 DID 时的话单。** 被叫无法规范化，`cdrs.billing_number` 为空（3.3），`callee` 保存原始拨号。这只会出现在未接通的被拒话单上；已接通却匹配不到 DID 的话单停放为「DID 未登记」，`unassigned_cdrs.billing_number` 同样为空。

**用例表。** `freeswitch/tests/dialed-cases.tsv`（现有六个大陆用例，见 `tests/dialed-cases.test.ts`）加 `cc` 列，原有行 `cc=86` 结果不变；新建 `freeswitch/tests/did-cases.tsv` 放 DID 匹配用例。Lua 与 Worker 共用这两份表。`toCanonical` 用例：

| 原串                            | `cc`（所匹配 DID 的 `country_code`） | 结果                                                  |
| ------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| `13800138000`                   | 86                                   | `8613800138000`                                       |
| `8613800138000`                 | 86                                   | `8613800138000`（不重复补全）                         |
| `07551234567`                   | 86                                   | `867551234567`                                        |
| `13055551234`                   | 86                                   | `8613055551234`（现有用例，不变）                     |
| `+13055551234`、`0013055551234` | 任意                                 | `13055551234`                                         |
| `07700900123`                   | 44                                   | `447700900123`                                        |
| `447700900123`                  | 44                                   | `447700900123`                                        |
| `02079460000`、`2079460000`     | 44                                   | `442079460000`                                        |
| `3055551234`                    | 1                                    | `13055551234`                                         |
| `13055551234`                   | 1                                    | `13055551234`                                         |
| `7701234567`                    | 7                                    | `7701234567`（**已知误判**，应为 `77701234567`）      |
| `447700900123`                  | 86                                   | `86447700900123`（**残余风险**，应为 `447700900123`） |

DID 匹配用例。线路 `mix1` 同时有英国和美国 DID：`442079460000`（`country_code=44`）、`12125550123`（`country_code=1`）；线路 `cn1`：`862100000000`（`country_code=86`）。歧义用例另加 `mix1` 上的美国 DID `12079460000`：

| 原串                                        | 范围                                                             | 候选                                                                                                 | 结果                  |
| ------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------- |
| `02079460000`                               | 呼入 mix1                                                        | B：英国 DID `toCanonical` = `442079460000` 命中；美国 DID `toCanonical` = `12079460000` 不是任何 DID | 命中英国 DID          |
| `2125550123`                                | 呼入 mix1                                                        | A 未命中；B：英国 `442125550123` ✗，美国 `12125550123` ✓                                             | 命中美国 DID          |
| `12125550123`、`442079460000`               | 呼入 mix1                                                        | A                                                                                                    | 命中                  |
| `+442079460000`、`00442079460000`           | 任意                                                             | `442079460000`                                                                                       | 命中                  |
| `02100000000`、`2100000000`、`862100000000` | 呼入 cn1                                                         | B、B、A                                                                                              | 都命中 `862100000000` |
| `02079460000`                               | 呼入 cn1                                                         | B：`862079460000`                                                                                    | 未命中，404           |
| `2079460000`                                | 呼入 mix1，另有美国 DID `12079460000`                            | B：英国 `442079460000` ✓，美国 `12079460000` ✓                                                       | **歧义**，404 并告警  |
| `2079460000`                                | 呼出，租户同时有英国 DID `442079460000` 和美国 DID `12079460000` | 同上                                                                                                 | **歧义**，403 并告警  |
| `02079460000`                               | 呼出，租户有 `442079460000` 和 cn1 的 `862100000000`             | B：英国 ✓，cn ✗                                                                                      | 命中英国 DID          |
| `02079460000`                               | 呼出，租户有 `442079460000` 和 `862079460000`                    | B 两个都命中                                                                                         | 歧义，403             |

**呼入主叫的规范化**（用于 toll free 费率和国家判定）。`lines.caller_number_format` 默认 `domestic_when_unprefixed`（D32，依据 D33）：按 `toCanonical(raw, 被叫 DID 的 country_code)`，与呼出被叫同一规则。`international_digits` 只在运营商确实送不带 `+` 的带国家码号码时才选：无冠字时视为已带国家码、不补全；有冠字照常去冠字。规范化结果必须是 6–15 位数字，否则按「无法识别」。国际来电基本带 `+` 或 `00`（D33），所以默认值对外国来电正常；偶发例外的后果见 [10](#10-矛盾与风险) 第 11 项。话单保留原始 `caller`，便于事后核对。

**隐藏与无法识别。** 隐藏 = 主叫为空、`anonymous`、`unknown`、`restricted`、`unavailable`（忽略大小写），或去掉开头 `+` 后不是 5–15 位纯数字。无法识别 = 规范化后在 `toll_free` 费率表中没有匹配前缀。隐藏或无法识别的呼入：`country` 记「未知」，`iso` 空，`caller_billing_number` 空。隐藏主叫基本没见到（D33）。FreeSWITCH 对匿名主叫实际写入 `caller_id_number` 的内容**未核对**，Lua 同时传 `caller_id_name` 供 Worker 判断。

### 5.2 费率匹配

`loadRatingTenant`（`packages/db/src/rates.ts`）现在一次读该租户的全部版本和条目。改为按需读取：`loadRateTable(tx, tenantId, lineId, category, at)` 只取（租户、线路、类别）中 `effective_from <= at` 的最后一个版本和它的条目，授权的 p95（`docs/evidence/phase-3-closeout/perf-authorize.txt` 记录约 5.5–6.3 ms）不得变差，PR 4 要重跑。匹配仍用 `longestPrefix`，被匹配的键：

| 类别        | 匹配的号码            | `country` 来源                                                         |
| ----------- | --------------------- | ---------------------------------------------------------------------- |
| `outbound`  | 被叫 `billing_number` | 费率行的国家（同现状）                                                 |
| `inbound`   | DID 的规范号码        | 主叫国家：主叫规范号码在 `prefix_countries` 最长前缀匹配，无则「未知」 |
| `toll_free` | 主叫规范号码          | 同上                                                                   |

入库同时写英文快照：`country_en`、`description_en` 随费率行复制；呼入的主叫国家取 `prefix_countries.country_en`。时间基准：DID 归属按 `started_at` 判定；费率版本按 `answered_at`（现有规则不变）。`prefix_countries` 修改后只影响之后入库的话单，已入库话单保存快照。

### 5.3 含分钟数抵扣与金额精度

全部整数秒，金额用 `decimal.js`（ESLint 规则 `money/no-number-money` 仍然生效）。

输入：`talk = billsec`；费率行的 `rate`（元/分钟）、`cycle`（`60/60` 或 `1/1`）；该归属当月额度行 `remaining = granted_seconds - used_seconds`。

1. `billed_seconds = billedSeconds(talk, cycle)`。`packages/rating/src/billing.ts` 的 `billedSeconds` 已支持任意 `BillingCycle`，`60/60` 对应 `CYCLE_60_60`，`1/1` 是 `{ initialSeconds: 1, incrementSeconds: 1 }`。
2. 若 `rate = 0` 或没有额度行：`included = 0`，`charge = 0`（零费率不消耗额度）。
3. 否则 `step = cycle 的 incrementSeconds`；`included = floor(min(remaining, billed_seconds) / step) × step`。
4. `paid_seconds = billed_seconds - included`；`charge = round6(paid_seconds × rate / 60)`，`round6` 为 6 位小数 `ROUND_HALF_UP`。
5. 同一事务内 `UPDATE did_allowances SET used_seconds = used_seconds + included`，并写 `cdrs`。

例（费率 0.0450 元/分钟）：

| 场景                         | billed | remaining | included | paid | charge                                      |
| ---------------------------- | ------ | --------- | -------- | ---- | ------------------------------------------- |
| 60/60，通话 61 秒，剩 60 秒  | 120    | 60        | 60       | 60   | 0.0450                                      |
| 60/60，计费 180 秒，剩 90 秒 | 180    | 90        | 60       | 120  | 0.0900，剩 30 秒留给之后的 1/1 通话         |
| 1/1，通话 100 秒，剩 90 秒   | 100    | 90        | 90       | 10   | 0.0075                                      |
| 1/1，费率 0.0100，付费 1 秒  | 1      | 0         | 0        | 1    | 0.000167（0.0100/60 = 0.0001666…，取 6 位） |
| 费率 0                       | 任意   | 任意      | 0        | 全部 | 0                                           |

**精度。** `60/60` 的付费秒数是 60 的倍数，`charge` 是费率的整数倍（最多 4 位小数），与现状一致；`1/1` 的 `rate / 60` 通常除不尽，所以每通话**在写入时**取 6 位，之后账本、账单、话单一律用这个存下来的值，不再重算。这修改了 `design.md` §12 的「计费过程中不提前四舍五入」，对 `60/60` 没有影响，只影响 `1/1`（[10](#10-矛盾与风险) 第 6 项）。`chargeCall`（`packages/db/src/cdr-intake.ts`）原来用 `priceCall(durationSeconds, rate)` 重算金额，必须改为读 `cdrs.charge`，否则含分钟抵扣后会多扣。

**并发。** 入库事务在 `lockTenants(tx, [tenant.id])` 之后才读写额度行（`ingestCdr` 已是这个顺序），一个 DID 只属于一个租户，所以同一额度行的所有扣减被租户锁串行；再对额度行 `SELECT … FOR UPDATE` 只是防御。额度行不存在（月初 `did-fees` 任务尚未跑）时，在锁内调用 `ensureMonthDue`（[6.1](#61-任务与流水)）幂等创建。

**顺序。** 额度按**入库处理顺序**抵扣，不按通话先后。FreeSWITCH 故障后补推的话单会比后到的新话单晚抵扣；差别只在抵扣了哪些费率不同的通话，总分钟数不变，结果一经写入不再变（[10](#10-矛盾与风险) 第 7 项）。

**跨月。** 额度月份 = 接通时间的北京月，通话跨月仍整通算接通月（与 `design.md` §12 一致）。

### 5.4 入库顺序

`ingestCdr`（`apps/worker/src/ingest.ts`）的流程在现有「原文落盘 → 解析 → 加租户锁 → `call_uuids` 去重」之后，原来的「`priceAndInsertCdr`」拆成：

1. 判定 DID：呼出按 `caller` 在该租户的生效归属 DID 中、呼入按被叫在话单 `billing_line` 指定线路的 DID 中，用 [5.1](#51-号码规范化) 的范围规则匹配，再查 `started_at` 时的生效归属。话单没有 `billing_line` 的呼入按「DID 未登记」处理。匹配到 DID 后，用该 DID 的 `country_code` 重新计算 `billing_number`（`resolveBillingNumber`），话单带的投影不一致则停放，原因沿用「计费号码不一致」。不匹配：
   - 已接通 → 停放到 `unassigned_cdrs`，新原因「DID 未登记」「DID 归属不一致」（`classify.ts` 的 `ASSIGNABLE_REASONS` 不加这两个：归属要靠修正 DID 表解决，而不是选租户）；
   - 未接通（含被授权拒绝）→ 写 `cdrs`，`did_id` 空，`billing_number` 空（被叫无法规范化）。
2. 核验：话单的 `billing_tenant`（转大写）等于归属租户；`billing_line` / `billing_did`（若有）等于判定结果。不一致 → 停放，原因「DID 归属不一致」。
3. 类别与费率：[5.2](#52-费率匹配)。没有费率行 → 停放，原因沿用「接通时无费率」；`toll_free` 主叫隐藏或无法识别 → 停放，新原因「主叫无法识别」（没有费率就无法计费，不论是否未验证都停放）。
4. 抵扣与计费：[5.3](#53-含分钟数抵扣与金额精度)，写 `cdrs` 和 `did_allowances`。
5. 已删除月份、`call_uuids` 重复等分支不变（`CDR_MONTH_DELETED_REASON`）。
6. `charge > 0` 时入扣费队列，**不再区分方向**（`ingest.ts` 里 `cdr.direction !== 'inbound'` 的条件去掉）。

`priceCdr` / `priceAndInsertCdr` / `classifyRows` / `assignUnassigned`（`packages/db/src/unassigned/`）共用这套逻辑：未归属话单分配后同样要判定 DID、抵扣额度。分配事务已持租户锁，顺序一致。

### 5.5 未验证话单的事后处理

`unverified = true` 的话单在入库时额外评估「如果当时授权正常，会不会被拒」，结果写进 `cdr_review_items`（话单仍正常入库并照常计费，Frank 可手工调账，D25）：

| `reason`          | 判定                                                                                          | 依据                                        |
| ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `tenant_disabled` | 租户当前为停用                                                                                | 当前 `tenants.status`（**没有历史**，近似） |
| `fee_suspended`   | `started_at` 落在某条 `did_suspensions` 区间内                                                | `did_suspensions`                           |
| `no_balance`      | 通话开始时刻可用额度 `<= 0`：`sum(ledger.amount where occurred_at <= started_at) + overdraft` | 流水                                        |

另外两种情形无法定价或无法归属，**统一停放到未归属待办**，不进 `cdr_review_items`：归属核验不一致（5.4 步骤 2）、toll free 主叫无法识别（5.4 步骤 3，没有费率无法计费）。未验证话单的这两种停放同样计入当天的 `did_noncompliant` 告警，管理员照样收到通知。

每个租户每个自然日（话单没有租户时按租户标签）合并成一条 `did_noncompliant` 系统告警（`subjectKey = did-noncompliant:<租户或标签>:<日期>`，`notify = true`），邮件走现有 `alert_start` / `alert_digest` / `alert_recovered`（收件人 `resolveAlertRecipients`，管理员）。待办列表在后台未归属话单页的第二个标签「未验证待核对」（[7](#7-api-和页面)）。`packages/db/src/alert-list.ts` 第 335 行和 `alert-notify.ts` 第 506 行的未验证统计去掉 `direction = 'outbound'`。

### 5.6 重推幂等、扣费队列、对账

- **重推。** `call_uuids` 去重不变：已登记的 UUID 在计费前就返回 `duplicate`，所以额度只扣一次；额度扣减和 `cdrs` 插入同事务，插入失败整体回滚。
- **扣费队列。** `charge-cdr`（`apps/worker/src/queue.ts` 的 `CHARGE_QUEUE`）不变。任务读 `cdrs.charge`，写一笔 `call_charge` 流水（幂等键仍是 `call:<UUID>`，`callChargeKey`），`charge = 0` 不写流水（全部被含分钟抵扣的通话就是 0）。
- **对账。** `reconcile.ts` 的条件去掉 `c.direction = 'outbound'`，保留 `c.charge > 0`；其余（`reconcile_attempts`、告警 `chargeReconcile`）不变。新增对账项：`did_allowance_discrepancies` 非空时开告警（借用 `statement_mismatch` 的做法，具体 kind 在 PR 5 定）。
- **统计口径。** `usage.ts`、`overview.ts` 里 `direction = 'outbound'` 的过滤改为按方向分列（[7](#7-api-和页面)）。

## 6. 月租

### 6.1 任务与流水

**开通单元。** 一个归属第一次生效时产生的应收：开通费（`activation`）+ 开通当月的比例月租（`monthly`）+ 开通当月的额度行，三者合称开通单元，**作为一个整体付清**：单元合计 ≤ 可用额度（余额 + 透支）才一起写流水；不够则一行都不写。归属在开通单元付清之前**不生效**（3.2「生效归属」）。比例按 `effective_from` 的北京日期算（6.2），即使延迟付款也不改变。

`activateAssignment(tx, assignment)`（租户锁内）创建并尝试付清开通单元。两种触发时机：

| 情形                                        | 谁触发                                                                                                                             | 余额不足时                                                                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 立即生效（`effective_from` 不晚于指派时刻） | Frank 指派的 API 事务内，同一事务创建归属、应收、额度行并付款                                                                      | 指派被拒绝（HTTP 409，说明所需金额），什么都不写（D29）                                                                                                                   |
| 排定生效（`effective_from` 晚于指派时刻）   | 指派时只写归属，不扣费、不发额度；`did-fee-tick` 在 `effective_from` 到达后的下一分钟调用，不等 00:05，也不会早于 `effective_from` | 归属保持未生效（D29），开 `did_activation_failed` 告警（`subjectKey = did-activation:<归属 id>`，管理员收到邮件）；每分钟重试，付清后告警恢复、归属生效；**不停整个租户** |

两个 pg-boss 队列（名字加进 `apps/worker/src/queue.ts`）：

| 队列           | 调度（`tz: 'Asia/Shanghai'`）                     | 做什么                                                                                                                                        |
| -------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `did-fees`     | 每天 00:05，`missed: 'once'`                      | ① 对每个**已生效**且区间覆盖的归属，为**晚于开通月**的当月调用 `ensureMonthDue`；② 对每个有 `due` 月租的租户调用 `payMonthly`；③ 启动时补一轮 |
| `did-fee-tick` | 每分钟（沿用 `NOTIFY_QUEUE` 的 `* * * * *` 做法） | ① 处理到期的排定生效归属和重试开通失败；② 对停机租户检查可用额度是否够付清欠费，够则补扣并恢复；③ 09:00 那一分钟另发提前通知（6.5）           |

每天跑而不是只在 1 日跑：和月账单任务（`apps/worker/src/statements.ts` 的 `GENERATE_STATEMENTS_CRON`）同一思路，停机多日后一次触发就补齐所有缺口。

`ensureMonthDue(tx, assignment, month)` 幂等，只用于**晚于开通月**的月份：`INSERT … ON CONFLICT DO NOTHING` 写 `did_fee_charges`（`monthly`，金额取 `termsFor(assignment, month).monthly_fee`；为 0 则直接 `paid`）和 `did_allowances`（`granted_seconds = included_minutes × 60`）。只对 `[开通月, 退号月]` 内的月份创建。入库路径也可调用（5.3）。

`payMonthly(tx, tenantId)`：`lockTenants(tx, [tenantId])` → 取该租户所有 `status='due'` 的月租行（属于已生效归属，不含开通单元）→ 总额 ≤ 可用额度则对**每行**调用 `appendLedgerEntry` 写一笔负流水并置 `paid`，否则一行都不写（全有或全无），并进入停机（6.4）。

| 流水类型             | 幂等键                            | 金额 | `occurred_at` | 备注                       |
| -------------------- | --------------------------------- | ---- | ------------- | -------------------------- |
| `did_activation_fee` | `did-activation:<归属 id>`        | 负   | 写入时间      | `号码开通费 <DID>`         |
| `did_monthly_fee`    | `did-monthly:<归属 id>:<YYYY-MM>` | 负   | 写入时间      | `号码月租 <DID> <YYYY-MM>` |

金额为 0 的应收（例如免开通费的套餐）创建时即置 `paid`，**不写流水**；否则会违反 `ledger_entries_kind_shape`。

`occurred_at` 取写入时间而不是 1 日 0 点：欠费补扣发生在月份已结算之后时，不会往已生成账单的月份里补流水（账单头部来自流水的 `occurred_at`，见 `statements/compute.ts`）。

### 6.2 比例公式

北京日历，`days_in_month` 为该月天数，`remaining = days_in_month - 开通日 + 1`（含开通当天；开通日取 `effective_from` 的北京日期）。

- 开通月月租 = `round2(monthly_fee × remaining / days_in_month)`（`ROUND_HALF_UP`，2 位小数）；
- 开通月含分钟 = `floor(included_minutes × remaining / days_in_month)` 分钟，存成秒；
- 之后每月 1 日：整月月租、整月含分钟。

例 1：2026-11-12 开通，开通费 20.00，月租 30.00，含 100 分钟。11 月 30 天，`remaining = 30 - 12 + 1 = 19`。月租 `30.00 × 19 / 30 = 19.00`；含分钟 `floor(100 × 19 / 30) = floor(63.33) = 63` 分钟（3780 秒）。首次扣 20.00 + 19.00 = 39.00（两笔流水）。12 月 1 日扣 30.00，含 100 分钟（6000 秒）。

例 2：2026-10-10 开通，月租 29.90。10 月 31 天，`remaining = 22`，`29.90 × 22 / 31 = 21.2193…`，取 **21.22**；含 100 分钟的比例分钟 `floor(70.96…) = 70`。

例 3：开通日是 1 日，`remaining = days_in_month`，月租和含分钟都是整月；该月的 `did-monthly` 键已被开通扣费占用，1 日任务不会重复扣（幂等键相同）。月末最后一天开通：30 日开通 11 月，`remaining = 1`，月租 1.00，含分钟 `floor(100/30) = 3`。

退号：不退款（D18）。退号当月已扣的月租和已发的额度不变，额度在月底清零。退号后不再创建后续月份的应收。

### 6.3 幂等

三层：`did_fee_charges` 的 `UNIQUE (assignment_id, kind, month)`；流水的 `UNIQUE (tenant_id, idempotency_key)`（`ledger_entries_tenant_idempotency_key`）；`payFees` 在租户锁内读状态，两个实例并发也只有一个写成功。`did_fee_charges.status` 与 `ledger_entry_id` 同事务更新。

### 6.4 停号状态机

停机是租户级状态，用 `did_suspensions` 是否有开口记录表示。只有**月租**欠费触发停机；开通单元付不起只让那一个归属不生效（6.1），不停机。

```
        正常 ──(00:05 任务：月租应付合计 > 可用额度)──▶ 停机
         ▲                                              │ 开口记录 + 告警 did_suspended
         │                                              │
         └──(每分钟 tick：可用额度 ≥ 全部欠费)────────────┘
              补扣全部欠费 → 关闭记录 → 告警恢复
```

| 转移      | 条件                                                                    | 动作                                                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常→停机 | `did-fees` 的 `payMonthly` 发现应付合计 `> 余额 + 透支额度`             | 欠费行保持 `due`；插入 `did_suspensions` 开口记录；开 `did_suspended` 告警（`notify = true`，管理员收到开始邮件）                                                                                              |
| 停机→正常 | tick 发现 `余额 + 透支额度 ≥ 全部 due 之和`（充值、赠送、调账都会触发） | `payMonthly` 补扣全部欠费（含当月月租及此间累计的月份）；`resumed_at = now()`；告警恢复（管理员收到恢复邮件）                                                                                                  |
| 停机中    | 新月份到来                                                              | 继续创建应收（号码仍被占用），欠费累计（D30）；停机满 3 个月（累计 3 个月的月租未付）时开 `did_suspension_long` 告警（`notify = true`，管理员收到邮件），由 Frank 决定是否回收，系统不自动回收；恢复时一并付清 |
| 回收      | Frank 手动「退号」                                                      | 关闭归属；已产生的欠费保留                                                                                                                                                                                     |

停机只影响新呼叫（呼出 402，呼入 480，全部 DID），不切断进行中的通话，与现有「停用」一致（`design.md` §4.2）。

### 6.5 通知

- **提前通知。** 每天 09:00（北京）检查：下月 1 日 − 3 天和 − 1 天（例：12 月 1 日对应 11 月 28 日和 11 月 30 日）；对每个租户算下月应付月租合计 + 现有欠费，大于 `余额 + 透支额度` 则入队 `did_fee_notice` 邮件。收件人 = `resolveAlertRecipients`（管理员，`packages/db/src/alert-notify.ts`），幂等键 `did_fee_notice:<租户>:<YYYY-MM>:<3|1>`（`enqueueEmail` 的 `dedupeKey`）。收件人解析封装成 `resolveDidNoticeRecipients(tx, tenantId)`，以后加租户邮箱只改这一个函数。
- **停机与恢复。** 走 `did_suspended` 告警的开始和恢复邮件，不新增模板。
- **语言。** `did_fee_notice` 和告警邮件都发给管理员，**一律中文**（D37）。
- **门户。** 停机时首页横幅提示，文字有中英文两份（`did:suspended.banner`，D37；D19 没要求横幅，属于自定取值 S22）。

### 6.6 与现有状态的关系

| 状态                                       | 来源                                                  | 呼出                 | 呼入                         |
| ------------------------------------------ | ----------------------------------------------------- | -------------------- | ---------------------------- |
| 租户停用 `tenants.status = 'disabled'`     | 管理员手动                                            | 拒 403               | 拒 403（D9）                 |
| 欠月租停机（`did_suspensions` 有开口记录） | 月租任务                                              | 拒 402               | 拒 480，免费 DID 也拒        |
| 余额不足（可用额度不够所拨/所收一分钟）    | 实时判断，现有 `tenantHealth` 的 `suspended` 是其子集 | 拒 402（零费率除外） | 收费 DID 拒 480，免费 DID 接 |

优先级：停用 > 欠月租停机 > 余额不足。`packages/db/src/tenant-health.ts` 的 `tenantHealth` 和 `packages/shared/src/api/tenant-health.ts` 的 `tenantHealthSchema` 加 `did_suspended`，排在 `disabled` 之后、`suspended` 之前；门户首页横幅（`docs/pages.md` 第 138 行「余额不足，已暂停呼叫」）的文案要区分三种。现有 `balance_notice_state` 的「停机」通知（决定 28、30，仅按 `余额 + 透支额度 <= 0`）不受影响。

## 7. API 和页面

**所有可见文字用文案键。** 本节的页面、按钮、提示、错误、枚举名都写进 `packages/shared/src/i18n/{zh,en}/did.ts`（以及 `errors.ts`、`enums.ts`），页面里用 `t('did:…')`，不写死中文（D36，i18n 文档 4、13）；错误用错误码 + 键，不返回中文句子。

只用 shadcn/ui 原生组件（用户规则）。`apps/web/src/components/ui/` 现有：`alert`、`badge`、`button`、`card`、`checkbox`、`command`、`dialog`、`dropdown-menu`、`input-group`、`input`、`item`、`label`、`native-select`、`popover`、`radio-group`、`separator`、`sheet`、`skeleton`、`switch`、`table`、`tabs`、`textarea`、`toggle-group`、`toggle`。需要新增的组件（如 `select`、`tooltip`、`field`、`pagination`）一律用 `shadcn add` 从注册表安装，不手写；目前列表里已有的自写组件（如 `option-tabs.tsx`、`month-field.tsx`）本批不碰也不扩用。

### 7.1 API

契约位于 `packages/shared/src/api/admin/contract.ts` 和 `portal/contract.ts`，处理器在 `apps/api/src/routes/`，服务在 `packages/db/src/admin/`、`packages/db/src/portal/`。

| 范围   | 路径                                                                                                       | 说明                                                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后台   | `GET/POST /api/admin/lines`、`PATCH /api/admin/lines/{id}`                                                 | 线路增改；停用线路 = 拒绝新授权                                                                                                                                                                                                                 |
| 后台   | `GET/POST /api/admin/dids`、`PATCH /api/admin/dids/{id}`                                                   | DID 增改（号码、线路、类型创建后不可改；国家、备注可改）；列表筛选租户、线路、状态                                                                                                                                                              |
| 后台   | `POST /api/admin/dids/{id}/assign`、`POST /api/admin/dids/{id}/release`、`POST /api/admin/dids/{id}/terms` | 指派或换租户（含生效时间和套餐条款；立即生效且余额不足返回 409）；退号；套餐条款变更（只能下月 1 日起生效）。均记 `operation_logs`                                                                                                              |
| 后台   | `GET/PUT/DELETE /api/admin/prefix-countries`                                                               | 前缀国家表增改删                                                                                                                                                                                                                                |
| 后台   | `GET /api/admin/tenants/{tenantId}/dids`、`.../did-fees`                                                   | 租户名下 DID（含本月已用、剩余）、应收与停机状态                                                                                                                                                                                                |
| 后台   | `/api/admin/tenants/{tenantId}/rates/*`（现有 8 个操作）                                                   | 请求和查询加 `lineId`、`category`；CSV 导入导出七列（见 D34）；复制只在同币种、同线路、同类别之间                                                                                                                                               |
| 后台   | `GET /api/admin/cdr-reviews`、`POST .../{id}/resolve`                                                      | 未验证待核对                                                                                                                                                                                                                                    |
| 后台   | 现有 `.../cdrs`、`.../cdrs/export`                                                                         | 加查询参数 `didId`；响应与 CSV 加 DID、线路、类别、计费秒、抵扣秒、周期                                                                                                                                                                         |
| 门户   | `GET /api/portal/dids`                                                                                     | DID 列表、月租、本月已用与剩余分钟                                                                                                                                                                                                              |
| 门户   | `GET /api/portal/rates`                                                                                    | 租户已有线路**当前生效**的三类费率，只含 `effective_from <= now()` 的最后一个版本，不返回排定版本；周期字段是 `billingUnit`（`minute` / `second`，D39），不返回 `60/60`、`1/1`。页面不单独成页，数据显示在 `/portal/dids` 的号码卡片下方（D38） |
| 门户   | 现有 `/api/portal/cdrs`、`/cdrs/export`、`/home`、`/statements*`                                           | 加 `didId`；首页与账单字段见 [8](#8-账单)                                                                                                                                                                                                       |
| Worker | `GET /fs/did-map`                                                                                          | [4.5](#45-did-与-freeswitch-路由如何保持一致)                                                                                                                                                                                                   |

门户响应的 schema 只能出现客户可见字段：`packages/shared/src/api/portal/` 的现有测试 `reject the extra key` 风格要延续，不能带 `unverified`、内部备注、费率版本 id。

### 7.2 后台页面

| 页面                            | 变化                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 侧栏（`app-shell.tsx`）         | 新增「线路」「号码」「前缀国家」三项（lucide 图标）。路由加进 `apps/web/src/router.tsx`                                                                                                                                                                                                                                                                                                                                                                                     |
| 线路                            | `Table` 列表 + `Dialog` 编辑。字段：代码、名称、英文名（均客户可见，提示同费率说明）、主叫格式（`NativeSelect`，默认「按本线路国内号码补全」，仅当运营商确实送不带 `+` 的带国家码号码时改选 `international_digits`）、状态（`Switch`）                                                                                                                                                                                                                                      |
| 号码                            | `Table`：号码、线路、类型（`Badge`）、国家、当前租户、生效时间、套餐、状态。筛选：租户、线路、类型（`NativeSelect`）。操作：新增 DID（填写号码、**国家码**、线路、类型、国家；国家码必填，号码必须以它开头，输入号码后按前缀国家表给出建议，Frank 确认）、指派/换租户、变更条款、退号（均 `Dialog`，退号需输入号码确认）；归属状态显示「生效」「待生效」「开通失败」（`Badge`）。指派对话框里若该租户在该线路的 `inbound` / `toll_free` 费率表中没有匹配行，用 `Alert` 警示 |
| 前缀国家                        | `Table` 搜索 + 行内编辑 `Dialog`，CSV 批量导入留到后续                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 租户详情（`tenant-detail.tsx`） | 标签页（`Tabs`）新增「号码」（DID、套餐、本月已用/剩余、欠费与停机状态）；「费率」标签（`tenant-tabs/rates-tab.tsx`）顶部加线路 `NativeSelect` 和类别 `Tabs`，其余版本、排定、导入、复制流程沿用；「话单」标签加 DID 下拉                                                                                                                                                                                                                                                   |
| 费率导入对话框                  | 模板和说明加「英文说明」「计费周期」两列（共七列）；旧五、六列文件给专门错误提示（同 `rate-list-design.md` D4 的做法）；后台周期显示 `60/60`、`1/1`                                                                                                                                                                                                                                                                                                                         |
| 话单（`components/cdr/*`）      | `cdr-filters.tsx` 加 DID `NativeSelect`（选项来自该租户 DID，多于 50 个时改 `Command` + `Popover` 的 Combobox 做法）；表格与详情加 DID、线路、类别、计费秒、抵扣秒                                                                                                                                                                                                                                                                                                          |
| 未归属话单                      | 页内 `Tabs`：「未归属」「未验证待核对」；后者列出 `cdr_review_items`，操作「标记已核对」                                                                                                                                                                                                                                                                                                                                                                                    |
| 概览/租户列表                   | 状态标签加「号码停机」（`Badge`）；「需要关注」加欠月租停机的租户                                                                                                                                                                                                                                                                                                                                                                                                           |
| 余额流水                        | 类型筛选与显示加两种号码费用                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 7.3 门户页面

| 页面                                            | 变化                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新「号码」`/portal/dids`（费率合并在此页，D38） | 上半：`Table`/`Item` 卡片，字段为号码、线路、类型、国家、月租、含分钟、本月已用/剩余，停机时顶部 `Alert`。**卡片下方**：当前生效的费率，线路 `Tabs` → 类别 `Tabs`（呼出 / 呼入 / toll free）→ `Table`（国家、前缀、说明、费率、计费周期）。周期显示「按分钟 / 按秒」（英文 `Per minute` / `Per second`，D39）。只显示当前生效版本，不显示「已排定」提示；这推翻 `design.md` §14 第 4 行。门户导航加「号码」，**没有单独的「费率」导航，也没有 `/portal/rates` 页面** |
| 话单                                            | 加 DID 下拉；方向筛选沿用（`toggle-group`）；呼入行显示主叫国家、费率与费用，不再是 `—`（`inbound-cdr-design.md`「页面和接口」要改）                                                                                                                                                                                                                                                                                                                                 |
| 首页                                            | 指标卡：通话分钟、通话数按呼入/呼出分列；新增「本月号码费用」；「本月消费」仍指通话扣费（S18）                                                                                                                                                                                                                                                                                                                                                                       |
| 月账单                                          | 见 [8](#8-账单)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 余额流水                                        | 号码开通费、月租单独列示，不按天合并（`design.md` 的「通话扣费按天合并」只对 `call_charge`；`ledger-merge.ts` 要确认新类型不被合并）                                                                                                                                                                                                                                                                                                                                 |

## 8. 账单

### 8.1 算式

`期初 + 充值 + 赠送 ± 调账 − 通话扣费 − 号码费用 = 期末`。号码费用 = `did_activation_fee` + `did_monthly_fee` 流水的绝对值之和（按 `occurred_at` 的北京月，和其他头部数字同一来源）。`call_charges` 现在含两个方向。

例：期初 100.00 + 充值 500.00 + 赠送 0.00 + 调账 0.00 − 通话扣费 123.45 − 号码费用 59.00 = 期末 417.55（59.00 = 11 月新开通的 39.00 + 另一个号码的月租 20.00）。

### 8.2 `monthly_statements` 与明细

```sql
ALTER TABLE monthly_statements
  RENAME COLUMN calls TO outbound_calls;
ALTER TABLE monthly_statements
  RENAME COLUMN call_minutes TO outbound_minutes;
ALTER TABLE monthly_statements
  ADD COLUMN inbound_calls integer NOT NULL DEFAULT 0 CHECK (inbound_calls >= 0),
  ADD COLUMN inbound_minutes numeric NOT NULL DEFAULT 0 CHECK (inbound_minutes >= 0),
  ADD COLUMN did_fees numeric NOT NULL DEFAULT 0 CHECK (did_fees >= 0),
  DROP CONSTRAINT monthly_statements_balanced,
  ADD CONSTRAINT monthly_statements_balanced CHECK (
    closing_balance = opening_balance + recharge + gift + adjustment - call_charges - did_fees);
```

- `monthly_statements_guard` 触发器（`0017`，`0018` 重建）里的 `figures_changed` 元组加上 `did_fees`、`inbound_calls`、`inbound_minutes`。
- `monthly_statement_countries` 主键由 `(statement_id, version, country)` 改为 `(statement_id, version, direction, country)`，加 `direction` 列。汇总行按（方向，国家）分开，不合并，避免规则表里的国家名与 `prefix_countries` 的写法不一致时同一国家出现两种名字（[10](#10-矛盾与风险) 第 8 项）；呼入「未知」是一个国家。
- 新增 `monthly_statement_directions(statement_id, tenant_id, version, direction, calls, minutes, charge)`，主键含 `direction`。
- 新增 `monthly_statement_dids(statement_id, tenant_id, version, did_id, did_number, outbound_calls, inbound_calls, outbound_minutes, inbound_minutes, included_seconds, call_charge, activation_fee, monthly_fee)`。每个有话单或有费用的 DID 一行；话单部分取自 `cdrs.did_id`，费用部分取自 `did_fee_charges` 已付行的流水月份。
- 三张明细表延用只增 + `reject_mutation` 触发器 + RLS 的做法（`0017`），重新生成时追加新版本。
- 分钟数 = `sum(billed_seconds) / 60`（含被抵扣的分钟）；`included_seconds` 单独列。

### 8.3 代码

- `packages/db/src/statements/compute.ts` 的 `computeStatement`：`by_country`、`by_day` 里的 `c.direction = 'outbound'` 去掉；`by_country` 按（方向，国家）分组；新增 `by_direction`、`by_did`；`flows` 加 `did_fees`；`breakdown_gap` 仍是 `call_charges` 与明细合计之差（明细合计现含两个方向）。
- `packages/db/src/statements/types.ts` 的 `StatementFigures` / `STATEMENT_FIGURE_KEYS` 加字段；`packages/shared/src/api/statement-fields.ts` 的 `statementFigureFields`、`statementCountryFields` 同步；门户和后台账单详情页（`pages/portal/statement-detail.tsx`、`pages/admin/tenant-tabs/statement-detail.tsx`、`components/statement/*`）改算式条（`statement-equation.tsx`）、国家表加方向列、新增方向表和 DID 表。
- `reconcile`（`packages/db/src/statements/reconcile.ts`）校验新算式；`apps/worker/src/statements.ts` 不变。
- 账单导出 CSV（`apps/api/src/routes/exports.ts`）加方向、DID 列，旧列顺序不变。
- 页面 `docs/pages.md` 2.5 的「按国家汇总」改成「按方向 × 国家」，新增「按方向」「按号码」两块。

## 9. PR 拆分与顺序

### 9.0 前置与通用规则

- **前置：i18n 批先合并。** 本批所有 PR 依赖 [i18n 文档](i18n-design.md) 的 I1–I7（框架、账号语言、现有页面英文、英文内容字段）已合并；PR 6 另需 I8（客户邮件按语言），PR 9 另需 I9（收尾）。迁移编号取开工时 `origin/main` 的下一个，排在 I3、I7、I8 的迁移之后；下文只写迁移的名字，不写编号。
- **新页面、新错误码、新枚举、新邮件文字**一律先写进文案目录 `packages/shared/src/i18n/zh/did.ts` 和 `en/did.ts`（以及 `errors.ts`、`enums.ts`），页面里用 `t('did:…')`，**不写死中文**；两种语言同时提交，目录测试和 lint 规则会拦住缺失。
- **通用规则**（命令、禁止事项、shadcn 组件、金额、流水）见 i18n 文档 12.0，本批同样适用，另加：
  - 每个迁移的格式同 `packages/db/migrations/0027_cdr_direction.sql`（开头 `SET LOCAL lock_timeout = '5s'`，分句用 `--> statement-breakpoint`），并同步 `packages/db/src/schema.ts`；
  - 写流水只经 `appendLedgerEntry`（`tooling/eslint/guardrails.ts` 会拒绝直接插入）；时间用北京时间固定口径（`packages/rating/src/time.ts`）；
  - 改授权、入库、流水的 PR，数据库测试必须在本地 `pnpm db:up` 的 PostgreSQL 上跑通（`pnpm test:db`）。
- **由主管会话处理**（外部 CLI 不做）：服务器 A/B 上的任何操作、SSH、密钥和 `.env` 真实凭据；`freeswitch/test/run-integration.sh`（需要 Linux 和 SignalWire 令牌，CI 也会跑）；真实线路联调和抓 SIP 头；服务器 A 上安装同步脚本；授权接口的性能重测（`docs/evidence/phase-3-closeout/perf-authorize.txt` 同一台机器）；前缀国家表和 ISO 英文名等**数据**的准备与核对。
- 每个 PR 说明里写：改了哪些文件、新增的测试名、验收标准逐条结果、哪些步骤留给主管会话。

### 9.1 依赖与顺序

| PR  | 内容                                    | 迁移                      | 依赖        |
| --- | --------------------------------------- | ------------------------- | ----------- |
| 1   | 只加新表和纯函数                        | `lines_dids`              | I1–I7       |
| 2   | 线路、DID、前缀国家的后台               | `did_active_view`         | 1           |
| 3   | 费率三类 + 七列 CSV                     | `rate_scopes`             | 1、2        |
| 4   | 授权 v2 与 FreeSWITCH，同时切换号码规则 | `billing_number_nullable` | 1、2、3     |
| 5   | 入库与计费                              | `cdr_did_snapshot`        | 1、3、4     |
| 6   | 号码套餐与月租                          | `did_fees`                | 1、2、5、I8 |
| 7   | 话单与门户页面                          | 无                        | 5、6        |
| 8   | 账单                                    | `statement_did`           | 5、6        |
| 9   | 联调与文档                              | 无                        | 1–8、I9     |

PR 2 在 PR 1 之后；PR 3 与 PR 2 可并行开发但先后合并；PR 7 与 PR 8 互不依赖。

### 9.2 PR 3 至 PR 5 之间的临时兼容

目的是每个 PR 合并后现有授权和入库照常工作。

- **PR 3 合并后。** `loadRatingTenant`（授权、入库、未归属分配都在用）改为只读 `outbound` 类别的版本，且只在租户的 `outbound` 版本都在同一条线路上时工作，多于一条线路抛配置错误（授权返回 503）；测试库此时每个租户只有一条线路。`RateEntry` 带 `billingCycle`，但 CSV 导入暂时拒绝 `1/1`（提示「计费周期 1/1 在入库升级后启用」），因为 `cdrs` 还没有周期和计费秒数，`chargeCall` 仍按 60/60 重算。`inbound`、`toll_free` 版本可以导入和查看，但没有计费路径使用。
- **PR 4 合并后。** 授权改用新路径并检查呼入余额。**号码规则（`toCanonical`、`resolveBillingNumber` 加 `countryCode`）在这个 PR 里授权和入库同时切换**：入库先匹配 DID 取 `country_code` 再重新计算 `billing_number`，所以授权与入库对非大陆号码不会不一致；调用点不再显式传 `86`。入库的定价仍走兼容读取，呼入仍按 #118 记 0 元（这个窗口里呼入被授权但不收费，只在内部测试使用）。号码规则不能拆在 PR 4 和 PR 5 之间，否则窗口内 Worker 重算会与授权不一致，话单被停放为「计费号码不一致」。
- **PR 5 合并后。** 入库和 `chargeCall` 用新路径；`loadRatingTenant`、单线路限制、CSV 对 `1/1` 的限制一起删除。
- **删除时机进验收**：PR 4 验收含「授权路径不再引用 `loadRatingTenant`」；PR 5 验收含「全仓库没有 `loadRatingTenant` 引用」。

**上线顺序（每次合并到测试服，由主管会话执行）：** 先重置测试库并迁移，再部署 Worker，最后更新服务器 A 的 Lua、拨号计划和同步脚本。旧 Lua 没有 `caller`，会被新 Worker 拒绝（呼出 403），所以 PR 4 合并后的测试窗口内两边同时切；内部真实线路测试因此有一小段中断，需要提前通知测试人员。

### 9.3 各 PR 的文件边界、测试和验收

文件路径都已核对存在；标「新建」的是新文件。同目录里已有的同类文件可作写法参照。

#### PR 1 只加新表和纯函数

- **迁移**（新建）`lines_dids`：`lines`、`prefix_countries`、`dids`、`did_assignments`、`did_term_changes`、`did_fee_charges`、`did_allowances`、`did_suspensions`、`cdr_review_items`，约束、触发器（`dids_freeze`、`did_assignments_guard`、额度行只增触发器）、RLS、授权，按 3.2、3.5。
- **修改**：`packages/db/src/schema.ts`（新表定义）；`packages/rating/src/dialed.ts`（`normalizeDialedNumber` 改为基于 `toCanonical(raw, cc)`，`resolveBillingNumber` 加必填 `countryCode`）；`packages/rating/src/billing.ts`（导出 `1/1` 周期常量）；`packages/rating/src/index.ts`；调用点 `apps/worker/src/app.ts`、`apps/worker/src/ingest.ts`（过渡期显式传 `86`，PR 4 删除）；`freeswitch/tests/dialed-cases.tsv` 与 `tests/dialed-cases.ts`（加 `cc` 列，原有行 `cc=86`，加 5.1 表里的非大陆行）。
- **新建**：`packages/rating/src/did.ts`（`toCanonical`、`matchDidCandidates`）、`packages/rating/src/allowance.ts`（5.3 的抵扣）、`packages/rating/src/fees.ts`（6.2 的比例月租、比例额度、`termsFor`）及同名 `*.test.ts`；`packages/db/src/did.db.test.ts`；`freeswitch/tests/did-cases.tsv`；`packages/shared/src/i18n/{zh,en}/did.ts`（空壳，后续 PR 往里加键）。
- **测试**：5.1 的 `toCanonical` 与 DID 匹配用例表全部行（含 `mix1` 歧义）；5.3 表中全部行；6.2 三个例子和 `termsFor` 变更前后；DB：同一 DID 只能有一条开口归属、归属不重叠、`line_id`/`number`/`country_code`/`type` 不可改、`number` 必须以 `country_code` 开头、`used_seconds <= granted_seconds`、0 元应收行不要求流水；扩展 `packages/db/src/rls.db.test.ts`、`migrate.db.test.ts`、`apps/api/src/idor.db.test.ts`（A 租户看不到 B 的归属、费用、额度、停机记录，租户身份不能写新表）。
- **验收**：迁移在空库上成功；现有全部测试不改断言即通过（`resolveBillingNumber` 过渡期传 `86`，行为不变）；`pnpm check`、`pnpm test:db` 通过。
- **不做**：任何页面、API、Worker 行为变化。

#### PR 2 线路、DID、前缀国家的后台

- **迁移**（新建）`did_active_view`：视图 `did_active_assignments`（只有区间条件）。
- **新建**：`packages/shared/src/api/admin/{lines,dids,prefix-countries}.ts`（契约，并在 `admin/contract.ts`、`admin/index.ts` 注册）；`packages/db/src/admin/{lines,dids,prefix-countries}.ts`（服务，从 `packages/db/src/index.ts` 导出）；`apps/api/src/routes/admin/{lines,dids,prefix-countries}.ts`（处理器，在 `apps/api/src/routes/register.ts` 注册）；`apps/web/src/pages/admin/{lines,dids,prefix-countries}.tsx`、`apps/web/src/pages/admin/tenant-tabs/dids-tab.tsx`；`packages/db/src/prefix-countries-load.ts` 加载器（`INSERT … ON CONFLICT DO NOTHING`）及 `packages/db/package.json` 里的脚本 `prefix-countries:load`（写法参照已有的 seed 脚本）；`packages/db/data/prefix-countries.csv`（只放表头和 3 行示例，**真实数据由主管会话准备并逐条核对来源，D28**）。
- **修改**：`apps/web/src/router.tsx`、`apps/web/src/components/app-shell.tsx`（后台侧栏加「线路」「号码」「前缀国家」）；`apps/web/src/pages/admin/tenant-detail.tsx`（加「号码」标签）；`packages/shared/src/i18n/{zh,en}/did.ts`（本页所有文字）；`packages/db/src/seed.ts`（一条线路 `mix1`、几个 DID）。
- **要点**：线路页只有代码、名称、英文名、主叫格式（默认 `domestic_when_unprefixed`）、状态；DID 页新增时填号码、国家码（必填，号码须以它开头）、线路、类型、国家（`country_en` 由 ISO 或前缀国家表按 i18n 文档 11.2 的 `resolveCountryEn` 填）；指派/换租户（换租户在一个事务里关旧开新，两个租户一次 `lockTenants`）、退号、`POST …/terms`；**此时指派不扣费**（PR 6 加）。所有写操作记 `operation_logs`。
- **测试**：服务层 DB 测试（换租户后旧话单的 `tenant_id`/`did_id` 不变；归属重叠被拒）；API 测试；web 组件测试（中文和英文各一）；Playwright：指派、换租户、退号（`apps/web/e2e/admin-dids.spec.ts` 新建）。
- **验收**：Frank 能建线路和 DID、指派、换租户、退号、变更条款；加载器重复运行不覆盖已改的行；页面只用 shadcn 组件；英文下无汉字；操作都有审计。

#### PR 3 费率三类 + 七列 CSV

- **迁移**（新建）`rate_scopes`：`rate_versions.line_id`/`category` 与唯一约束、`rate_versions_guard` 改按范围、`rate_entries.billing_cycle`；预检要求测试库已重置。
- **修改**：`packages/rating/src/csv.ts`（七列：`ISO, Country, Destination Prefix, Description, Description (EN), Rate, Billing Cycle`；表头别名沿用 i18n 文档 9.2 的逐列双语别名；旧五、六列有专门错误；暂时拒绝 `1/1`）、`packages/rating/src/rates.ts`（`RateEntry` 加 `billingCycle`）；`packages/db/src/rates.ts`（新增 `loadRateTable(tx, tenantId, lineId, category, at)`；`loadRatingTenant` 改为 9.2 的兼容读取）；`packages/db/src/admin/rates.ts` 与 `rate-preview.ts`（导入、编辑、复制、导出、取消排定都按 `lineId` + `category`）；`packages/shared/src/api/admin/rates.ts` 与 `contract.ts`（请求和查询加 `lineId`、`category`）；`apps/api/src/routes/admin/rates.ts`；`apps/web/src/pages/admin/tenant-tabs/rates-tab.tsx`、`components/admin/rate-*.tsx`（顶部加线路 `NativeSelect` 和类别 `Tabs`）；`packages/db/src/seed.ts`。
- **新建**（只做接口，**页面在 PR 7**）：`packages/shared/src/api/portal/rates.ts`、`packages/db/src/portal/rates.ts`、门户路由 `GET /api/portal/rates`（在 `packages/shared/src/api/portal/contract.ts` 注册）：返回租户已有线路当前生效的三类费率；每行带 `billingUnit: 'minute' | 'second'`（`60/60` → `minute`，`1/1` → `second`，D39），**不返回原始周期值、不返回排定版本、不返回版本 id**。
- **测试**：同一租户在两条线路、三个类别各有独立版本，排定版本互不影响；七列 CSV 往返一致（中文表头导出再导入、英文表头导出再导入）；旧五、六列有专门错误；`1/1` 被拒绝；门户接口只返回当前生效版本（`packages/shared/src/api/portal/portal.test.ts` 加「不泄露排定版本」）；**现有授权、入库、扣费、对账测试不改动即通过**（`apps/worker/src/ingest.db.test.ts`、`app.db.test.ts` 原样运行）。
- **验收**：如上；后台费率页能按线路和类别编辑、导入、复制、导出；英文下无汉字。

#### PR 4 授权 v2 与 FreeSWITCH，同时切换号码规则

- **迁移**（新建）`billing_number_nullable`：`cdrs.billing_number` 可空（约束 `billing_number IS NOT NULL OR answered_at IS NULL`）；`unassigned_cdrs_billing_number_reason_check` 扩展到「DID 未登记」。
- **新建**：`packages/db/src/did-lookup.ts`（生效归属、停机状态、额度只读计算）；`freeswitch/scripts/sync_did_map.sh` 与 systemd 单元示例（放 `freeswitch/systemd/`）；`apps/worker/src/did-map.ts`（`GET /fs/did-map`）。
- **修改**：`packages/shared/src/worker.ts`（`authorizeRequestSchema`/`authorizeResponseSchema`：`direction`、`caller`、`line`、`tenant`、可选投影、响应的 `line`/`did`/`tenant`、`sipCode` 加 480；`modJsonCdrSchema` 加 `billing_did`、`billing_line`）；`packages/rating/src/authorize.ts`（`authorize`/`callableMinutes` 改成接收线路费率表和额度剩余秒数，可用金额为负时金额部分取 0，零费率不看余额）；`apps/worker/src/app.ts`（`/authorize` 按 4.2、4.3 的顺序；`sipCodes` 表）；`apps/worker/src/ingest.ts`（先匹配 DID 取 `country_code`，再用 `resolveBillingNumber` 重算 `billing_number`，定价仍走兼容路径；`park` 加「DID 未登记」原因）；`packages/db/src/cdr-intake.ts`（`billing_number` 可空）；`freeswitch/scripts/billing_authorize.lua`、`freeswitch/dialplan/billing.xml`、`freeswitch/dialplan/trunk-inbound.xml.example`；`freeswitch/tests/billing_authorize_test.lua`、`tests/billing-authorize.test.ts`、`tests/dialed-cases.test.ts`；文档 `docs/worker-api.md`、`docs/freeswitch.md`、`freeswitch/README.md`。
- **测试**：4.2 每一步、4.3 每一行（含 5a 不告警、5b 告警、歧义）；超时回退时主叫 DID 属于别的租户被拒；额度行缺失时按条款现算；非大陆号码（英国、美国、`mix1`）授权与入库得到同一个 `billing_number`；主叫不匹配 DID 的被拒话单 `billing_number` 为空；Lua harness 的呼入与超时用例；`dialed-cases.tsv`/`did-cases.tsv` 全过；`apps/worker/src/app.db.test.ts` 加授权用例。
- **验收**：授权路径不再引用 `loadRatingTenant`；`pnpm check`、`pnpm test:db`、`lua5.3 freeswitch/tests/billing_authorize_test.lua` 通过。
- **由主管会话处理**：`run-integration.sh` 的真实 SIP 用例（两条线路）、授权 p95 重测、服务器 A 上安装同步脚本、真实线路抓 SIP 头核对主叫格式（D33）。

#### PR 5 入库与计费

- **迁移**（新建）`cdr_did_snapshot`：`cdrs` 快照列（3.3）、`cdrs_answered_shape` 重写、`billing_number` 约束收紧、`system_alerts` 加 `did_noncompliant`。
- **新建**：`packages/db/src/cdr-review.ts`（`cdr_review_items` 写入与评估，5.5）。
- **修改**：`packages/db/src/cdr-intake.ts`（`priceAndInsertCdr`、`priceCdr`、`chargeCall` 读 `cdrs.charge`）；`apps/worker/src/ingest.ts`（5.4 的完整顺序，`charge > 0` 就入队，不再区分方向）；`apps/worker/src/charge.ts`、`reconcile.ts`（去掉 `direction = 'outbound'`）；`packages/db/src/unassigned/{classify,assign,types}.ts`（共用同一套定价和额度逻辑）；`packages/db/src/alert-list.ts` 第 335 行与 `alert-notify.ts` 第 506 行（去掉 `direction = 'outbound'`）；`packages/db/src/usage.ts`、`overview.ts`、`portal/cdrs.ts`、`admin/cdrs.ts`（按方向分列）；`packages/shared/src/api/cdr-fields.ts`（`checkCdrShape`）；删除 `loadRatingTenant` 和 CSV 对 `1/1` 的限制；`packages/db/src/seed.ts`（呼入与 toll free 费率）。
- **测试**：5.3 全部行的入库结果；同一 DID 并行 20 通，抵扣总和等于额度；重推同一 UUID 不重复抵扣；`did_allowance_discrepancies` 为空；未验证不合规话单进 `cdr_review_items` 并告警；toll free 无法识别主叫停放且触发 `did_noncompliant`；呼入话单有费率、费用和主叫国家（含 `country_en`，哨兵「未知」写 `Unknown`）；`apps/worker/src/{ingest,charge-batch,reliability,multi-instance}.db.test.ts` 扩展。
- **验收**：全仓库没有 `loadRatingTenant` 引用；两个方向都出话单与账本；`pnpm check`、`pnpm test:db` 通过。

#### PR 6 号码套餐与月租

- **迁移**（新建）`did_fees`：`ledger_entries` 加 `did_activation_fee`、`did_monthly_fee` 与 `kind_shape`；`system_alerts` 加 `did_suspended`、`did_activation_failed`、`did_suspension_long`；`email_outbox` 的模板检查加 `did_fee_notice`；重建视图 `did_active_assignments`（加付清条件）。
- **新建**：`packages/db/src/did-fees.ts`（`ensureMonthDue`、`activateAssignment`、`payMonthly`、停机与恢复）；`apps/worker/src/did-fees.ts`（队列 `did-fees`、`did-fee-tick`）；`packages/shared/src/mail/` 的 `did_fee_notice` 模板（**只有中文**，发管理员）。
- **修改**：`packages/db/src/schema.ts` 的 `ledgerKinds`、`systemAlertKinds`、`emailTemplates`；`packages/db/src/ledger.ts`；`apps/worker/src/queue.ts`、`main.ts`；PR 2 的指派服务（立即生效扣费、余额不足 409）；`packages/db/src/tenant-health.ts`、`packages/shared/src/api/tenant-health.ts`（`did_suspended`）；`packages/shared/src/mail/templates.ts` 的 `balance_suspended`（两种语言同时改正文，D37）；门户首页停机横幅（`apps/web/src/pages/portal/home.tsx`，中英文）；`packages/shared/src/i18n/{zh,en}/{did,enums}.ts`。
- **测试**：开通当天扣费金额与 6.2 例 1、例 2 完全一致；立即生效且余额不足时指派被拒、不写任何行；排定生效在 `effective_from` 之后一分钟内处理，不早于 `effective_from`；开通失败只让该归属不生效；0 元开通费不写流水；1 日任务重跑不重复；余额不足时全部 DID 停、充值后一分钟内恢复并补扣；T-3/T-1 邮件各发一次；停机满 3 个月触发告警；条款变更当月不重复收费（`cron.db.test.ts` 风格的任务测试，假时钟，跨 11/30–12/1 与 12/31–1/1）；`did_fee_notice` 渲染中文；`balance_suspended` 中英文渲染。
- **验收**：如上；`pnpm check`、`pnpm test:db`（需要 Mailpit）通过。
- **由主管会话处理**：测试服上演练月租任务和停机恢复。

#### PR 7 话单与门户页面

- **新建**：`apps/web/src/pages/portal/dids.tsx`（路由 `/portal/dids`）；`GET /api/portal/dids`（`packages/shared/src/api/portal/dids.ts`、`packages/db/src/portal/dids.ts`、路由）；`GET /api/admin/cdr-reviews`、`POST …/{id}/resolve`（后台）；`apps/web/src/components/did/rates-section.tsx`（门户号码页下方的费率区块）。
- **修改**：`apps/web/src/router.tsx`、`components/app-shell.tsx`（门户导航加「号码」，**不加「费率」**）；`components/cdr/cdr-filters.tsx`、`cdr-table.tsx`、`cdr-detail.tsx`（DID 下拉，选项来自该租户的 DID；多于 50 个时改 `Command` + `Popover` 的 Combobox 做法）；`packages/db/src/portal/cdrs.ts`、`admin/cdrs.ts` 与 `cdr-query.ts`（`didId` 筛选）；话单和流水的导出（`apps/api/src/routes/exports.ts`，加 DID、线路、类别、计费秒、抵扣秒，表头随 `locale`）；`pages/portal/home.tsx`（分方向指标、本月号码费用）；`pages/portal/ledger.tsx` 与 `packages/shared/src/api/ledger-merge.ts`（号码费用单独列示，备注由 `kind` + DID + 月份生成）；`pages/admin/unassigned.tsx`（「未验证待核对」标签）。
- **门户号码页（D38、D39）**：上半是 DID 卡片（`Item`/`Card`：号码、线路、类型、国家、月租、含分钟、本月已用/剩余）；**卡片下方**是当前生效的费率：线路 `Tabs` → 类别 `Tabs`（呼出 / 呼入 / toll free）→ `Table`（国家、前缀、说明、费率、计费周期）。计费周期显示 `按分钟` / `按秒`（`rates:cycle.minute`、`rates:cycle.second`；英文 `Per minute` / `Per second`），数据来自 `billingUnit`。不显示排定的调价，也不显示「已排定」提示。没有 DID 时整页显示空状态。
- **测试**：组件测试（中英文）；`portal-cdrs.spec.ts`、`admin-cdrs.spec.ts` 扩展；新 e2e `portal-dids.spec.ts`（卡片、费率区块、周期文字、导航里没有「费率」、访问 `/portal/rates` 得到 404 页面）；`pages/portal` 的移动端布局测试（`apps/web/src/mobile-layout.test.tsx`）。
- **验收**：后台与门户话单可按 DID 筛选；呼入行显示费率与费用；首页分方向；号码页同时有卡片和当前费率；英文下无汉字；`pnpm check`、`pnpm test:e2e` 通过。

#### PR 8 账单

- **迁移**（新建）`statement_did`：`monthly_statements` 的列与 `monthly_statements_balanced`、`monthly_statements_guard`；`monthly_statement_countries` 主键加 `direction`；新增 `monthly_statement_directions`、`monthly_statement_dids`（只增 + `reject_mutation` 触发器 + RLS，做法同 `0017_monthly_statements.sql`）。
- **修改**：`packages/db/src/statements/{compute,types,generate,regenerate,reconcile,store,view,live}.ts`；`packages/shared/src/api/statement-fields.ts` 与 portal/admin 账单契约；`apps/api/src/export/statement-csv.ts`、`routes/exports.ts`（汇总与明细，表头随 `locale`）；`pages/portal/statement-detail.tsx`、`pages/admin/tenant-tabs/statement-detail.tsx`、`components/statement/*`（算式条、国家表加方向列、新增方向表和 DID 表）；`packages/shared/src/i18n/{zh,en}/statement.ts`。
- **测试**：8.1 的例子（期初 100.00 … 期末 417.55）；`monthly_statements_balanced` 通过；按国家合计等于通话扣费（`breakdown_gap = 0`）；按 DID 合计等于头部；重新生成追加新版本；`statements/*.db.test.ts` 扩展；账单导出的中英文表头；门户账单 e2e。
- **验收**：如上；`pnpm check`、`pnpm test:db` 通过。

#### PR 9 联调与文档（由主管会话处理）

- 内部真实线路上完整走一遍：呼出、普通呼入、toll free 呼入（含隐藏主叫被拒）、停 Worker 放行、月租欠费停机与充值恢复；抓真实国际来电的 SIP 头，核对主叫是否带 `+` 或 `00`（D33）；在服务器 A 安装同步脚本并核对号码表；授权 p95 重测。
- 文档：[2.2](#22-要改的文档) 列出的全部文件、`go-live-checklist.md`、`docs/inbound-cdr-design.md` 标注被取代。联调记录放 `docs/evidence/did-inbound/`。
- 外部 CLI 只负责其中的文档改动，且要主管会话给出联调结果后再写。

## 10. 矛盾与风险

以下是我在核对需求和代码时发现的，**没有替用户悄悄解决**；右栏是本文的处理办法。仍要外部答复的在 [11](#11-待确认事项)。

| #   | 问题                                                                                                                                                                                                                                                                                                                                                       | 暂定处理                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | D13「DID 归属由数据库管」与 D12「授权超时放行」冲突：放行时 Worker 不可用，若 FreeSWITCH 没有本地号码表就无法确定租户和线路                                                                                                                                                                                                                                | 方案 C：本地号码表 + 交叉核对（[4.5](#45-did-与-freeswitch-路由如何保持一致)）。代价是多一个同步脚本，生效延迟约 1 分钟       |
| 2   | D10 呼入通话中额度用完不挂断，只有 4 小时上限。toll free 假设 0.30/分钟，一通 240 分钟 = 72.00；20 通并发 = 1,440，而默认透支额度只有 CNY 100。授权只在通话开始检查，所以余额可远低于「余额 + 透支」。呼出有 `sched_hangup` 兜底，呼入没有                                                                                                                 | 按用户决定做。缓解只有呼入并发上限（`billing_inbound_concurrency`）；是否需要更低的单通上限或实时额度检查，用户可再决定       |
| 3   | D9 + D12：停用租户的呼入在授权超时期间仍会被放行，最长 1800 秒；`design.md` §4.2 对呼出已承认这一点，现在呼入同样适用。停用确认文案（`phase-5-design.md` 第 155 行）要同步                                                                                                                                                                                 | 事后记 `tenant_disabled` 待核对项；紧急切断仍靠 `uuid_kill` 的人工流程                                                        |
| 4   | D5「费率为 0 就是免费」与现有行为矛盾：`callableMinutes`（`packages/rating/src/authorize.ts`）先判 `available <= 0` 返回 0，再判零费率，所以零费率呼出在余额耗尽时今天被拒                                                                                                                                                                                 | 改为零费率不看余额，呼出呼入一致（S17）。这是**呼出行为变更**                                                                 |
| 5   | D7 与「免费 DID」的边界不清：一个 `toll_free` 类型、所有主叫前缀费率都为 0 的 DID，主叫隐藏时是拒接（因为是 toll free）还是接听（因为免费）                                                                                                                                                                                                                | 按**类型**判断，`toll_free` 类型一律拒绝隐藏主叫（S15）。若用户想按费率值判断，需要在授权时先查出该类别是否全 0               |
| 6   | D4 的 `1/1` 使 `rate / 60` 除不尽，与 `design.md` §12「计费过程中不提前四舍五入」冲突；含分钟数的部分抵扣还会让 `60/60` 通话出现非整分钟的付费秒数                                                                                                                                                                                                         | 单通话在写入时取 6 位，之后不再重算（S9）；抵扣量对齐到该行周期的步长，`60/60` 通话付费秒数始终是 60 的倍数（S10）            |
| 7   | D16 含分钟数的抵扣是先到先得，而话单到达顺序不等于通话顺序（FreeSWITCH 故障后补推）。费率不同的通话会因此得到不同的抵扣结果                                                                                                                                                                                                                                | 按入库顺序抵扣并存快照（S11）；不做按时间回溯重算                                                                             |
| 8   | D23 要求按国家汇总两个方向，但呼出国家来自费率行里手写的国家文本，呼入国家来自 `prefix_countries`；两处写法不一致（「英国」与「英国手机」那类问题，见 `rate-list-design.md` 3.1 第 5 项）会让同一国家出现两行                                                                                                                                              | 汇总按（方向，国家）分开，不跨方向合并（S19）；`prefix_countries` 的国家名要与费率表保持一致，导入时没有强制校验              |
| 9   | D19 的月租提前通知**只发管理员**，客户在停机前不会收到任何提示；一次欠费会让该租户全部号码（含免费、含呼入）同时停，影响客户的对外业务                                                                                                                                                                                                                     | 按用户决定。门户停机后显示横幅（S22）；`resolveDidNoticeRecipients` 留出加租户邮箱的位置。建议上线前由 Frank 约定人工提醒流程 |
| 10  | 事后核对「通话时租户是否停用」缺历史：`tenants.status` 只有当前值                                                                                                                                                                                                                                                                                          | 用当前值近似，在待办里注明（`tenant_disabled` 行）；要精确需新增状态历史表，本批不做                                          |
| 11  | **残余风险（偶发，不阻塞）**：运营商送**不带 `+`、不带 `00` 的外国**带国家码主叫（例如 `cc=86` 的 DID 收到主叫 `447700900123`）时，默认规则会变成 `86447700900123`，toll free 费率表通常有 `86` 行，可能命中大陆价格，国家也被判成中国。D33：国际来电基本带 `+` 或 `00`，所以只是偶发例外。同类的边界还有 `cc=7` 这类本国号码以国家码数字开头的情形（5.1） | 保留 `international_digits` 选项；话单保留原始 `caller`，可事后核对；PR 9 真实来电联调时抓 SIP 头核对。不作为上线阻塞项       |

## 11. 待确认事项

用户已逐项确认了原先的待确认事项，见第 1 节 D25–D33。下面只剩**线路同事**还没答复的 3 项。答复前按右栏实现，答复后只改配置或小处。

| #   | 问题                                                                        | 影响什么                                                                                                                                                                            | 答复前的做法                               |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | 运营商向我们收取 toll free 费用的依据                                       | `toll_free` 类别是按主叫前缀（含手机/固话）还是按别的维度；费率行的键；是否按接通时长或按振铃；是否有最低计费。若依据不是主叫前缀，`rate_entries` 的匹配键和 CSV 列要改             | 按 D2 的主叫前缀实现，PR 3、5 之前需要答复 |
| 2   | 真实报价单                                                                  | 三类费率的行结构、`60/60` / `1/1` 的实际分布、DID 套餐的合理字段（开通费、月租、含分钟是否足够表达）、国家与号段粒度、币种。D3 已声明结构暂定，收到报价单后先导入核对一遍再冻结迁移 | 暂定结构；PR 3 合并前核对                  |
| 3   | 呼出时我们转发给运营商的主叫号码格式（原样透传，还是必须是 `+86…` 或 `0…`） | 呼出 B 腿的 `caller_id_number` 是否要改写；PR 4                                                                                                                                     | 原样透传                                   |

D33 的答复（国际来电主叫基本带 `+` 或 `00`）已定稿；「基本」不是绝对，PR 9 真实来电联调时抓 SIP 头核对（第 9 节）。

## 12. 自定取值

用户没有逐项决定的取值。**用户 2026-11-06 已审阅、无异议**（D40）；编号被正文引用。S25 因多语言需求改为七列。

| #   | 取值                                                                                                                                                                                                                                                     | 理由                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S1  | DID 存规范号码 `^[1-9][0-9]{5,14}$`；匹配按 DID 自己的 `country_code`：有 `+`/`00` 取去冠字串；否则 A（原串）优先、B（逐个 DID 比较 `toCanonical(raw, did.country_code) = did.number`）其次；B 命中多个不同 DID 判歧义拒绝（呼入 404 加告警，呼出 403）  | 与 `billing_number` 同格式；不再把所有无冠字号码当大陆号码（5.1）                                  |
| S2  | DID 类型只有 `normal` / `toll_free`；线路、号码、类型创建后不可改                                                                                                                                                                                        | 它们决定费率类别和历史话单的含义                                                                   |
| S3  | 归属按通话开始时间判定，费率版本按接通时间                                                                                                                                                                                                               | 前者决定谁的电话，后者沿用现有规则                                                                 |
| S4  | 归属 `effective_from` 不得早于当前北京日 0 点，最晚 365 天后                                                                                                                                                                                             | 与费率版本的生效范围（`design.md` §6.3）一致，避免回填造成月租和额度补算                           |
| S5  | 呼入拒绝码：404 号码未登记或归属不一致；403 停用与 toll free 隐藏主叫；480 欠月租停机、余额不足、缺费率                                                                                                                                                  | 来电方是第三方，不泄露客户的账务状态，480 比 402 更通用；是否被运营商正确转译未核对                |
| S6  | 呼入放行的 `maxSeconds` 恒为 14400，超时放行 1800                                                                                                                                                                                                        | 对应 D10；超时沿用 `design.md` §4.2                                                                |
| S7  | 普通 DID 没有匹配的 `inbound` 费率行：拒绝（480）并告警；toll free DID 找不到主叫前缀行归入「无法识别」，拒绝（403）不告警；指派 DID 时界面警示该租户该线路没有对应费率行                                                                                | 无费率的来电事后无法计费，只能停放；前者是配置缺失，后者是来电方的问题                             |
| S8  | 隐藏主叫 = 空、`anonymous`、`unknown`、`restricted`、`unavailable` 或去掉 `+` 后不是 5–15 位纯数字                                                                                                                                                       | 隐藏主叫非常罕见（D33），判定从宽即可；`caller_number_format` 默认值是已决定的 D32，不再是自定取值 |
| S9  | 每通话 `charge` 写入时取 6 位 `ROUND_HALF_UP`，此后不重算；`billed_seconds` 为计费依据，`billed_minutes` 只是展示                                                                                                                                        | 保证账本、账单、话单三处完全一致                                                                   |
| S10 | 含分钟抵扣量向下对齐到该费率行周期的步长（`60/60` 为 60 的倍数，`1/1` 为 1 秒）；`rate = 0` 的通话不消耗额度                                                                                                                                             | `60/60` 通话不出现非整分钟的付费；D16 只说「收费通话」                                             |
| S11 | 额度按入库顺序抵扣                                                                                                                                                                                                                                       | 简单且确定；回溯重算会改动已入账的话单                                                             |
| S12 | 含分钟数以整秒存储；开通月含分钟按 `floor(分钟 × 剩余天数 / 当月天数)` 取整分钟，剩余天数含开通当天                                                                                                                                                      | 客户看到整数分钟；向下取整是保守的一侧                                                             |
| S13 | 开通月月租按 `round2(月租 × 剩余天数 / 当月天数)`                                                                                                                                                                                                        | 金额到分，账本和账单好对                                                                           |
| S14 | 费用流水类型 `did_activation_fee`、`did_monthly_fee`，`occurred_at` 取写入时间，幂等键 `did-activation:<归属>`、`did-monthly:<归属>:<月>`                                                                                                                | 补扣不污染已生成的账单月份                                                                         |
| S15 | `toll_free` 类型 DID 的隐藏主叫一律拒绝，按类型而非费率值                                                                                                                                                                                                | 实现简单、可预期（[10](#10-矛盾与风险) 第 5 项）                                                   |
| S16 | 月租判断用「余额 + 透支额度」，同一租户全有或全无                                                                                                                                                                                                        | 与授权的可用额度口径一致；避免部分号码被停                                                         |
| S17 | 零费率的呼出也不看余额                                                                                                                                                                                                                                   | 与呼入一致（[10](#10-矛盾与风险) 第 4 项）                                                         |
| S18 | 门户首页「本月消费」仍只算通话扣费（沿用 `design.md` §7.7），新增「本月号码费用」                                                                                                                                                                        | 不改变已有口径                                                                                     |
| S19 | 国家汇总按（方向，国家）分行，不合并                                                                                                                                                                                                                     | 避免国家名不一致造成拆行                                                                           |
| S20 | 任务：`did-fees` 每天 00:05，`did-fee-tick` 每分钟，提前通知 09:00；通知日期为下月 1 日减 3 天和减 1 天                                                                                                                                                  | 在分区维护（00:00）之后、账单生成（02:00）之前；09:00 管理员能看到                                 |
| S21 | 停机满 3 个月（累计 3 个月月租未付）时开 `did_suspension_long` 告警（`notify = true`），不自动回收；回收（退号）不取消已欠的费用；停用的租户仍扣月租                                                                                                     | D30 只说「满 3 个月告警」；告警走现有机制；号码被占用就产生费用，与手动「停用」互不影响            |
| S22 | 门户在欠月租停机时显示横幅；停机与恢复邮件复用 `did_suspended` 告警，不新增模板                                                                                                                                                                          | 客户可见的唯一提示（D19 只规定通知管理员）；复用现有告警邮件的开始/恢复                            |
| S23 | 停机只拒新呼叫，不切断进行中的通话                                                                                                                                                                                                                       | 与现有停用一致                                                                                     |
| S24 | 「门户已有线路」= 租户当前至少有一个 DID 的线路                                                                                                                                                                                                          | 没有 DID 的线路不能呼叫，展示费率没有意义                                                          |
| S25 | 费率 CSV 七列，顺序 `ISO, Country, Destination Prefix, Description, Description (EN), Rate, Billing Cycle`；「计费周期」列必填，值 `60/60` 或 `1/1`；旧五、六列文件不再接受；表头中英文别名都接受（i18n 文档 9.2）                                       | 与 `rate-list-design.md` D4 的做法一致，避免静默默认；`Description (EN)` 由 i18n 批 I7 引入        |
| S26 | 号码表由 Worker 导出、服务器 A 每 60 秒拉取；10 分钟未更新告警；租户 → PBX 目标留在 FreeSWITCH                                                                                                                                                           | 保持 A 到 B 的信任方向；PBX 目标是租户级一次性配置                                                 |
| S27 | 呼入并发上限用租户级变量 `billing_inbound_concurrency`，放在 `inbound-authorized` 的 `limit`                                                                                                                                                             | 原来按号码写 `limit`（`trunk-inbound.xml.example`），号码表改为动态后不能再按号码配置              |
| S28 | 授权在额度行缺失时按条款现算、不写库；入库在租户锁内由 `ensureMonthDue` 创建额度行                                                                                                                                                                       | 不让 00:00–00:05 的通话被误拒，也不白白失去额度                                                    |
| S29 | 事后核对的三类原因（租户停用、欠月租停机、通话开始时余额不足）及其判定依据（[5.5](#55-未验证话单的事后处理)）；归属不一致和 toll free 主叫无法识别直接停放并计入 `did_noncompliant`                                                                      | 用现有数据能判定的最大集合                                                                         |
| S30 | 旧 Lua 对新 Worker 的兼容不做：合并 PR 4 时同时切 Worker 和 Lua                                                                                                                                                                                          | 没有正式客户，内部测试可接受短暂中断                                                               |
| S31 | 金额为 0 的应收（开通费或月租为 0）创建时即置 `paid`，不写流水                                                                                                                                                                                           | 流水金额必须为负（`ledger_entries_kind_shape`）；保留应收行以保持幂等和额度行                      |
| S32 | 归属在开通单元付清之前不生效；开通日以 `effective_from` 的北京日期为准，延迟付款不改变比例                                                                                                                                                               | 规则简单可预期；代价是延迟付款期间客户为没有服务的天数付费（D29 的排定生效路径）                   |
| S33 | 套餐条款变更只能从下月 1 日起生效，用追加表 `did_term_changes`，开通费不变                                                                                                                                                                               | 当月不重复收费、不重复发额度；不需要给 `did_assignments` 加版本                                    |
| S34 | 国家码放在 `dids.country_code`（必填、创建后不可改、`number` 必须以它开头），线路不带国家码；呼入线路由来电入口（每线路一个 profile 和 context）确定，Worker 核验；呼出主叫在租户自己的 DID 中匹配；新增 DID 时界面按前缀国家表建议国家码，由 Frank 确认 | 用户两条原话都是按**号码**说的；一条线路承载多国也能正确处理；歧义拒绝而不猜                       |
| S35 | 前缀国家初始数据（D28）由加载器 `INSERT … ON CONFLICT DO NOTHING` 加载，CSV 放 `packages/db/data/prefix-countries.csv`，每行带 `source` 列（不入库）供评审核对；共用前缀按最长前缀，共用行 ISO 留空                                                      | Frank 的修改永远不被重新加载覆盖；本文不生成数据                                                   |
| S36 | PR 3–5 之间的临时兼容路径及删除时机（见 9）；号码规则（`toCanonical`）在 PR 4 里授权与入库同时切换                                                                                                                                                       | 保证每个 PR 合并后 main 可用，且授权与入库不会不一致                                               |
| S37 | `toCanonical` 规则 2：无冠字、以所匹配 DID 的 `cc` 开头、其后 6–12 位且不以 `0` 开头、总长 ≤ 15，视为已带国家码，不重复补全；主叫（呼入）与被叫（呼出）共用                                                                                              | 避免 `8613800138000` 变成 `868613800138000`；已知误判边界见 5.1（`cc=7` 等）                       |
| S38 | `cdrs.billing_number` 改为可空，仅用于未接通且主叫没匹配到 DID 的被拒话单                                                                                                                                                                                | 被叫无法规范化时不编造号码（5.1）                                                                  |

**之后新增（i18n 批和门户号码页合并相关，尚未审阅）：**

| #   | 取值                                                                                                | 理由                                  |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| S39 | 门户 `GET /api/portal/rates` 用 `billingUnit`（`minute` / `second`）表示周期，不暴露 `60/60`、`1/1` | D39；客户界面只需要「按分钟 / 按秒」  |
| S40 | 门户导航只加「号码」，访问 `/portal/rates` 得到 404 页面                                            | D38；没有旧的门户费率页，不需要重定向 |
| S41 | `dids.country_en` 写入时由服务端按 ISO、再按前缀国家表填；`lines.name_en` 为空时英文界面回落中文名  | 与 i18n 文档 11.2、11.3 一致          |
| S42 | 本批迁移不写编号，按合并顺序排在 i18n 批迁移之后                                                    | i18n 批先做                           |

## 13. 没能核对的内容

- FreeSWITCH 对匿名主叫（`Privacy: id`、`From: anonymous`）实际写入的 `caller_id_number` 和相关变量；
- 呼出时客户 PBX 实际送来的主叫格式（受 directory 的 `effective_caller_id_number` 影响）；
- 运营商对 480 / 403 / 404 的处理（是否改道重试、客户听到什么）；
- Debian 13 的 `postgresql-17` 是否自带 `btree_gist`（本文未使用）；
- `fs_heartbeat` 告警 kind 能否直接承载号码表同步的心跳（`apps/worker/src/clock.ts` 的实现只核对到心跳超时开告警）；
- `apps/web` 里 `shadcn add` 所需的注册表与当前 `components.json` 配置是否一致（只确认了文件存在）；
- 授权 p95 在新的按需读取方案下的数值（需 PR 4 实测）；
- `packages/db/data/prefix-countries.csv` 的数据（尚无，D28 规定的来源要在 PR 2 逐条核对）；
- `toCanonical` 规则 2 里 6–12 位的范围没有按各国号码长度逐一核对；
- 英国等非大陆线路上客户 PBX 实际送来的国内格式主叫、被叫（只按 DID 国家码做了设计，没有真实样本）；
- 外部 CLI（OpenCode，DeepSeek V4.1 flash）能否在本机稳定完成 `pnpm test:db`（需要 Docker 里的 PostgreSQL 和 Mailpit）：没有核对；`apps/web/e2e` 在 CLI 环境能否运行同样没有核对；
- 本文所有 SQL 为设计草稿，没有在 PostgreSQL 上执行过。
