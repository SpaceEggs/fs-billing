# FS-Billing 开发阶段计划

> 版本：v0.1（2026-10-12）
> 依据：`docs/design.md`（业务与架构）、`docs/pages.md`（页面说明书）、`design/设计系统规范确认/`（已确认的设计稿）
> 业务规则有冲突时以 `design.md` 为准，界面细节以设计稿为准。

---

## 1. 总体思路

**先让电话能正确计费，再做界面。**

计费系统最不能出错的是三件事：授权判断、话单不丢不重、扣费金额准确。这三件事都不依赖网页，所以先把它们做完、测透，再在上面搭 API 和界面。界面阶段按"上线第一个客户需要什么"排序，而不是按设计批次排序。

**每个阶段结束时都有一个能演示、能检查的状态。** 验收标准全部通过才进入下一阶段。验收以真实运行结果为准（命令输出、数据库查询结果、浏览器截图），"编译通过"或"单元测试通过"不算完成。

**每个阶段一个分支，通过 PR 合并到 `main`。**

- 分支名：`phase-<编号>-<简称>`，例如 `phase-0-scaffold`、`phase-1-rating`
- 阶段内可以有多次提交；阶段完成后开 PR，PR 描述逐条列出该阶段的验收标准和对应证据（命令输出、截图、查询结果）
- CI 通过、验收标准全部打勾后合并；合并方式用 squash，`main` 上每个阶段一条提交
- 文档等非阶段性改动也走分支和 PR，分支名用 `docs/<简称>`

| 阶段 | 内容                 | 结束时能做到                                     | 状态                                                                                                                                                                             |
| ---- | -------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 工程骨架             | 一条命令完成检查、测试、启动数据库               | 已完成（PR #2，[验收记录](phase-0-scaffold.md)）                                                                                                                                 |
| 1    | 计费核心（纯函数）   | 所有计费规则有测试覆盖                           | 已完成（PR #4，[验收记录](phase-1-rating.md)）                                                                                                                                   |
| 2    | 数据库与账本         | 表结构、流水不可改、RLS 隔离可演示               | 已完成（PR #6，[验收记录](phase-2-db.md)）                                                                                                                                       |
| 3    | FreeSWITCH 接口      | 用模拟请求打一通电话，完成授权、入话单、扣费     | 功能已完成（PR #9，[验收记录](phase-3-worker.md)）；收尾性能重跑通过（[3 次 p95 ≈ 5.5–6.3 ms](evidence/phase-3-closeout/perf-authorize.txt)），FreeSWITCH 实机通话待阶段 10 验收 |
| 4    | API、登录与网页外壳  | 管理员和客户都能登录，越权测试自动运行           | 已完成（PR #17–#19，[后端记录](phase-4-api.md)、[Web 记录](phase-4-web.md)）                                                                                                     |
| 5    | 管理后台：开户与资金 | 管理员能开户、配费率、充值，可以接第一个试用客户 | 代码验收已完成（PR #21–#37，[视觉对照](evidence/phase-5-web/visual-diff.md)）；2 条运维项（NTP 监测、现网 billing_tenant 核对）随阶段 10                                                                                 |
| 6    | 客户门户             | 客户能自助查余额、话单、流水                     | 进行中：PR 1（[PR #40](https://github.com/SpaceEggs/fs-billing/pull/40)）与 PR 2（[PR #41](https://github.com/SpaceEggs/fs-billing/pull/41)）已合并；阶段验收未完成。见[PR 1 证据](evidence/phase-6-pr1/README.md)、[PR 2 证据](evidence/phase-6-pr2/README.md)和[阶段设计与后续计划](phase-6-design.md) |
| 7    | 月账单               | 每月自动出账，客户可查看和导出                   | 未开始                                                                                                                                                                           |
| 8    | 话单运维             | 未归属话单分配、删除话单、操作日志               | 未开始                                                                                                                                                                           |
| 9    | 通知与告警           | 余额提醒、停机通知、故障告警邮件                 | 未开始                                                                                                                                                                           |
| 10   | 部署与上线           | 生产环境运行，备份可恢复，SIPp 压测通过          | 未开始                                                                                                                                                                           |

阶段 5 结束后系统已经可以小范围试用（管理员替客户查账）。阶段 6、7 结束后达到第一版对客户的完整功能。

---

## 2. 开始前需要准备的

| 事项                                                                                           | 何时需要         | 谁提供 |
| ---------------------------------------------------------------------------------------------- | ---------------- | ------ |
| ~~初始化 git 仓库，确定代码托管位置~~ 已完成：github.com/SpaceEggs/fs-billing（私有）          | 阶段 0           | —      |
| 一台可用的 FreeSWITCH 测试机（组件与配置项见 `docs/freeswitch.md`）                            | 阶段 10 部署验收 | 你     |
| SMTP 账号                                                                                      | 阶段 9           | 你     |
| 正式域名、服务器 B、备份存放位置                                                               | 阶段 10          | 你     |
| ~~管理后台按钮名称统一为"余额操作"~~ 已完成：`pages.md` 中两处按钮名已修改，流水类型"充值"保留 | 阶段 5 之前      | —      |

---

## 3. 各阶段说明

### 阶段 0：工程骨架

**范围**

- pnpm monorepo，目录按 `design.md` §3.4：`apps/web`、`apps/api`、`apps/worker`、`packages/db`、`packages/shared`、`packages/rating`、`freeswitch/`、`docs/`
- TypeScript strict、ESLint、Prettier、Vitest
- 本地开发用 `docker compose`，先只有 PostgreSQL
- ESLint 规则：在 `packages/rating`、`apps/worker` 的金额相关代码中禁止对金额使用 `number` 运算（用 decimal.js）
- CI：每次提交运行检查、类型检查、测试

**交付物**：可运行的空项目、`README.md` 中的开发启动步骤。

**验收标准**

- [x] 全新克隆后，执行 `pnpm install && pnpm check` 全部通过（lint + typecheck + test）
- [x] `docker compose up -d` 后 PostgreSQL 健康检查通过
- [x] 故意写一行 `const fee = 0.1 * 3` 到 rating 包，`pnpm check` 报错
- [x] CI 在一次提交上跑通，有记录可查

验收命令输出、网页截图与 CI 链接见 [`phase-0-scaffold.md`](phase-0-scaffold.md)。

---

### 阶段 1：计费核心（`packages/rating`）

**范围**（全部是纯函数，不碰数据库）

- 计费分钟数：60/60 周期，周期作为参数（为以后 6/6、1/1 预留）
- 费用 = 计费分钟数 × 费率，不提前四舍五入；显示时保留 2 位
- 最长前缀匹配，并按接通时刻选取当时生效的费率版本
- 可打分钟数 = floor((余额 + 透支额度) ÷ 费率)；单通上限 4 小时
- 授权判断：租户不存在/停用、无费率、可打分钟数 ≤ 0 时拒绝，并给出拒绝原因
- 费率 CSV 解析与校验：`ISO,Country,Destination Prefix,Description,Rate`（中文表头 `ISO,国家,号码前缀,说明,费率`，表头必填；ISO、说明可空，国家必填；阶段 1 当时的三列格式已被 [rate-list-design.md](rate-list-design.md) 取代），前缀只能是数字、不重复、费率非负、最多 4 位小数，任何一行出错则整体失败并返回所有出错的行号和原因
- 北京时间的日期和月份归属（按接通时间，跨午夜归入接通当天）
- 金额与费率的类型：用带品牌的类型区分"金额"和"费率"，并且不同币种不能相加

**交付物**：`packages/rating` 及其测试。

**验收标准**

- [x] `design.md` §5 计费示例表的 6 行全部写成测试，结果一致（0:00→0.00，0:01→0.10，3:10→0.40，3:50→0.40，4:00→0.40，4:01→0.50）
- [x] §6.2 的两例：`1876xxxxxxx` 匹配 `1876`，`447xxxxxxxx` 匹配 `447`；无匹配时授权拒绝，原因为"无费率"
- [x] 生效时间：447 费率 0.0450，2026-10-01 00:00（北京时间）起改为 0.0480；2026-09-30 23:59:59 接通的电话用 0.0450，2026-10-01 00:00:00 接通的用 0.0480
- [x] 授权：余额 −35.20、透支 100.00、费率 0.0480 时，可打分钟数为 1350，最长 4 小时封顶为 14400 秒；余额 −100.00、透支 100.00 时拒绝
- [x] CSV：一个含 3 行错误的文件返回 3 条错误及行号，一条也不导入
- [x] CNY 金额与 USD 金额相加在类型检查阶段报错
- [x] 测试覆盖率：`packages/rating` 行覆盖率 ≥ 95%

验收命令输出与 CI 链接见 [`phase-1-rating.md`](phase-1-rating.md)。

---

### 阶段 2：数据库与账本（`packages/db`）

**范围**

- 表：租户、管理员、门户账号、费率表与费率条目（含生效时间）、余额流水、话单（按月分区）、原始话单 JSON、未归属话单、月账单、操作日志、系统告警、余额提醒设置与发送记录
- 所有业务表带租户编号；PostgreSQL RLS 策略，应用以非超级用户角色连接
- 余额流水只能新增：数据库层禁止 UPDATE 和 DELETE（触发器或权限）；"待收款 → 已收款"的状态变化单独记录，不改原流水
- 余额 = 流水合计；为查询速度可以加缓存余额，但必须能从流水重算并核对
- 话单表按通话 UUID 唯一，按月分区，提供自动建下月分区的任务
- 金额字段一律 `NUMERIC`，时间字段一律 `timestamptz`
- 开发用种子数据：与设计稿一致的示例数据（ABC001 深圳市某某科技有限公司、GZT007 等）

**交付物**：Drizzle 表结构与迁移、种子脚本、数据库层测试。

**验收标准**

- [x] 在空数据库上 `pnpm db:migrate && pnpm db:seed` 成功；再执行一次迁移不报错
- [x] 对余额流水执行 `UPDATE` 和 `DELETE` 均被数据库拒绝
- [x] 以租户 A 的身份连接，`SELECT * FROM 话单` 只返回 A 的数据，即使 SQL 里没写租户条件
- [x] 种子数据中 ABC001 的余额由流水合计算出为 −35.20，与设计稿一致
- [x] 插入同一 UUID 的话单两次，第二次被唯一约束挡住
- [x] 插入下个月的话单前自动建分区，`\d+` 能看到对应分区
- [x] 费率版本表对（费率表，`effectiveFrom`）有唯一约束：同一费率表插入两个相同生效时间的版本被数据库拒绝（来自阶段 1）
- [x] 已排定未来版本时修改当前版本：明确规则（同步到未来版本，或禁止修改并提示先改未来版本），并有测试覆盖（来自阶段 1）。已选：禁止并提示先改未来版本
- [x] 首个“立即生效”的版本 `effectiveFrom ≤ now`（写入时取数据库当前时间），开户后立刻授权能匹配到费率（来自阶段 1，阶段 5 开户流程同样验收）

验收命令输出与数据库查询结果见 [`phase-2-db.md`](phase-2-db.md)。

---

### 阶段 3：FreeSWITCH 接口（`apps/worker`）

**范围**

- 授权接口：输入租户编码、被叫号码、UUID，返回放行（最长秒数）或拒绝（原因与建议的 SIP 错误码）
- 话单接口：接收 `mod_json_cdr` 推送，保存原始 JSON，按 UUID 去重，解析出租户标签、接通时间、时长、`billing_unverified`
- 计费任务（pg-boss）：话单入库后计算费用并写一条"通话扣费"流水；找不到租户标签或租户不存在的进入未归属话单
- 接口安全：只监听内网地址、IP 白名单、共享密钥
- `freeswitch/`：拨号计划中调用授权接口、设置定时挂断、超时 1.5 秒放行 1800 秒并设置 `billing_unverified=true` 的示例脚本，以及 `mod_json_cdr` 配置示例
- 授权超时和话单处理失败写入系统告警表（邮件在阶段 9）

**交付物**：Workers 服务、`freeswitch/` 配置示例、接口说明。

**验收标准**

- [x] 用一份真实格式的 `mod_json_cdr` 样本 POST 两次：数据库中只有 1 条话单、1 条扣费流水，余额只扣一次
- [x] 授权：500 条费率的费率表，本机连续请求 1000 次，p95 < 50 毫秒。收尾重跑 3 次全部通过，p95 ≈ 5.5–6.3 毫秒 < 50 毫秒；原始输出见 [收尾性能证据](evidence/phase-3-closeout/perf-authorize.txt)
- [x] 停掉 API 进程，授权和话单接口照常工作
- [x] 不带密钥、或从白名单外的 IP 请求，返回 401/403
- [x] 租户标签为 `ABC01` 的话单进入未归属话单，不产生扣费
- [x] 带 `billing_unverified=true` 的话单照常计费，并保留该标记
- [x] 计费任务中途杀掉 Workers 再重启，话单最终只扣费一次
- [ ] 在 FreeSWITCH 测试机上实际打一通电话：授权放行、到时自动挂断、话单推送并扣费，截图/日志存档。部分：Docker/SIPp 真实 FreeSWITCH 功能联调已通过；测试机实呼移至阶段 10。见 [两次 15 项通过的联调证据](evidence/reject-billing-mismatch/README.md)；CI [FreeSWITCH integration / e2e](../.github/workflows/freeswitch.yml) 执行同一脚本，镜像拉取失败时会跳过联调，CI 绿色结果须确认联调未跳过
- [x] 授权时有费率、但按接通时刻找不到费率（如授权与接通之间切换了版本）的话单：处理方式确定（如进入未归属/待人工话单并告警，不静默按 0 计费），并有测试覆盖（来自阶段 1）
- [x] 号码格式错误（非法字符或归一化后的计费号码不满足首位 1–9、6–15 位数字）：授权接口返回 400 / 以 `号码格式错误` 拒绝；话单接口**不返回 400**（§4.3 话单不能丢），保存为未归属/待人工处理话单、不扣费，并写入系统告警。按 [design.md §4.2](design.md#42-呼叫前授权) 接受 `+`/`00` 国际冠字；原始拨号原样传给上游，独立计费号码由 Worker 归一化并核验（来自阶段 1）
- [x] 通话扣费流水的 `occurred_at` = 话单的 `answered_at`（不是写入时间）；9-30 23:59（北京时间）接通、10-01 才处理的话单，扣费归属 9 月（来自阶段 2）
- [x] 话单去重以 `call_uuids` 登记表为唯一闸门：`cdrs`/`unassigned_cdrs` 的插入触发器在 `ON CONFLICT` 判断之前写登记表，所以入口不能用 `ON CONFLICT DO NOTHING` 去重，而是识别 `23505 call_uuids_pkey`（或先查登记表）并按“重复推送”处理；原始话单 `raw_cdrs.body` 保存收到的原文（来自阶段 2）
- [x] 建分区是维护操作：pg-boss 每日任务（`tz: Asia/Shanghai`）在单独的事务里调用 `ensureCdrPartitions(db)`；Worker 启动时先执行一次。扣费与入库的写入路径不建分区：遇到 `23514 no partition of relation … found for row` 时报错、记日志并写入 `system_alerts`（`kind = 'partition_failed'`，阶段 2 已加入检查约束），话单留给重推。持租户锁时建分区数据库报 `55000`（会与读话单后等租户锁的事务成环，见 phase-2-db.md）。维护任务失败同样写 `partition_failed`。各有测试覆盖（来自阶段 2）
- [x] 加强 savepoint 标记测试：直接断言标记，不依赖 advisory lock 的释放，并去掉笼统的 `.catch()`（来自阶段 2 评审）
- [x] `ensureCdrPartitions` 不再接受事务参数：只接收连接池/连接，使维护操作无法在写事务内执行（来自阶段 2 评审）
- [x] 修正 `phase-2-db.md:102` 与迁移注释的措辞：只有在分区已存在时，并发调用才不会互相串行（来自阶段 2 评审）

---

### 阶段 4：API、登录与网页外壳

后端步骤 3 代码、行为测试和 CI 已实现。退款按已指定的 `window_id` UUID 实施细节完成，详见 [API 设计 §11.1](phase-4-api-design.md#111-api-自有-sql-账户锁定)。本地验证和 Bot 命令见 [运行与证据](phase-4-api.md)。Bot 已运行 `pnpm check`（309 pass）、`test:db` 连续三次（每次 235 pass）、`test:idor`（15 pass）、`prove:idor`、OpenAPI 导出及 build。依赖已安装并锁定。这些是 Bot 验证结果；PR #18 的 CI 与 FreeSWITCH integration 均通过，所有 SIPp e2e 用例均为 PASS，见 [CI 与联调证据](evidence/phase-4-api/ci.txt)。

前端 Web 外壳代码、Vitest 行为测试、连接真实 API 的 Playwright e2e、截图脚本和 CI `web-e2e` job 已由 PR #19 合并，运行方法、决定和设计差异见 [阶段 4 Web 外壳](phase-4-web.md)。Bot 已验证 `pnpm check`、`pnpm test:e2e`（16 个场景）通过，CI `check` 与 `web-e2e` 均为绿色；Codex review 2 已批准，证据见 [evidence/phase-4-web](evidence/phase-4-web/)。

后端 criteria 状态如下。

- 身份、客户到后台 403、401 形状、资料停用退出已实现并有 DB 场景，Bot 已验证 DB 场景；页面导航已由前端实现。
- auth schema、角色隔离、身份函数、锁定、共享计数、退款、撤销和重置原子性已实现并有 catalog 与行为场景，包含 race/bootstrap 修复的 DB 场景已由 Bot 验证。
- live OpenAPI 全量客户操作 IDOR 和隔离变异证明已实现并接入 CI，Bot 已验证运行结果。
- 过期会话响应契约已有本地单测和 DB 场景，浏览器跳转与返回原页面已由前端实现并有 e2e 覆盖。

**范围**

- API（Fastify + Zod + OpenAPI）：数据格式定义放在 `packages/shared`，API 和 Web 共用
- Better Auth：管理员与客户两类账号，客户账号绑定租户；租户编号只从登录身份获取
- 自动越权测试：从 OpenAPI 列出所有客户端点，逐个用"租户 A 的账号访问 B 的数据"，必须全部失败
- Web 外壳：Vite + TanStack Router/Query + Tailwind + shadcn/ui；按 `FS-Billing Design System.dc.html` 落地颜色、状态标签、金额/费率/时间格式组件；浅色/深色/跟随系统；电脑与手机布局
- 第三批设计稿中的：客户登录页、管理后台登录页、账号菜单、登录过期跳转并回到原页面、404

**对应设计稿**：设计系统；客户门户 第三批（登录）；管理后台 第三批 · 系统与账号（登录、全局元素）

**交付物**：可登录的空门户和空后台、共享组件库、越权测试套件。

**验收标准**

- [x] 客户账号登录后进入门户，管理员账号登录后进入后台；客户账号访问后台接口返回 403。后端 DB 场景与前端 e2e 均已覆盖，见 [阶段 4 Web 外壳 §测试证据](phase-4-web.md#测试证据) 与 [e2e 结果](evidence/phase-4-web/e2e.txt)
- [x] Better Auth 表结构按阶段 2 的决定落地：认证表放在不启用 RLS 的 `auth` schema；`admins`、`portal_accounts` 各加 `auth_user_id`（`UNIQUE NOT NULL`）与认证用户一对一关联，身份类型由哪张资料表有这个人决定；邮箱以认证表为唯一来源（删去资料表的 `email`）；Better Auth 使用单独的数据库角色，只授予认证表的权限。连续失败锁定、撤销其他会话、管理员重置密码按实际版本核实（来自阶段 2）
- [x] 越权测试覆盖 OpenAPI 中 100% 的客户端点，在 CI 中运行；临时去掉一个端点的租户过滤，越权测试和 RLS 都能挡住
- [x] 登录过期后操作，跳转登录页，登录后回到原页面。后端 401 响应契约与前端跳转、返回原页面均已实现，e2e 覆盖删除 cookie 与数据库撤销会话两种过期，见 [阶段 4 Web 外壳](phase-4-web.md#测试证据) 与 [e2e 结果](evidence/phase-4-web/e2e.txt)
- [x] 金额格式组件：`-35.2` 显示为 `-¥35.20`，USD 显示 `$`；费率显示 4 位小数。见 `apps/web/src/lib/format.test.ts` 与 e2e 种子余额断言，记录于 [阶段 4 Web 外壳](phase-4-web.md#测试证据)
- [x] 浅色、深色、手机宽度（375px）下的登录页和 404 截图与设计稿一致。截图见 [evidence/phase-4-web/screenshots](evidence/phase-4-web/screenshots/)，与设计稿的差异见 [阶段 4 Web 外壳 §与设计稿的差异](phase-4-web.md#与设计稿的差异)

---

### 阶段 5：管理后台，开户与资金

**范围**（上线第一个客户必需的后台功能）

- 租户列表：筛选、按状态排序规则、不同币种不比较大小、手机卡片
- 新建 / 编辑租户；停用 / 启用
- 租户详情：顶部余额卡片；概况、余额流水、设置（透支额度、余额提醒阈值与邮箱）、门户账号（创建、重置密码、停用、启用）标签页
- 余额操作对话框：充值、赊账充值、赠送、调账（调账必须填原因；充值/赊账/赠送最多两位，调账最多四位，均有可配置金额上限），赊账备注仅内部可见
- 费率表标签页：查看、单条编辑、指定生效时间调价、取消未来版本（现有 lock_tenants 下校验 DB 时间并保存完整审计快照）、CSV 导入（预览、逐行报错、整体不导入）、CSV 导出、复制到其他租户
- 待收款页面：确认、撤销误确认后重新确认、credit 冲正后独立作废，均追加事件与审计；欠款超 30 天高亮、CNY/USD 分开合计
- 管理员页面：新增、重置密码、停用、启用；管理员与门户账号在同一事务内创建认证用户、资料、审计和临时密码，失败整体回滚（决定 m）
- 2026-10-14 及之后的决定详见 [阶段 5 设计](phase-5-design.md#已决定新增2026-10-14)，业务规则已写回 [design.md](design.md)；未来 6/6、1/1 精度在启用这两种计费周期时再决定
- 以上所有人工操作写入操作日志表（页面在阶段 8）

**对应设计稿**：管理后台 第一批、第二批；第三批 · 租户详情（概况、设置、门户账号）；第三批 · 系统与账号（管理员）；CSV 导入原型

**验收标准**

状态核对于 2026-10-17，依据 `main`（`027f21c`）上的测试。证据格式为“文件 / 测试名”。一条标准的所有要求都有证据才打勾；未打勾的写明还差什么。

- [x] 用 Playwright 走完整流程：新建租户（CNY）→ 导入费率 CSV → 赊账充值 ¥500.00 → 门户账号创建；结束时租户列表显示正确余额和状态。种子数据已有 ABC001，e2e 改用每次运行唯一的编码。证据：`apps/web/e2e/admin-onboarding.spec.ts` / `creates a run-unique tenant, imports rates, credits 500 and opens portal account`
- [x] 导入一个含错误行的 CSV，显示所有错误行号，费率表不变。证据：`apps/web/e2e/admin-rates.spec.ts` / `shows every CSV error line`；`packages/db/src/admin/rates.db.test.ts` / `invalid CSV reports all physical rows and writes no versions or audits`
- [x] 调账不填原因无法提交；提交后流水中有反向记录，原记录不变。证据：`apps/web/e2e/admin-balance.spec.ts` / `blocks blank adjustment reason`；`packages/db/src/admin/tenants.db.test.ts` / `rejects missing adjustment reason, caps, precision and reserved keys before writing`；流水只增不改由阶段 2 的触发器保证
- [x] 待收款合计分别显示 ¥ 和 $，不出现两者相加的数字。证据：`apps/web/e2e/admin-receivables.spec.ts` / `renders CNY and USD totals separately`；`apps/api/src/admin-receivables.db.test.ts` / `keeps exact CNY and USD totals over the full filtered set before pagination`
- [x] 种子数据下各页面在浅色、深色、手机宽度的截图与设计稿逐页比对，差异记录在案并处理。比对脚本 `apps/web/e2e/admin-visual.spec.ts` 已合并，省略的设计稿元素记录在 [阶段 5 设计](phase-5-design.md#已决定阶段-5-web-缺口2026-10-15)。2026-10-17 修复后再次运行，69 张对照图与逐页差异清单见 [`docs/evidence/phase-5-web/visual-diff.md`](evidence/phase-5-web/visual-diff.md)：C1–C7、C10、C11 已修复，C8、C9、C12、C13 记为[视觉对照决定](phase-5-design.md#已决定阶段-5-视觉对照2026-10-17)。C13 也记为决定。修复后 `admin-visual.spec.ts` 69 项无错误，全部 e2e 49 passed。
- [x] 每个操作在操作日志表中有对应记录（操作人、时间、对象、内容）。证据：`packages/shared/src/api/admin/admin.test.ts` / `audit payload requires actor, time, target and content and excludes credentials`；租户、余额、费率、待收款、账号各操作的 DB 测试均断言同一事务写入审计
- [x] 开户后首个“立即生效”费率版本的 `effectiveFrom ≤ now`，开户后立即授权匹配到费率（来自阶段 1）。证据：`packages/db/src/admin/tenants.db.test.ts` / `creates an immediately effective empty version and explicit defaults`；`apps/worker/src/app.db.test.ts` / `开户（$kind 初始费率）后立即授权即匹配到首个费率版本`（逐条与 CSV 两种初始费率，经管理服务开户后立即调用 `/authorize` 放行并返回计费号码）
- [x] 费率版本“指定时间”接受任意 ISO，必须在当前时间至可配置 horizon 的闭区间内，默认 365 天；接口 Zod 拒绝过去或超上限，秒/毫秒与边界测试覆盖，Web 使用北京时间分钟选择器。数据库层允许首个版本倒填（种子与测试使用），见阶段 2 的决定（来自阶段 2）。证据：`packages/shared/src/api/admin/decisions.test.ts` / `schedule horizon accepts any ISO instant within inclusive configurable bounds`；`apps/api/src/admin-rates.test.ts` / `configured horizon governs edit, import and copy at the HTTP boundary`；`apps/web/e2e/admin-rates.spec.ts` / `minute picker submits Beijing schedule`

- [ ] 取消指定未来版本只允许 `effective_from > DB now() + margin`，余量默认 60 秒并监测 NTP，现有 trigger guard 保留，与生效竞态时拒绝；当前/历史费率不变，rate_schedule_cancel 保存取消版本 ID 和完整 entries；仅复用 lock_tenants。代码已有证据：`packages/db/src/admin/rates.db.test.ts` / `cancels only future versions beyond configured margin and audits full entries`、`rejects cancellation exactly at the configured database clock margin`、`maps activation during a tenant lock wait to conflict and rolls back cancellation audit`。**还差**：FreeSWITCH 与数据库的 NTP 监测（运维项，随阶段 10 部署）
- [x] 管理员启用、门户账号停用/启用均要求管理员身份且成功写审计；门户停用撤销全部会话，不影响呼叫；账号启用不恢复旧会话。证据：`apps/api/src/admin-accounts.db.test.ts` / `portal disable and enable audit without changing tenant status or restoring old sessions`、`admin enable audits without restoring sessions`、`customers cannot list or mutate admin or portal accounts`
- [x] topup/credit_topup/gift 拒绝超过两位小数，adjustment 拒绝超过四位；正负金额都受可配置业务上限约束，默认最多 10 位整数，独立于传输长度；透支额度与阈值非负且最多两位。证据：`apps/api/src/admin-tenants.db.test.ts` / `rejects adjustment without a reason and invalid precision or caps before writes`、`uses the configured %i digit cap in routes and services`；`packages/db/src/admin/tenants.db.test.ts` / `edits, disables, enables and normalizes settings with audits in the transaction`
- [x] CSV 接受中文表头 `ISO,国家,号码前缀,说明,费率`（表头必填，旧三列格式不再支持），文件 <=2 MiB，行数上限 10000（已决定，可配置）；超限整表不变，大表预览 TTL 可配置，默认 60 分钟。证据：`packages/db/src/admin/rates.db.test.ts` / `Chinese CSV preview binds actor purpose and path and commits all rows once`、`enforces decoded byte and row limits before writes`、`expires configured TTL and rechecks stored schedule at commit`；`apps/api/src/app.test.ts` / `tenant CSV upload boundary honors two decoded MiB and maps excess size to the CSV contract`
- [ ] 创建编码规范化大写；迁移前检查存量大小写碰撞并人工重命名，核对现有 FreeSWITCH billing_tenant 与 stored codes，再加 DB 不区分大小写唯一；worker 授权与 CDR ingest 均规范化大写；邮箱小写去重后最多 20 个，空收件人可保存但设置页面在加载/保存后显示无法送达提醒。代码已有证据：迁移 `0006_admin_receivables.sql` 先检查碰撞再建 `tenants_code_case_insensitive`；`apps/worker/src/app.db.test.ts` / `normalizes authorization and lowercase billing_tenant for %s stored codes`；`apps/web/e2e/admin-settings.spec.ts` / `warns for empty recipients after load and save`。**还差**：上线前核对现网 FreeSWITCH 的 `billing_tenant` 与数据库编码（运维项，随阶段 10）
- [x] 门户与管理员开户在同一业务事务内创建认证用户、资料、审计和临时密码；失败整体回滚，不留下无资料的认证用户；业务 API 拒绝无资料的用户（决定 m，取代原“先建用户、最后 activate”的方案）。证据：`apps/api/src/admin-accounts.db.test.ts` / `creates admins with a same-transaction audit and initial temporary credential`、`failed account creation rolls back the auth user and writes no audit`；`apps/api/src/auth.db.test.ts` / `correct passwords reveal disabled or unavailable identities only after deleting the newly created session without cookies`
- [x] 停用租户提示不承诺呼叫停止，说明 Worker 超时时新呼叫仍可能放行最多 1800 秒；人工欺诈切断 runbook 按 billing_tenant 与租户编码不区分大小写核验 UUID 后执行 uuid_kill。证据：`apps/web/e2e/admin-tenants.spec.ts` / `disable confirmation explains live call behavior`；runbook 见 [阶段 5 设计](phase-5-design.md) 与 [design.md §4.2](design.md#42-呼叫前授权)

- [x] 撤销误确认必填原因并追加每 settlement 唯一的 reversal；重新成为 pending 后可重新全额确认；confirm 必填 expectedLatestSettlementId，与含已撤销的最新历史确认匹配；响应暴露 latestSettlementId，旧重试返回 SETTLEMENT_CONFLICT。作废优先返回 RECEIVABLE_VOIDED，保留 ALREADY_RECEIVED，重复/并发确认只存在一个未撤销 settlement；仅用现有 lock_tenants，余额和原流水不变。证据：`packages/db/src/admin/receivables.db.test.ts` / `confirms, reverses and reconfirms %s without changing the ledger or balance`、`serializes concurrent confirmations and concurrent reversals without duplicate audits`、`requires current tokens and rejects another credit settlement on reversal`；`apps/web/e2e/admin-receivables.spec.ts` / `reverses then reconfirms with fresh token`
- [x] credit 冲正后独立 void 关联原 credit 与相反金额 adjustment，必填原因及 actor 审计，每 credit 一个事件；已收须先撤销确认，voided 不可再确认且不进入 pending totals。证据：`packages/db/src/admin/receivables.db.test.ts` / `does not automatically close a credit on adjustment; void requires reversal first and wins error precedence`、`rejects wrong amount, kind, tenant, missing adjustment and an earlier adjustment`、`concurrent voids produce one event and one complete audit`；`apps/web/e2e/admin-receivables.spec.ts` / `voids with linked adjustment`
- [x] disabled 租户仍可充值、赊账、赠送且不自动启用，确认框说明状态；大额 gift/credit 超过前端可配置 CNY 10000 / USD 1500 阈值才二次确认，API 不接收 confirm token。证据：`apps/web/e2e/admin-balance.spec.ts` / `disabled tenant confirmation explains unchanged status`、`gift and credit require second confirmation only above configured currency threshold`；`packages/shared/src/api/admin/decisions.test.ts` / `large gift and credit requests require no confirmation token`
- [x] 紧急改价按取消排期、修改当前、重新排期三步各自审计并提示中间状态；preview 默认 60 分钟到期且 commit 重查版本和时间。证据：`apps/web/e2e/admin-rates.spec.ts` / `cancel edit reschedule audits each step`；`packages/db/src/admin/rates.db.test.ts` / `expires configured TTL and rechecks stored schedule at commit`、`rejects stale previews after another version commits without partial writes`
- [x] 管理员与门户首次登录及每次重置后均强制改密；临时密码 TTL 可配置默认 72 小时，从签发时刻计算，在登录拒绝到期密码，成功改密后解除限制，无后台过期任务。证据：`apps/api/src/admin-accounts.db.test.ts` / `blocks business routes until a temporary password is changed`、`enforces configured temporary credential TTL for admin and portal logins`、`temporary credentials reject after expiry and permanent password changes clear issuance`；`apps/web/e2e/admin-tenants.spec.ts` / `onboarding shows the generated portal password once and the new account must change it`
- [x] 阶段 5 审计使用受限只读 DB 角色和按 tenant/action/time 的保存查询，写权限拒绝，页面仍在阶段 8；停用管理员邮箱仍保留且设置页加载/保存后标记，无自动移除或兜底。证据：`packages/db/src/audit.db.test.ts` / `filters by case-insensitive tenant code and returns the full row newest first`、`filters by exact action, keeping logs without a tenant`、`time window includes p_from and excludes p_to`、`audit_role_violations reports %s`、`audit_role_violations is empty for the migrated role`、`audit_role_violations ignores default privileges in unrelated schemas`、`audit_role_violations still reports the grant option after the auditor delegates it`、`migration refuses a pre-existing audit role after %s`、`application role cannot execute the audit query`、`application role cannot execute audit_role_violations`；`apps/web/src/components/admin/form-fields.test.tsx` / `flags disabled-admin emails regardless of case and keeps the saved spelling`

---

### 阶段 6：客户门户

**范围**

- 首页：余额、透支额度、可用额度、本月消费，负余额和已停机状态
- 话单：按时间筛选、默认只显示已接通并可切换全部、详情、CSV 导出；不显示"未经验证"标记
- 余额流水：可见类型与备注规则（赊账显示为"账户充值"，内部备注不外露）
- 账号设置：修改密码
- 后台租户详情的话单标签页（共用话单组件，额外显示"未经验证"标签和筛选）

**对应设计稿**：客户门户 第一批、第二批（余额流水）、第三批（账号设置）；管理后台 第三批 · 租户详情（话单）

**验收标准**

- [ ] 用客户账号查看话单和流水，接口响应中不包含 `billing_unverified` 字段和赊账内部备注（检查接口原始 JSON，不只看页面）
- [ ] 话单 CSV 导出：10 万条话单的导出在 30 秒内完成，内存占用不随条数线性增长（流式输出）
- [ ] 话单列表：在 300 万条话单（约一年数据量）的数据库上，按月翻页每页响应 < 500 毫秒
- [ ] 透支中、已停机、无话单三种状态的截图与设计稿一致
- [ ] 时间全部显示为北京时间：UTC 2026-09-28 16:30 接通的电话显示为 2026-09-29 00:30，并归入 29 日
- [x] 余额流水中通话扣费“按天合并”按 `occurred_at` 的北京日期分组（不是写入时间）（来自阶段 2）。PR 2 的数据库服务测试验证北京日分组、迟到写入和同日排序；见[PR 2 验收记录](evidence/phase-6-pr2/README.md#behavior-covered)（`packages/db/src/ledger-merge.db.test.ts`）。

---

### 阶段 7：月账单

**范围**

- 账单生成任务：每月 1 日凌晨（北京时间）生成上月账单；期初 + 充值（含赊账）+ 赠送 ± 调账 − 通话扣费 = 期末；按国家、按日汇总
- 管理员手动重新生成（已删除话单的月份禁止重新生成）
- 门户：月账单列表与详情、CSV 导出
- 后台：账单页面、租户详情的账单标签页

**对应设计稿**：客户门户 第二批；管理后台 第三批 · 运营（账单）、第三批 · 租户详情（账单）

**验收标准**

- [ ] 用种子数据生成 ABC001 的 8 月、9 月账单，数字与设计稿一致：8 月 0 + 3,000.00 + 50.00 − 1,873.40 = 1,176.60；9 月 1,176.60 + 1,300.00 + 0.00 − 25.50 − 2,486.30 = −35.20
- [ ] 每个租户每月：账单期末余额 = 截至月末的流水合计，写成自动核对任务，不一致时产生告警
- [ ] 账单与核对任务一律按流水的 `occurred_at`（北京时间日/月）统计，不按 `created_at`：9-30 23:59 接通、10-01 才扣费的电话计入 9 月账单（来自阶段 2）
- [ ] 同一月份重复执行生成任务，结果相同且不重复
- [ ] 话单补推后重新生成，账单更新；跨午夜电话归属正确

---

### 阶段 8：话单运维

延后项：管理员重置密码提交成功后，审计写入失败目前只记结构化错误日志。阶段 8 接入 `system_alerts` 告警，不回滚已提交的凭据与会话撤销。

延后项：owner `auth:bootstrap` 创建与替换凭据目前未写入操作审计。阶段 8 补充 bootstrap 审计，记录操作者、目标资料、操作类型与结果，不记录密码、哈希或会话 token。

**范围**

- 未归属话单：按标签分组、分配给租户、预览计费金额与无费率条数、分配后补扣费
- 删除话单：选择租户 + 整月、只能删除已出账月份、输入租户编码二次确认；删除后流水和账单不变
- 操作日志页面
- 原始 JSON 超过 6 个月压缩归档与恢复

**对应设计稿**：管理后台 第三批 · 运营（未归属话单、操作日志）、第三批 · 租户详情（删除话单对话框）；未归属话单原型、删除话单原型

**验收标准**

- [ ] 种子数据下，把 ABC01 的 326 条分配给 ABC001：预览显示扣费 ¥58.35、324 条可分配、2 条无费率（前缀 1876）；执行后余额减少 58.35，流水中有对应扣费
- [ ] 同一批未归属话单重复提交分配，只扣费一次
- [ ] 删除当月话单的按钮不可用；删除 8 月话单后，ABC001 的余额、8 月账单数字不变，8 月账单的"导出话单明细"提示已删除，"重新生成"不可用
- [ ] 操作日志中能查到上述删除：谁、何时、哪个租户、哪个月、多少条
- [ ] 归档后恢复一条原始 JSON，内容与归档前逐字节相同
- [ ] `apps/worker/src/ingest.ts` 的话单校验失败原因不再保存冗长的 Zod 错误消息，改为简短或结构化的原因（来自阶段 3 评审）
- [ ] 无 UUID 的校验失败话单每次重推都会新建一条 pending 行：去重或合并，并有测试覆盖（来自阶段 3 评审）
- [ ] 修正重推成功后，旧的 pending 行从待人工处理列表中移除或标记已解决（来自阶段 3 评审）
- [ ] 分区维护 DB 测试偶发超时：排查根因并修复，后续通过不能证明不稳定已消除（来自阶段 3 评审）
- [ ] Lua 与 `packages/rating/src/dialed.test.ts` 共用号码用例列表，避免两套列表漂移；现有独立测试及 SIPp 覆盖已通过，此项为测试维护改进（来自阶段 3 收尾评审）

---

### 阶段 9：通知与告警

**范围**

- 邮件发送任务（SMTP），失败重试并记入系统告警
- 余额提醒：降到阈值以下发一封，回到阈值以上后才会再次触发；余额 + 透支用完发停机通知
- 系统故障告警：开始时一封，持续期间每 N 分钟汇总一封，恢复后一封
- 系统告警页面、概览页面

**对应设计稿**：管理后台 第三批 · 运营（概览、系统告警）

**验收标准**

- [ ] 用本地邮件测试工具（如 Mailpit）接收：余额从 120 降到 80（阈值 100）收到 1 封；再降到 50 不再发；充值到 150 后再降到 90，再收到 1 封
- [ ] 余额 + 透支降到 0，收到 1 封停机通知
- [ ] 明确停机通知阈值与授权 `余额不足` 的关系：余额 + 透支 > 0 但不足 1 分钟（授权已拒绝）时是否发停机通知，规则写入设计并有测试（来自阶段 1）
- [ ] 模拟授权超时持续 20 分钟（N = 10）：共收到 开始 1 封 + 汇总 2 封 + 恢复 1 封
- [ ] 概览页的待收款合计、告警数与对应页面数字一致
- [ ] 对账（补投）告警在恢复后标记为已恢复（来自阶段 3 评审）
- [ ] 通用无效输入每次重推仍重复写告警：同类告警去重或合并。扣费重试与对账告警已去重，此项仅剩通用无效输入告警（来自阶段 3 评审）
- [ ] 增加真实每分钟 cron 触发测试：现有测试检查调度元数据后手动 `boss.send()`，尚未证明时钟触发（来自阶段 3 评审）
- [ ] pg-boss 关闭 advisory locking 的补丁假设只有单个 Worker 实例：验证多实例安全性或修改实现，必须在多实例部署前完成（来自阶段 3 评审）
- [ ] `apps/worker/src/app.ts` 的计费号码不一致错误日志包含原始拨号、被叫和计费号码：决定并落实日志脱敏规则，明确访问与保留策略，必须在阶段 10 上线前解决（来自阶段 3 收尾评审）

---

### 阶段 10：部署与上线

**范围**

- 生产 Docker Compose：Caddy（自动 HTTPS）、Web、API、Workers、PostgreSQL
- 防火墙：Workers 端口只对服务器 A 开放
- 每日自动备份，保留 30 天，存到另一台机器或对象存储；恢复脚本
- 用 SIPp 在 FreeSWITCH 测试机上做压测和故障演练
- 上线检查清单、运维手册（重启、恢复、查看告警）

**验收标准**

- [ ] 在服务器 B 上从零部署，按运维手册操作可以完成，用时记录在案
- [ ] 从公网访问 Workers 端口被拒绝；从服务器 A 可以访问
- [ ] 删掉测试数据库后，用最近一次备份恢复，余额和话单数量与删除前一致
- [ ] SIPp 以 50 路并发、每秒 10 通呼叫持续 30 分钟：授权超时率为 0，所有话单入库，扣费总额与话单逐条计算的合计一致
- [ ] 压测中重启 API 和 Web：通话和话单不受影响
- [ ] 压测中停掉 Workers 1 分钟：FreeSWITCH 按 1800 秒放行并标记未经验证，Workers 恢复后补推的话单全部入库且不重复，系统告警记录了这次故障
- [ ] 在 FreeSWITCH 测试机上实际打一通电话：授权放行、到时自动挂断、话单推送并扣费，并核对真实话单中的主叫号码字段位置与入库值正确，截图/日志存档（用户测试机部署验收；阶段 3 标准 8 的 Docker/SIPp 功能验证已通过，来自阶段 3 评审）
- [ ] FreeSWITCH 与数据库服务器的 NTP 时钟监测上线，偏差告警可演示（来自阶段 5：取消未来费率版本依赖 DB 时钟余量）
- [ ] 上线前核对现网 FreeSWITCH 的 `billing_tenant` 取值与数据库租户编码，不区分大小写一一对应，核对结果存档（来自阶段 5）
- [ ] 在有历史数据的数据库上演练迁移，测量并记录锁持有时长与部署窗口；`lock_timeout=5s` 只限制等锁时间，不限制持锁或扫描时间（来自阶段 3 收尾评审）
- [ ] 制定上线后大分区表（如 `cdrs`）新增索引的运维手册：当前 migrator 在事务内运行，不能执行 `CREATE INDEX CONCURRENTLY`。上线后必须在迁移事务外逐分区执行 `CREATE INDEX CONCURRENTLY`，再将分区索引附加到以 `ON ONLY` 创建的父索引；`0010` 的普通 `CREATE INDEX` 仅适用于上线前的开发、CI 或空库。
- [ ] 在有历史数据的数据库上验证 `0004_billing_number_not_null.sql` guard：合法数据升级成功，非法数据拒绝升级且迁移原子失败（来自阶段 3 收尾评审）
- [ ] CI 拉取 FreeSWITCH 镜像失败时不能静默跳过 e2e 后仍视为部署验收通过；上线前必须执行并保存未跳过的 Docker/SIPp 联调证据（来自阶段 3 收尾评审）
- [ ] 上线前必须解决[阶段 9](#阶段-9通知与告警)的计费号码错误日志 PII 项，落实日志脱敏、访问与保留策略

---

## 4. 不在本计划内的

`design.md` §2.2 列出的不做事项，以及 §7.5 的"通话中冻结金额"，都不在第一版范围内。若阶段 10 压测发现并发透支问题超出预期，再单独评估。
