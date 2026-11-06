# 多语言（中文 / 英文）设计

本文写于 2026-11-06，依据 `origin/main`（`5fff74e`，#124）。路径、函数名、数字都在这个提交上核对过；核对不到的写「未核对」。需求由用户于 2026-11-06 确认。与 [did-inbound-design.md](did-inbound-design.md)（DID 与呼入计费，下称「DID 文档」）配套：本批先做，DID 批的新页面从一开始就用本文的框架写。

**结论。** 网站（客户门户和管理后台）做中英文双语，推翻 `design.md` §2.2 的「多语言（只用中文）」。用 **react-i18next** 做框架，文案目录放在 `packages/shared/src/i18n/`（只放数据，shared 仍只依赖 zod）；服务端不再返回写死的中文：错误用错误码加文案键，前端翻译；CSV 导出由请求带的 `locale` 决定表头；语言偏好存在 `portal_accounts` 和 `admins` 上；客户邮件在**入队时**按账号语言定下，管理员告警邮件继续用中文。现状有 103 个前端文件（2,063 行）要迁移，服务端和共享包另有校验消息 72 行、挂断原因 46 项、13 个错误码的中文 `message`、CSV 表头和 2 个客户邮件模板，拆成 9 个 PR（I1–I9），顺序见 [12](#12-pr-拆分与验收)。DID 批在 I1–I7 合并后开始。有 6 个问题还没定，见 [14](#14-待确认事项)，每项都给了推荐；自定取值见 [15](#15-自定取值)。

## 1. 已决定（用户，2026-11-06）

| #   | 决定                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | 客户门户和管理后台都做英文                                                                                                                    |
| L2  | 默认按浏览器语言，页面上可切换，选择记在账号上                                                                                                |
| L3  | 发给客户的邮件（余额提醒、停机通知等）按客户账号的语言发；发给管理员的告警继续用中文                                                          |
| L4  | 后台录入、对客户可见的内容要有英文：国家名用 ISO 代码对应的标准英文名；说明新增一列英文。这也影响费率 CSV 和前缀国家表                        |
| L5  | 导出的 CSV 和账单跟随当前界面语言                                                                                                             |
| L6  | 日期格式跟随语言；业务日期仍按北京时间，英文界面标明时区                                                                                      |
| L7  | 顺序：先做多语言框架和现有页面的英文，再做 DID 的新页面；新页面从一开始就用多语言写。第一个付费客户前全部完成                                 |
| L8  | 实现由外部 CLI（OpenCode，DeepSeek V4.1 flash）完成，所以 PR 说明必须能让没有本次对话上下文的开发者独立照着做；服务器和联调步骤由主管会话处理 |

被推翻的现有文字：`docs/design.md` 第 33 行（§2.2「多语言（只用中文）」）；`docs/pages.md` 第 20 行和第 37 行（界面语言为简体中文）。PR I9 改这两处。

## 2. 现状核对

统计口径：`.ts`/`.tsx` 文件，不含 `*.test.*`、`test/`、`e2e/`；「代码行」指含汉字且不是纯注释的行；用脚本数出，数字在 `5fff74e` 上有效。

### 2.1 前端 `apps/web/src`

| 项目                                                 | 数字                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 非测试 ts/tsx 文件                                   | 148 个；含汉字的 **131 个**（含注释），代码里含汉字的 **103 个**，共 **2,063 行**                                                                                                                                                                      |
| 按目录（文件 / 行）                                  | `pages/admin` 19 / 871；`components/admin` 22 / 526；`lib` 19 / 183；`pages` 顶层 7 / 109；`pages/portal` 6 / 121；`components` 顶层 15 / 95；`components/cdr` 7 / 93；`components/statement` 5 / 55；`components/portal` 1 / 7；`components/ui` 2 / 3 |
| 属性文字（`aria-label` `title` `placeholder` `alt`） | 214 处含汉字                                                                                                                                                                                                                                           |
| shadcn 组件里的文字                                  | `components/ui/sheet.tsx` 第 79 行的 `<span className="sr-only">关闭</span>`，其余是注释                                                                                                                                                               |
| 已经是「错误码 + 前端文案」的                        | `lib/api-problem.ts`：`conflictMessages` 23 项、`mailSettingsMessages` 4 项                                                                                                                                                                            |
| 格式化                                               | `lib/format.ts`：`formatMonth` 写死 `${year}年${month}月`，`formatBilledMinutes` 写死「分钟」，`formatRate` 写死「元/分钟」「/分钟」；日期用 `beijingDateTimeParts` 手工拼 `YYYY-MM-DD HH:mm:ss`。整个 `apps/web/src` 没有用 `Intl` 或 `toLocale*`     |
| 自写的日期组件                                       | `components/month-field.tsx`、`components/date-range-field.tsx`（月份、星期名）；图表 `components/daily-spend-chart.tsx`（「最近 30 天没有消费」等）；这些不是 shadcn 原生组件，本批只翻译文字，不重写                                                 |
| 页面外壳                                             | `apps/web/index.html` 第 2 行 `<html lang="zh-CN">`；主题偏好存 `localStorage`（`lib/theme.ts`，键 `fs-billing.theme`，首屏脚本在 `index.html`）——语言偏好沿用这个模式                                                                                 |
| 打印                                                 | `style.css` 第 204 行起的 `@media print` 只隐藏导航和按钮，没有文字；账单打印的文字就是页面文字，随界面语言                                                                                                                                            |

### 2.2 测试对中文的依赖

| 位置                                                | 数字                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/web/src` 测试                                 | 54 个文件含汉字，共 2,553 行                                                        |
| `apps/web/e2e`                                      | 37 个文件全部含汉字，共 2,062 行；`playwright.config.ts` 第 17 行 `locale: 'zh-CN'` |
| `packages/shared`、`packages/rating`、`packages/db` | 测试含汉字的文件 15 / 7 / 51 个（186 / 83 / 1,243 行）                              |
| `apps/api`、`apps/worker`                           | 25 个（311 行）/ 20 个（495 行）                                                    |

处理原则：**测试默认在中文下运行**（Vitest 的 `src/test/setup.ts` 固定语言为 `zh`，Playwright 保持 `zh-CN`），所以已有测试在 I1–I9 里**不需要改断言**；新增英文用例另写。好处是每个迁移 PR 的中文行为可由原有测试锁住。

### 2.3 服务端与共享包

| 位置                                                              | 现状                                                                                                                                                                             | 处理                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/shared/src`                                             | 22 个文件含汉字代码，191 行；其中校验消息 `message:` 72 行（19 个文件）                                                                                                          | 校验消息改为文案键（[5](#5-错误信息)）                                   |
| `packages/shared/src/hangup-cause.ts`                             | `HANGUP_CAUSE_LABELS` 46 项中文                                                                                                                                                  | 进文案目录，按 `locale` 取                                               |
| `packages/shared/src/api/ledger-merge.ts`、`api/portal/ledger.ts` | `formatMergedChargeNote`（「通话扣费，共 N 通」）；`PORTAL_CREDIT_RECHARGE_NOTE = '账户充值'`（第 10 行）是 API 返回给门户的文字                                                 | 加 `locale` 参数；系统备注改为返回文案键                                 |
| `packages/shared/src/mail/templates.ts`                           | 399 行，75 行含汉字；6 个模板：`balance_low`、`balance_suspended`（**发客户**），`alert_start`、`alert_digest`、`alert_recovered`、`test`（发管理员）；`ALERT_KIND_LABELS` 15 行 | 客户模板双语，管理员模板不动（[8](#8-邮件)）                             |
| `packages/rating/src/csv.ts`                                      | 33 行；行错误是拼好的中文句子（`前缀只能是数字：…`）；表头别名 `HEADER_ALIASES` 含中文表头 `ISO,国家,号码前缀,说明,费率`                                                         | 行错误改为 `{line, key, params}`；表头别名扩展（[9](#9-csv-导出与导入)） |
| `apps/api/src`                                                    | 11 个文件，107 行。`errors.ts` 的 `messages` 是 13 个错误码对应的中文，随响应返回；`routes/exports.ts` 32 行含汉字（CSV 表头、「呼入/呼出」）；`export/statement-csv.ts` 14 行   | `message` 改英文技术说明，前端按 `code` 翻译；CSV 表头按 `locale`        |
| `apps/worker/src`                                                 | 16 个文件，137 行：停放原因（`unassigned_cdrs.reason` 的值是中文，如「租户不存在」「号码格式错误」）、告警说明、`mail.ts` 的 `TEMPLATE_LABELS`                                   | 面向管理员的诊断文字，见 [14](#14-待确认事项) 第 5 项                    |
| `packages/db/src`                                                 | 52 个文件，290 行：内部异常消息、停放原因、审计的 `target`/`details`                                                                                                             | 不是界面文字，不翻译；API 已经把它们映射成错误码                         |
| `packages/mailer/src/mail.ts`                                     | `MAIL_FROM_NAME = 'FS-Billing 计费系统'`（第 11 行）                                                                                                                             | 客户邮件按语言取发件人显示名                                             |

### 2.4 存在数据库里的中文

这些是**数据**，不是代码文案，翻译方式不同：

| 数据                                                                         | 谁看到       | 处理                                                         |
| ---------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------ |
| `rate_entries.country`、`description`；`cdrs.country`、`description`（快照） | 客户和管理员 | 新增英文列（[11](#11-英文内容字段与数据模型)）               |
| `monthly_statement_countries.country`                                        | 客户和管理员 | 新增英文列                                                   |
| `ledger_entries.note`（手工充值、赠送、调账备注）                            | 客户（部分） | Frank 自己写；本批不加英文列（[14](#14-待确认事项) 第 5 项） |
| 告警说明、`unassigned_cdrs.reason`、审计日志                                 | 仅管理员     | 枚举类翻译，自由文本保留中文（[14](#14-待确认事项) 第 5 项） |
| 租户名称、联系人                                                             | 管理员       | 专有名词，不翻译                                             |

## 3. 多语言库

| 方案                      | 优点                                                                                                                                                                     | 缺点                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **react-i18next**（推荐） | 文案键 + TypeScript 资源类型：键写错在编译期报错；英文复数（`_one`/`_other`）和插值内置；`Trans` 处理句中加粗、链接；同一引擎能在 Node 里用（API 的 CSV、Worker 的邮件） | 运行时依赖两个包（web）；ICU 消息格式需要额外插件（本批用不上）                                                                              |
| react-intl（FormatJS）    | ICU 标准；日期、数字、复数用 `Intl`；`formatjs` 命令行能在 CI 里检查缺失                                                                                                 | 消息 id 默认是字符串，键没有编译期检查；React 之外要手动 `createIntl`，服务端 CSV 和邮件要另外接线                                           |
| Lingui                    | 编译期提取，运行时很小，CI 能检查缺失译文                                                                                                                                | 依赖宏（Babel/SWC 插件）；本项目用 Vite 8 + `@vitejs/plugin-react` 6 + Vitest 5，宏的兼容**未核对**；以源文本做键，不符合「键 + 目录」的目标 |
| 自写类型化字典（零依赖）  | 和项目风格一致（金额也是自写）；约 100 行；shared、API、Worker、web 同一份代码                                                                                           | 插值、复数、`Trans` 要自己写；没有生态工具；以后维护成本落在项目自己                                                                         |

**推荐 react-i18next**，结合本项目的理由：

1. 前端是 React 19 + TypeScript strict，键的编译期检查能直接防住漏翻译、拼错键；
2. 英文需要复数（「1 call / 2 calls」），中文不需要，库内置按语言取复数形式；
3. 服务端也要翻译：API 导出 CSV（`routes/exports.ts`）、Worker 渲染邮件（`apps/worker/src/mail.ts`）。同一个引擎在 Node 里用 `createInstance()` 即可，不需要第二套机制；
4. `design.md` §16 规定 `packages/shared` 只依赖 zod，所以**库不进 shared**：shared 只放文案数据（普通 TS 对象）和 `Locale` 类型；`i18next` 装在 `apps/web`、`apps/api`、`apps/worker`；`renderMail` 保持纯函数，翻译函数从 `RenderContext` 传入（依赖注入），测试里传假翻译器；
5. 如果用户更看重零依赖，自写类型化字典是可行的后备方案；换库只影响 `apps/*/src/i18n/` 里的适配层，文案目录不变。

版本：按项目惯例固定精确版本（`apps/web/package.json` 里的包都是精确版本，如 `@tanstack/react-query 5.104.2`）。开工时核对 react-i18next 与 React 19、i18next 与 Node 24、Vite 8 的兼容声明；**本文没有核对**这些版本（[16](#16-没能核对的内容)）。

## 4. 文案目录、键与 CI 检查

### 4.1 目录结构

```
packages/shared/src/i18n/
  index.ts          LOCALES = ['zh', 'en'] as const；Locale；DEFAULT_LOCALE = 'zh'；isLocale()
  types.ts          DeepSameShape<A, B>（英文目录必须与中文目录同形）
  iso-countries.ts  ISO 3166-1 alpha-2 → 英文名（见 11）
  zh/index.ts       import 各命名空间，导出 zh
  zh/common.ts      按钮、状态、通用词
  zh/auth.ts        登录、改密码、会话
  zh/portal.ts      门户页面
  zh/admin.ts       后台页面
  zh/cdr.ts         话单筛选、详情、汇总
  zh/statement.ts   月账单
  zh/rates.ts       费率表、导入、复制
  zh/errors.ts      错误码、冲突、校验、CSV 行错误
  zh/enums.ts       挂断原因、告警类型、状态标签、租户健康、流水类型
  zh/csv.ts         CSV 表头、「呼入/呼出」等值
  zh/mail.ts        客户邮件（balance_low / balance_suspended）
  zh/did.ts         DID 批新增（线路、号码、套餐、月租）——DID 批各 PR 往里加
  en/…              与 zh 一一对应
```

- 键用命名空间 + 点号路径，`namespace:section.name`，例如 `rates:import.errors.prefixDigits`。路径用小驼峰，不用中文拼音。
- 插值用 `{{name}}`；数量用 `{{count}}` 加复数后缀：英文 `items_one` / `items_other`，中文只写 `items_other`。
- 句中有加粗或链接的消息用 `Trans`，在目录里写 `<b>…</b>` 标签。
- 金额、日期、号码**不**放进目录，由格式化函数生成后作为插值传入（[7](#7-日期数字金额)）。
- 语言名「中文」「English」写在切换菜单里，用各自的原文，不翻译。

### 4.2 类型与检查

1. **编译期**：`zh` 是权威。`export const en: DeepSameShape<typeof zh> = …` 让英文目录与中文目录键完全一致，缺一个就编译失败。复数后缀是例外：类型把 `_one`、`_other` 视为同一个基键，英文可有两项，中文一项。
2. **键类型**：在 `apps/web`、`apps/api`、`apps/worker` 各声明 `declare module 'i18next' { interface CustomTypeOptions { resources: typeof zh } }`，`t('rates:import.errors.prefixDigits')` 的键错了会在 `tsc` 报错。
3. **目录测试** `packages/shared/src/i18n/catalog.test.ts`（I1 新建）：英文与中文基键集合相同；每个键两种语言的 `{{…}}` 占位符集合相同；英文值不含汉字；英文值不是空串（`allowEmptyEn` 白名单里的除外，初始为空）；中文值不含「TODO」。
4. **未使用的键**：`scripts/i18n-unused.ts`（I9 新建）扫描 `t('…')` 的字面量，列出目录里没人引用的键；动态键用 `// i18n-dynamic: <命名空间前缀>` 注释声明。只报告，不让 CI 失败。
5. **写死中文的检查**（棘轮）：`tooling/eslint/guardrails.ts` 加 `i18nRestrictedSyntax`，禁止在 `apps/web/src/**` 的字符串字面量、模板字符串、JSX 文本里出现汉字，`i18n/` 目录和 `*.test.*` 除外；现有含汉字的 103 个文件列在 `tooling/eslint/i18n-allowlist.json`，每个迁移 PR 把迁完的文件从名单里删掉，I9 要求名单为空。规则本身有测试 `tests/i18n-rule.test.ts`，写法参照 `tests/ledger-rule.test.ts`。
6. **英文界面不含中文**：I9 新增 Playwright 用例 `apps/web/e2e/i18n-en.spec.ts`，在 `locale: 'en-US'` 下逐页打开门户和后台主要页面，断言页面文字里没有汉字。夹具数据用拉丁字母的租户名和英文国家名，所以断言的是界面文字，不是数据。

## 5. 错误信息

现状：API 已经返回错误码（`packages/shared/src/api/errors.ts` 的 13 个码），但 `message` 是中文（`apps/api/src/errors.ts` 的 `messages`）；管理端冲突 23 个、邮箱设置 4 个已经由前端按码翻译（`lib/api-problem.ts`）。缺口是三类：**校验问题**（`ValidationIssue.message`，来自 shared 里 72 行 Zod 自定义消息）、**CSV 行错误**（`rating/csv.ts`）、**少数页面直接显示 `message`**。

| 类别             | 改法                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 错误码 `message` | 保留字段（契约要求非空），内容改成**英文技术说明**，不随语言变化。前端永远按 `code` 取目录文案，不显示 `message`                                                                                                  |
| 校验问题         | `validationIssueSchema` 增加 `key`（目录键）和可选 `params`；Zod 的自定义 `message` 改为键字符串（如 `validation.rate.maxFourDecimals`），`message` 同时保留英文技术说明。前端 `issueText(issue, t)` 优先用 `key` |
| CSV 行错误       | `CsvError` 由 `{line, message}` 改为 `{line, key, params}`（`packages/rating/src/csv.ts`），`AdminCsvRowError`（`packages/shared`）同步；`csv-rejected` 同理                                                      |
| 冲突、邮箱设置   | 目录从 `lib/api-problem.ts` 搬到 `errors.ts` 命名空间；`conflictMessages`、`mailSettingsMessages` 删除                                                                                                            |
| 系统备注（流水） | 门户流水里 `credit_recharge` 的备注由常量文字改为 `noteKey: 'ledger.accountRecharge'`；手工备注仍是原文。DID 批的号码费用流水由 `kind` 加 DID 号码和月份在显示时生成备注，不依赖存库的中文备注                    |
| 数据库内部异常   | 不翻译；仍由 `mapBusinessErrors`（`apps/api/src/routes/business-errors.ts`）映射成错误码                                                                                                                          |

兼容：I2 同时保留旧的中文 `message`/`note` 字段到 I9，避免前后端不同步合并时出错；I9 删掉。

## 6. 语言偏好

### 6.1 存储

迁移（PR I3）：

```sql
ALTER TABLE portal_accounts ADD COLUMN locale text CHECK (locale IN ('zh', 'en'));
ALTER TABLE admins          ADD COLUMN locale text CHECK (locale IN ('zh', 'en'));
```

可空：`NULL` 表示还没选过，按浏览器。`packages/db/src/schema.ts` 的 `portalAccounts`、`admins` 同步。应用角色对这两张表已有 `UPDATE`（`0000_init.sql` 的授权）。租户身份没有写权，所以更新和 `last_login_at` 一样由 API 用 `withAdmin` 写（`apps/api/src/identity.ts` 第 76–79 行的做法），`WHERE` 条件取自会话身份的 `profileId`，**不信任请求参数里的 id**。

`packages/shared/src/api/identity.ts` 的 `adminIdentitySchema`、`customerIdentitySchema`（都是 strict）各加 `locale: z.enum(LOCALES).nullable()`；`GET /api/auth/session` 因此带回语言。新增 `POST /api/auth/locale`（`packages/shared/src/api/contract.ts` 里 `/api/auth/*` 一组），请求 `{ locale }`，门户和后台共用。

### 6.2 决定语言的顺序（前端）

1. 已登录且账号 `locale` 非空：用账号的，并写入 `localStorage`；
2. 否则 `localStorage` 键 `fs-billing.locale`（主题偏好用同样的模式，读写都 `try/catch`）；
3. 否则 `navigator.languages` 中第一个：以 `zh` 开头 → `zh`，其他 → `en`；
4. 都没有 → `zh`（`DEFAULT_LOCALE`）。

登录前（登录页、忘记密码提示）只有 2–4：切换只写 `localStorage`。登录成功后：账号有 `locale` 就用账号的；账号为 `NULL` 就把当前语言通过 `POST /api/auth/locale` 写入一次（「默认按浏览器语言，记在账号上」）。已登录时切换：先更新界面，再 `POST`，失败只提示不回滚。账号换设备后以账号为准。

`<html lang>` 随语言变（`zh-CN` / `en`）；首屏脚本（`index.html`）读 `localStorage` 先设 `lang`，避免闪烁。

## 7. 日期、数字、金额

| 项目             | 中文（不变）                     | 英文                                                                     |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------ |
| 日期时间         | `2026-09-29 14:03:22`            | `29 Sep 2026 14:03:22`                                                   |
| 日期             | `2026-09-29`                     | `29 Sep 2026`                                                            |
| 月份             | `2026年9月`                      | `Sep 2026`                                                               |
| 时区             | 北京时间                         | 表头和详情里标明 `Beijing time (UTC+8)`，表格每个单元格不重复            |
| 时长             | `3分50秒`、`4分钟`               | `3m 50s`、`4 min`                                                        |
| 费率单位         | `0.0450 元/分钟`、`$0.0120/分钟` | `¥0.0450/min`、`$0.0120/min`                                             |
| 金额             | `¥1,234.56`、负号在符号前        | 同样；千分位逗号、小数点不随语言变                                       |
| 计费周期（门户） | `按分钟` / `按秒`                | `Per minute` / `Per second`（DID 批；后台两种语言都显示 `60/60`、`1/1`） |

- 业务日期、月份归属、统计一律仍按北京时间（`design.md` §12），语言只改**写法**。`packages/shared/src/api/beijing-time.ts` 的 `beijingDateTimeParts` 继续是唯一来源；`lib/format.ts` 的各函数增加 `locale` 参数（或读当前语言），**不改用 `Intl.DateTimeFormat` 的时区转换**，因为后者依赖运行环境的时区数据且与现有「北京时间固定 UTC+8」的测试口径不同。
- 金额格式化继续用 `lib/format.ts` 的 `formatMoney`（`decimal.js` 四舍五入，ESLint `money/no-number-money` 覆盖）；**不使用 `Intl.NumberFormat`**，避免出现欧洲式的逗号小数或不同的负号。语言只影响单位文字。
- 图表和日期组件（`daily-spend-chart.tsx`、`month-field.tsx`、`date-range-field.tsx`）的月份、星期名从目录取。

## 8. 邮件

| 模板                                                                                | 收件人 | 语言                         |
| ----------------------------------------------------------------------------------- | ------ | ---------------------------- |
| `balance_low`、`balance_suspended`                                                  | 客户   | 按客户账号语言：`zh` 或 `en` |
| `alert_start`、`alert_digest`、`alert_recovered`、`test`；DID 批的 `did_fee_notice` | 管理员 | 一律中文（L3）               |

**入队时定语言还是发送时定语言？推荐入队时定。**

| 方案           | 做法                                                                           | 优点                                                                                    | 缺点                                                                                   |
| -------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 入队时（推荐） | `email_outbox` 加 `locale` 列，入队时写入；`renderMail` 按行上的 `locale` 渲染 | 与现有「收件人、`params` 都是入队时的快照」一致；重试多次语言不变；发送时不用再查账号表 | 入队后客户改了语言，这封仍用旧语言（最长是退避重试的几小时）                           |
| 发送时         | 分发时按租户查 `portal_accounts.locale`                                        | 永远是最新偏好                                                                          | 分发器要多一次查询并处理账号不存在；同一封邮件重试前后语言可能不同；渲染不再只依赖快照 |

具体改法（PR I8）：

1. 迁移：`ALTER TABLE email_outbox ADD COLUMN locale text NOT NULL DEFAULT 'zh' CHECK (locale IN ('zh','en'))`；管理员邮件和历史行得到 `zh`。
2. 余额通知由**数据库触发器**入队：`enqueue_balance_notice`（`0023_balance_notices.sql` 创建，`0024_suspended_at.sql` 引用）。用新迁移 `CREATE OR REPLACE` 重建它，在插入时取 `locale`：`SELECT locale FROM portal_accounts WHERE tenant_id = p_tenant_id`（`portal_accounts.tenant_id` 唯一），`NULL` 或没有账号时取 `'zh'`。保留原来的 `REVOKE ALL … FROM PUBLIC`。去重键、`params` 形状（strict）都不变。
3. `packages/db/src/outbox.ts` 的 `EnqueueEmailInput` 加可选 `locale`（默认 `zh`），`emailOutbox` 的 Drizzle 定义同步。
4. `packages/shared/src/mail/templates.ts`：`RenderContext` 加 `locale` 和 `t`（翻译函数，依赖注入）；`balance_low`、`balance_suspended` 的正文进 `mail.ts` 命名空间；管理员模板不动。`apps/worker/src/mail.ts` 第 161 行附近传 `locale: email.locale`、`t: translatorFor(email.locale)`。
5. 发件人显示名：`packages/mailer/src/mail.ts` 的 `MAIL_FROM_NAME` 改为按语言取（中文 `FS-Billing 计费系统`，英文 `FS-Billing`），客户邮件用对应语言，管理员邮件用中文。
6. 金额和日期在邮件里：金额沿用 `CNY 100.00` 写法（`amount()`，两种语言相同）；时间沿用北京时间，英文写 `2026-10-29 14:03 Beijing time (UTC+8)`（邮件里用数字日期，避免月份名歧义）。
7. DID 批会改 `balance_suspended` 的正文（呼出和收费来电被拒，免费来电不受影响），两种语言的文案由 DID 批 PR 6 同时改。

## 9. CSV 导出与导入

### 9.1 导出

- 所有导出请求（话单、流水、账单汇总与明细、费率）带 `locale`（`zh` 或 `en`，缺省 `zh`）。前端传**当前界面语言**，不是账号语言。契约在 `packages/shared/src/api/` 各 `*ExportRequestSchema`（`portalCdrExportRequestSchema`、`adminCdrExportRequestSchema`、`portalLedgerExportRequestSchema` 等）里加字段。
- 变的只有**表头和系统生成的值**：`routes/exports.ts` 的 `cdrHeaders`、`directionLabel`（呼入/呼出 → Inbound/Outbound）、验证状态；`export/statement-csv.ts` 的汇总表头；`formatHangupCause`、`formatMergedChargeNote`。
- 日期、数字在 CSV 里**两种语言都用机器友好格式**（`YYYY-MM-DD HH:mm:ss`、小数点、不带千分位），方便 Excel 和重新导入；英文表头标明时区，如 `Answer time (Beijing time)`。
- 文件名 `exportFilename`（`packages/shared/src/api/export.ts` 第 19 行）不含语言，不变。
- 编码仍是带 BOM 的 UTF-8；中文数据在英文 CSV 里照样存在（例如国家名列）。

### 9.2 费率 CSV（导出与导入必须能往返）

列（I7 起）：`ISO, Country, Destination Prefix, Description, Description (EN), Rate`。DID 批再加第 7 列 `Billing Cycle`（`did-inbound-design.md` 的 PR 3）。

- **导出表头随语言**：中文 `ISO,国家,号码前缀,说明,说明(英文),费率`，英文 `ISO,Country,Destination Prefix,Description,Description (EN),Rate`。**单元格是数据，不翻译**：`Country` 列仍是存库的中文名（英文名由 ISO 派生，不在 CSV 里）。
- **导入接受两种语言的表头，也接受混写**：对每个表头单元格用别名表规范化（去空白、忽略大小写，`Destination Prefix`/`Destination Prefixes`/`号码前缀`、`Description (EN)`/`说明(英文)`/`说明（英文）` 等），要求所有列都出现、顺序固定。这样英文界面导出的文件在中文界面里也能导入，反之亦然。`HEADER_ALIASES`（`packages/rating/src/csv.ts` 第 15–19 行）改成逐列别名表。
- 旧格式（五列 `ISO,Country,Destination Prefix,Description,Rate`）：给专门的错误提示，不静默补空，做法同 `rate-list-design.md` D4。
- `Description (EN)` 可为空；非空时同样不超过 200 字、不含换行。
- 导入对话框的说明文字和模板下载（`lib/rate-csv.ts`、`components/admin/rate-csv-template-link.tsx`）随界面语言，模板表头也随界面语言。
- 导入预览的行错误用 `{line, key, params}`，在界面里翻译；这样同一个错误文件在两种语言下都有正确提示。

## 10. 语言切换组件

只用 shadcn/ui 原生组件，沿用 `components/theme-controls.tsx` 的 `ThemeMenu` 的结构：

- `components/locale-menu.tsx`（I1 新建）：`DropdownMenu` + `DropdownMenuTrigger`（`Button`，`variant="outline" size="icon"`，lucide 的 `LanguagesIcon`，已有依赖 `lucide-react`）+ `DropdownMenuContent` + `DropdownMenuRadioGroup` / `DropdownMenuRadioItem`（两项：`中文`、`English`），都来自 `components/ui/dropdown-menu.tsx`。手机版同 `ThemeMenu` 的 `mobile` 参数；菜单样式沿用 `components/menu.ts` 的 `menuContentClass`、`menuItemClass`。
- **不用** `OptionTabs`（自写组件，不是 shadcn 原生）。
- 位置：`app-shell.tsx` 顶栏主题按钮旁、`account-menu.tsx`（手机抽屉里）、登录页右上角。
- 触发按钮的 `aria-label` 用目录键 `common:locale.label`。

## 11. 英文内容字段与数据模型

L4 要求后台录入、对客户可见的内容有英文。规则：**国家名由 ISO 代码派生标准英文名；说明由管理员填一列英文**。

### 11.1 字段

| 表                                      | 新列                                                                                     | 谁写、何时写                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `rate_entries`（改，I7）                | `country_en text NOT NULL DEFAULT ''`、`description_en text NOT NULL DEFAULT ''`         | `country_en` 写入时由服务端按 `resolveCountryEn` 填；`description_en` 来自 CSV 的 `Description (EN)` 或编辑框 |
| `cdrs`（改，I7）                        | `country_en text`、`description_en text`（可空，同 `country`、`description` 的快照做法） | 入库时从费率行复制；旧行为空，英文界面回落（11.3）                                                            |
| `monthly_statement_countries`（改，I7） | `country_en text NOT NULL DEFAULT ''`                                                    | 生成账单时取该国家分组内的 `max(cdrs.country_en)`；分组键仍是中文 `country`                                   |
| `prefix_countries`（DID 批新表）        | `country_en text NOT NULL`                                                               | 初始数据带英文名；Frank 可改。见 DID 文档                                                                     |
| `lines`（DID 批新表）                   | `name_en text NOT NULL DEFAULT ''`                                                       | Frank 在线路页填写                                                                                            |
| `dids`（DID 批新表）                    | `country_en text NOT NULL DEFAULT ''`                                                    | 同 `rate_entries.country_en` 的规则                                                                           |

`monthly_statement_dids`（DID 批）、`did_fee_charges` 等不需要英文列：号码不翻译，其余是数字和日期。`tenants.name` 是客户名称，专有名词，不翻译。

### 11.2 国家英文名的来源与解析

`resolveCountryEn({ iso, prefix })`（放 `packages/shared/src/i18n/`）：

1. `iso` 非空 → `ISO_COUNTRY_EN[iso]`（`iso-countries.ts`，ISO 3166-1 alpha-2 到英文名的静态表）；
2. 否则（共用前缀，如 `1` 美国/加拿大，规则见 `rate-list-design.md` 的「共用前缀的 ISO 为空」）→ 在 `prefix_countries` 里对 `prefix` 做最长前缀匹配，取其 `country_en`；
3. 都没有 → 空串，英文界面回落到中文名（11.3），导入预览给出警告。

静态表不用运行时的 `Intl.DisplayNames`：不同浏览器、不同 Node/ICU 版本给出的名字不一样（例如香港），客户在不同浏览器里看到不同写法，且历史快照会漂移。数据来源见 [14](#14-待确认事项) 第 1 项。

### 11.3 显示规则

`displayCountry(row, locale)`：中文 → `row.country`；英文 → `row.countryEn`，空则用 `iso` 派生的名字，再空则 `row.country`。`displayDescription` 同理（英文空则回落中文说明）。回落发生时界面不加提示。国家汇总的哨兵值「未知」（DID 文档：隐藏主叫）写入时同时写 `country_en = 'Unknown'`。

### 11.4 费率页面

- 编辑框加「英文说明」输入；导入预览表加 `Description (EN)` 列，列出「说明非空但英文为空」的行数作为**警告**（不阻止导入）；
- 说明文字提示同 `rate-list-design.md`：说明和英文说明都会显示给客户，不要写内部备注。

## 12. PR 拆分与验收

### 12.0 通用规则（给外部 CLI）

- 一个 PR 一个分支；每个迁移和用到它的代码在同一个 PR；合并后 `main` 必须可用。分支、提交、推送、开 PR、合并由主管会话的指令为准。
- 本地检查：`pnpm check`（含 lint、format:check、typecheck、test、web build）；涉及数据库的跑 `pnpm test:db`（需要 `pnpm db:up` 启动 Docker 里的 PostgreSQL 和 Mailpit，见 `docs/development.md`）；Lua 相关跑 `lua5.3 freeswitch/tests/billing_authorize_test.lua`；e2e 用 `pnpm test:e2e`。
- **不要**碰服务器、SSH、密钥、`.env` 里的真实凭据、FreeSWITCH 实机；也不要执行 `freeswitch/test/run-integration.sh`（需要 Linux、SignalWire 令牌）——这类步骤在下面标「由主管会话处理」。
- 新增 shadcn 组件用 shadcn 命令行从注册表安装（`apps/web/components.json` 已配置），不手写；不扩用自写组件。
- 金额用 `decimal.js`，不写原生浮点运算（ESLint `money/no-number-money`）；写流水只经 `appendLedgerEntry`。
- 只改本 PR 列出的文件和目录；发现别的地方需要改，写进 PR 说明，不顺手改。
- 每个 PR 说明里写：改了哪些文件、新增的测试名、验收标准逐条的结果。

### 12.1 依赖与顺序

```
I1 框架 ─┬─ I2 契约与服务端文案 ─┬─ I4 前端：通用/登录/门户 ─ I5 后台：租户区 ─ I6 后台：运维区 ─ I7 英文内容字段 ─ I9 收尾
         └─ I3 账号语言 ────────┘                                                              └─ I8 客户邮件 ─┘
```

I1 最先；I2、I3 可并行（I3 有迁移，I2 没有）；I4–I7 依次；I8 只依赖 I3；I9 最后。**DID 批从 I7 合并后开始；DID 批的 PR 6 另需 I8；DID 批的 PR 9 另需 I9。** 迁移编号取开工时 `origin/main` 的下一个；I3、I7、I8 各一个迁移，DID 批的迁移编号排在它们后面。

### 12.2 各 PR

**I1 框架**（无迁移）

- 新建：`packages/shared/src/i18n/{index,types}.ts`、`zh/{index,common,auth}.ts`、`en/…`、`catalog.test.ts`；`apps/web/src/i18n/{index,detect}.ts`；`apps/web/src/components/locale-menu.tsx`；`apps/web/src/test/i18n.tsx`（`renderWithLocale`）；`tooling/eslint/i18n-allowlist.json`；`tests/i18n-rule.test.ts`。
- 修改：`packages/shared/src/index.ts`（导出 i18n）；`apps/web/package.json`（加 `i18next`、`react-i18next`，精确版本）；`apps/web/src/main.tsx`（初始化、`<html lang>`）；`apps/web/index.html`（首屏语言脚本）；`apps/web/src/test/setup.ts`（固定 `zh`）；`apps/web/src/components/app-shell.tsx`、`account-menu.tsx`、`pages/login.tsx`（放切换菜单）；`tooling/eslint/guardrails.ts` 与 `eslint.config.*`（加规则）。
- 迁移的文案只有切换菜单本身。其余页面保持中文原样。
- 测试：目录测试；`lib/locale` 决定顺序的单元测试（localStorage / `navigator.languages` / 默认）；`locale-menu` 组件测试；lint 规则测试。
- 验收：中文下所有现有测试不改断言即通过；登录页和外壳能切到 English，`<html lang>` 随之变化，刷新后保持；浏览器语言为 `ja` 时落在英文；新写一个含汉字的字符串字面量到非名单文件会被 lint 拦住；`pnpm check` 通过。

**I2 契约与服务端文案**（无迁移）

- 修改：`packages/shared/src/api/errors.ts`（`validationIssueSchema` 加 `key`、`params`）；`apps/api/src/errors.ts`（`messages` 改英文技术说明；`sendFailure` 里默认问题也带 `key`）；shared 中含汉字的校验消息文件（用 `grep -rlP "\p{Han}" packages/shared/src | grep -v test` 列出，共 19 个文件 72 行）改成键；`packages/rating/src/csv.ts` 行错误改 `{line, key, params}`；`AdminCsvRowError` 及相关 schema；各 `*ExportRequestSchema` 加 `locale`；`packages/shared/src/hangup-cause.ts` → 目录 `enums`；`packages/shared/src/api/ledger-merge.ts`、`api/portal/ledger.ts`（`noteKey`）；`apps/api/src/routes/exports.ts`、`export/statement-csv.ts`；`apps/api` 与 `apps/worker` 的 `package.json` 加 `i18next`；`apps/web/src/lib/api-problem.ts`（`conflictMessages` 等搬进目录，`issueText`、`problemText`）。
- 新建：`apps/api/src/i18n.ts`（`createInstance`，`translatorFor(locale)`）；`zh|en/{errors,enums,csv}.ts`。
- 兼容：旧中文 `message`/`note` 字段暂留，I9 删。
- 测试：更新受影响的 shared/rating/api 测试（它们断言中文消息，改为断言键）；新增导出的英文表头测试；`formatHangupCause('NORMAL_CLEARING', 'en')`；CSV 行错误键测试。
- 验收：中文下 CSV 和页面文字与改动前逐字相同（原有测试通过）；带 `locale: 'en'` 的导出表头为英文；校验失败响应里每个 `issue` 有 `key`。

**I3 账号语言**（迁移：`portal_accounts.locale`、`admins.locale`）

- 新建迁移 `NNNN_account_locale.sql`（格式同 `0027_cdr_direction.sql`）；`packages/db/src/account-locale.ts`（`setAccountLocale`）及其 DB 测试。
- 修改：`packages/db/src/schema.ts`；`packages/shared/src/api/identity.ts`；`packages/shared/src/api/contract.ts`（`POST /api/auth/locale`）；`apps/api/src/identity.ts`（读出 `locale`）与路由；`apps/web/src/lib/session.ts`、`i18n/index.ts`（6.2 的顺序、登录后同步）。
- 测试：`setAccountLocale` 只改本人（`apps/api/src/idor.db.test.ts` 加用例：A 的会话改不了 B）；`locale` 为 `NULL` 的首次登录写入一次；已有值时不被覆盖；非法值 400。
- 验收：换浏览器后语言跟账号走；登录页切换不写库；`pnpm test:db` 通过。

**I4 前端：通用、登录、门户**（无迁移）

- 范围（共约 61 个文件、670 行）：`apps/web/src/lib/*.ts`（19 个，含 `format.ts`、`duration.ts`、`amounts.ts`、`login-errors.ts`、`portal-ledger.ts`）；`components` 顶层 15 个；`components/cdr/*`（7）、`components/statement/*`（5）、`components/portal/recent-calls.tsx`；`components/ui/sheet.tsx`（`关闭` → 目录键）；`pages/*.tsx` 顶层 7 个；`pages/portal/*.tsx`（6）。
- 做法：每个文件把中文字面量搬进 `zh/*.ts`，写好 `en/*.ts`，用 `t()`；从 `tooling/eslint/i18n-allowlist.json` 删掉迁完的文件；`lib/format.ts` 按第 7 节加 `locale`；`index.html` 的 `title`。
- 测试：原有测试不改断言；新增 `lib/format.test.ts` 的英文用例（日期、月份、时长、费率单位）；门户首页、话单页、账单页各一个英文渲染测试（`renderWithLocale('en')`，断言关键文字和无汉字）。
- 验收：门户在英文下所有页面无汉字（夹具数据除外）；中文下与改动前一致；allowlist 中本范围文件已删。

**I5 后台：租户区**（无迁移）

- 范围（约 30 个文件、710 行）：`pages/admin/tenant-{create,detail,edit,list}.tsx`、`pages/admin/tenant-tabs/*`；`components/admin/{account-dialogs,balance-dialog,form-fields,problem-alert,rate-changes-table,rate-copy-dialog,rate-csv-template-link,rate-edit-dialog,rate-import-dialog,rate-preview,scheduled-rate-version,statement-parts,statement-regenerate,tenant-status-dialog}.tsx`。
- 做法、测试、验收同 I4；后台页面再加：状态标签（`lib` 里租户健康）、余额操作类型在英文下的名称。

**I6 后台：运维区**（无迁移）

- 范围（约 15 个文件、680 行）：`pages/admin/{admin-accounts,audit-logs,mail-settings-tab,receivables,statements,system-alerts,unassigned}.tsx`；`components/admin/{cdr-delete-dialog,cdr-unverified,confirm-payment-dialog,receivable-action,reverse-payment-dialog,unassigned-assign-dialog,unassigned-ignore-dialog,void-receivable-dialog}.tsx`。
- 额外：把库里存的枚举型中文映射为键——告警类型（`ALERT_KIND_LABELS` 的 10 个）、未归属原因（`reason` 字符串到 `reasonCode`，在 API 响应层映射，不改库）、审计的操作类型；自由文本原样显示（[14](#14-待确认事项) 第 5 项）。
- 测试、验收同 I4；英文下告警说明等自由文本仍可能是中文，属于已知边界。

**I7 英文内容字段**（迁移：`rate_entries`、`cdrs`、`monthly_statement_countries` 加英文列）

- 新建：迁移 `NNNN_english_content.sql`（可空/默认值，不回填；预检同 `0004` 的做法）；`packages/shared/src/i18n/iso-countries.ts`（数据来源见 [14](#14-待确认事项) 第 1 项，**未定前不要自己编数据**，先放空表和测试用的 3 个国家，数据由主管会话提供）；`resolveCountryEn`、`displayCountry`。
- 修改：`packages/db/src/schema.ts`；`packages/rating/src/rates.ts`（`RateEntry` 加 `countryEn`、`descriptionEn`）与 `csv.ts`（六列、双语表头别名）；`packages/db/src/rates.ts`（`createRateVersion`、`loadRatingTenant`）、`packages/db/src/admin/rates.ts`（导入、编辑、复制、导出）；`packages/db/src/cdr-intake.ts`（`priceAndInsertCdr` 复制快照）；`packages/db/src/statements/compute.ts` 与明细写入；API 契约里的话单行、费率行、账单国家行加 `countryEn`、`descriptionEn`；`apps/web` 费率页（`rate-edit-dialog`、`rate-import-dialog`、`rates-tab`）、话单、账单国家表用 `displayCountry`；`packages/db/src/seed.ts` 补英文值。
- 测试：CSV 六列往返（中文表头导出 → 英文界面导入成功，反之亦然）；旧五列有专门错误；`resolveCountryEn` 三种路径；话单快照带英文；账单国家行英文。
- 验收：英文界面的费率、话单、账单显示 ISO 派生的英文国家名和英文说明；没有英文时回落中文；`pnpm test:db` 通过。**费率 CSV 此刻是六列**，DID 批 PR 3 再加 `Billing Cycle`。

**I8 客户邮件**（迁移：`email_outbox.locale`，重建 `enqueue_balance_notice`）

- 新建迁移 `NNNN_email_locale.sql`；`zh|en/mail.ts`。
- 修改：`packages/db/src/outbox.ts`、`schema.ts`；`packages/shared/src/mail/templates.ts`；`apps/worker/src/mail.ts`；`packages/mailer/src/mail.ts`（发件人显示名）。
- 测试：`packages/db/src/balance-notices.db.test.ts` 加用例：账号为 `en` 时入队的行 `locale = 'en'`、账号为 `NULL` 或没有账号时为 `zh`；`apps/worker/src/mail.db.test.ts`（经 Mailpit）收到英文邮件，主题和正文无汉字；管理员告警邮件仍是中文；改语言后已入队的邮件语言不变。
- 验收：`balance_low`、`balance_suspended` 两种语言各一封可读；其余模板输出与改动前逐字相同。

**I9 收尾**（无迁移）

- 删除 I2 保留的旧中文 `message`/`note` 兼容字段；`i18n-allowlist.json` 清空（lint 规则对全部 `apps/web/src` 生效）；新增 `apps/web/e2e/i18n-en.spec.ts` 和 `playwright.config.ts` 的英文项目；`scripts/i18n-unused.ts`；文档：`design.md` §2.2 与 §12、`pages.md` 第 20/37 行、`worker-api.md`（导出 `locale`）、`plan.md`、`go-live-checklist.md`（英文界面走查）。
- 验收：allowlist 为空；英文 e2e 通过；`pnpm check`、`pnpm test:db`、`pnpm test:e2e` 通过。
- **由主管会话处理**：英文文案的人工审校（[14](#14-待确认事项) 第 6 项）、测试服上走查两种语言。

## 13. 与 DID 批的关系

- DID 批的新页面（线路、号码、前缀国家、门户号码页、待核对页）、新错误码、新邮件文字、新枚举，**全部直接写进目录**（`zh|en/did.ts`、`errors.ts`、`enums.ts`），不写死中文；lint 规则会拦住。
- DID 批新表的英文列（`lines.name_en`、`dids.country_en`、`prefix_countries.country_en`）在 DID 批 PR 1 创建时就带上，规则见第 11 节。
- 费率 CSV：I7 交付六列，DID 批 PR 3 加第七列 `Billing Cycle`，表头别名同样双语。
- 门户计费周期显示「按分钟 / 按秒」（`Per minute` / `Per second`），后台显示 `60/60`、`1/1`；对应目录键 `rates:cycle.minute`、`rates:cycle.second`。门户的费率不再单独成页，放在号码页的卡片下方（DID 文档第 7 节）。
- `did_fee_notice` 发管理员，中文；门户停机横幅两种语言。
- DID 文档里的迁移编号不写死，按合并顺序排在 I3、I7、I8 之后。

## 14. 待确认事项

用户还没定、会影响实现的问题。每项都有推荐，**不替用户决定**。

| #   | 问题                                                                                                                                        | 影响                                            | 推荐                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 「ISO 代码对应的标准英文名」用哪份数据：ISO 3166 官方英文短名，还是 Unicode CLDR 的英文区域名（例如香港，两份写法不同）                     | `iso-countries.ts` 的内容；客户看到的国家写法   | CLDR 英文区域名（`en`，长名称）。用一次性脚本从固定版本的 Node 生成并提交为静态表，CI 校验每个 ISO 代码都有名字；数据由主管会话提供，开发者不自己编                         |
| 2   | ISO 为空的共用前缀（如 `1` 美国/加拿大）没有标准英文名，英文界面显示什么                                                                    | 这类行的英文国家名                              | 取 `prefix_countries` 最长前缀匹配行的 `country_en`；匹配不到则英文界面回落中文名，并在导入预览给警告（不阻止导入）。备选：CSV 再加一列 `Country (EN)`，仅在 ISO 为空时必填 |
| 3   | 线路名（客户可见）是否也要英文                                                                                                              | `lines.name_en` 是否存在                        | 要。`lines.name_en`，英文界面用它，为空回落 `name`                                                                                                                          |
| 4   | 历史话单的快照是否加英文列                                                                                                                  | `cdrs.country_en`、`description_en`             | 加（可空），入库时复制；不回填旧行（没有正式客户数据）；旧行英文界面回落：先 ISO 派生名，再中文                                                                             |
| 5   | 库里存的中文自由文本在英文后台怎么办：告警说明、未归属原因的细节、审计的 `target`/`details`；以及客户可见的手工流水备注（充值、赠送、调账） | 英文后台里会出现中文；客户流水里 Frank 写的备注 | 枚举类（告警类型、未归属原因、操作类型）翻译；自由文本第一版保留中文原文；手工备注不加英文列，由 Frank 在备注里自己写中英文。备选：流水加 `note_en` 列                      |
| 6   | 英文文案由谁校对。初稿由开发者（外部 CLI）生成，财务和法律性质的词（赊账、冲正、待收款、停机）容易译得不准                                  | 门户、账单、邮件的英文质量                      | 初稿后由用户或熟悉英文的同事校对门户、月账单、客户邮件三处；其余页面按初稿上线                                                                                              |

## 15. 自定取值

用户没有逐项决定的取值，先按下表实现，请审阅。

| #   | 取值                                                                                             | 理由                                                           |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| S1  | 语言代码只有 `zh`、`en`；存库、接口、`localStorage` 都用这两个值；`<html lang>` 为 `zh-CN`、`en` | 项目只需要两种语言，避免区域变体                               |
| S2  | 浏览器语言以 `zh` 开头 → 中文，其他一律英文                                                      | 国际访客默认英文；项目主要用户在 `zh-CN`                       |
| S3  | `localStorage` 键 `fs-billing.locale`                                                            | 与主题键 `fs-billing.theme` 同一命名                           |
| S4  | 账号 `locale` 为 `NULL` 表示没选过；首次登录把当时的界面语言写入一次                             | 满足「默认按浏览器，记在账号上」，又不覆盖用户已有的选择       |
| S5  | 账号语言为 `NULL` 或租户没有门户账号时，客户邮件用中文                                           | 与现有行为一致                                                 |
| S6  | 邮件入队时定语言，存 `email_outbox.locale`                                                       | 与收件人、`params` 的快照做法一致（第 8 节）                   |
| S7  | 导出请求带 `locale`，缺省 `zh`；用界面语言而不是账号语言                                         | 用户看着英文界面点导出，期望英文表头；缺省值让旧调用方不受影响 |
| S8  | CSV 里日期、数字两种语言都用机器友好格式，只翻译表头和系统生成的值                               | 便于 Excel 和重新导入；英文月份名在 Excel 里会被误解析         |
| S9  | 英文日期写 `29 Sep 2026 14:03:22`，月份 `Sep 2026`；中文不变                                     | `DD MMM YYYY` 没有月日顺序歧义                                 |
| S10 | 英文界面在表头和详情里标注 `Beijing time (UTC+8)`，不在每个单元格重复                            | 简洁；业务日期仍是北京时间（L6）                               |
| S11 | 金额、日期不用 `Intl` 格式化，仍走 `lib/format.ts` 和 `beijingDateTimeParts`                     | 保持金额四舍五入口径和北京时间固定口径                         |
| S12 | 错误码响应里的 `message` 改成英文技术说明，前端永远按 `code`/`key` 翻译                          | 服务端不依赖语言；日志里也是英文                               |
| S13 | 测试默认中文，已有断言不改；新增英文用例另写                                                     | 每个迁移 PR 的中文行为被原有测试锁住                           |
| S14 | `Description (EN)` 为空时英文界面回落中文说明；导入预览给警告，不阻止                            | 有内容总比空白好；说明本来就是可选的                           |
| S15 | `country_en` 在写入时由服务端填入并存库，不在显示时现算                                          | 历史版本和话单快照不随字典更新而变；读取简单                   |
| S16 | `lines.name_en` 等英文列在建表时就带（DID 批 PR 1）                                              | 避免新表上线后再补迁移                                         |
| S17 | 棘轮式 lint：现有 103 个文件进名单，迁一个删一个，I9 要求名单为空                                | 既不阻塞已有代码，又保证新增代码不写死中文                     |

## 16. 没能核对的内容

- `i18next`、`react-i18next` 当前版本及其与 React 19、Node 24、Vite 8、Vitest 5 的兼容声明（只核对了项目用的版本号）；
- Lingui 宏在 `@vitejs/plugin-react` 6 下是否可用（只是列为风险，没有试）；
- `components.json` 对 shadcn 命令行的配置是否适合安装新组件（只确认文件存在）；
- CLDR 与 ISO 3166 英文名的差异清单（取决于待确认第 1 项）；
- 英文文案的措辞与翻译质量；
- `Intl.DisplayNames` 在各浏览器和 Node 版本下的差异（只是推断，用来说明不采用它）；
- 本文所有 SQL 为设计草稿，没有在 PostgreSQL 上执行过。
