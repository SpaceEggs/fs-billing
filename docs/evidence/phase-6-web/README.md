# 阶段 6 PR 7 验收记录

PR 7 是阶段 6 的验收收尾：门户首页视觉对照、31 天下界实测、plan 逐项勾选、验收映射表核对。它**没有修改产品代码或界面**，也没有修改查询。基线是 `main` 的 `93a95a7`（PR #51 合并之后），分支 `phase-6-pr7-acceptance`。设计见 [phase-6-design.md](../../phase-6-design.md#pr-7-验收收尾2026-10-22)。

## 完整检查

2026-10-22 依次在本工作区运行，对开发库 `fs_billing`（当天重新 `db:seed`）或 `fs_billing_test`：

| 命令             | 结果                                                                                                                                                                   | 记录                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `pnpm check`     | 退出码 0：lint、format:check、typecheck 通过；根目录 37 个文件 730 项通过、1 项跳过；Web 38 个文件 511 项通过；Web build 成功                                          | [pnpm-check.txt](pnpm-check.txt)         |
| `pnpm test:db`   | 退出码 0：34 个文件 484 项通过                                                                                                                                         | [pnpm-test-db.txt](pnpm-test-db.txt)     |
| `pnpm test:idor` | 退出码 0：1 个文件 29 项通过（6 个客户操作 `portalHome`、`portalCdrs`、`portalCdrCountries`、`portalCdrsExport`、`portalLedger`、`portalLedgerExport` 都在越权用例里） | [pnpm-test-idor.txt](pnpm-test-idor.txt) |
| `pnpm test:e2e`  | 退出码 0：83 项通过、2 项跳过（跳过的是需要 `FSB_VISUAL=1` 的 `admin-visual.spec.ts` 与 `portal-visual.spec.ts`）                                                      | [pnpm-test-e2e.txt](pnpm-test-e2e.txt)   |

没有失败。`pnpm check` 的第一次运行因本 PR 新增脚本的 lint 报错（`no-unsafe-return`）退出码 1，修正脚本后重跑通过，记录里只保留最后一次。

## plan 勾选

| plan 阶段 6 验收项                                     | 结果           | 依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 接口原始 JSON 不含 `billing_unverified` 和赊账内部备注 | 已勾选         | 流水：`apps/api/src/portal-ledger.db.test.ts` 对未解析的 `response.body` 断言不含 `credit_recharge`、`paymentStatus`、`noteVisibility`、`actor`、`createdBy`、`internalNote`、哨兵备注与管理员 id。话单：`apps/web/e2e/portal-cdrs.spec.ts` 抓真实浏览器的 `/api/portal/cdrs*` 响应原文，夹具含一通未经验证话单，断言不含 `unverified`；CSV 原文由 `idor.db.test.ts` 与 `portal-cdr-export.db.test.ts` 断言；首页由 `portal-home.db.test.ts` 断言。上表 2026-10-22 的 DB、IDOR、e2e 全部通过 |
| 北京时间：UTC 16:30 显示 00:30 并归入 29 日            | 已勾选         | `apps/web/e2e/portal-cdrs.spec.ts` / `shows 00:30 on the 29th for the 16:30 UTC call`：29 日范围内第二行显示 `2026-09-29 00:30:05`，28 日范围内为空；DB 层 `cdrs.db.test.ts`、`ledger-merge.db.test.ts` 验证北京日归属与 `0001-01-01` 边界                                                                                                                                                                                                                                                   |
| 300 万条话单每页 < 500 ms                              | 已勾选         | 见下文[重测](#300-万条列表重测)：80 个测量请求最大 239.1 ms，含 warmups 最大 281.8 ms                                                                                                                                                                                                                                                                                                                                                                                                        |
| 余额流水按天合并按 `occurred_at` 北京日                | 已勾选（PR 2） | 本 PR 未改                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10 万条 CSV 在 30 秒内、内存不随条数线性增长           | **未勾选**     | 时间满足，内存一半未定论，见下文[导出](#导出)，待用户判断                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 透支中、已停机、无话单截图与设计稿一致                 | **未勾选**     | 8 张对照图都有差异，没有发现明确缺陷，有 6 个待用户判断的问题，见 [visual-diff.md](visual-diff.md)                                                                                                                                                                                                                                                                                                                                                                                           |

## 300 万条列表重测

[list-latency.txt](list-latency.txt) 是 `apps/api/scripts/portal-list-perf.ts` 的完整输出。性能库 `fs_billing_perf_pr3_uuid_v4` 本身只迁移到 0015，缺少费率表五列 PR A 的 0016 迁移（话单的 `iso`、`description` 两列），主库实例上的这个库没有改动。重测用的是 PR A 当时从它复制并迁移到 0016（17 条迁移）的库副本（Docker 容器 `fs-billing-rate-a-pg`，端口 55434，300 万条 `PORTALBIG` 与原库相同），命令与 [rate-list-pr-a 记录](../rate-list-pr-a/README.md#性能门槛)相同，输出重定向到本目录：

```sh
cd apps/api
PERF_TARGET_DATABASE=fs_billing_perf_pr3_uuid_v4 PERF_DATABASE_PORT=55434 PERF_ROUNDS=5 \
  node --env-file-if-exists=../../.env --import tsx scripts/portal-list-perf.ts \
  > ../../docs/evidence/phase-6-web/list-latency.txt
```

文件里的 `evidenceCaptureCommand` 是脚本内置的默认命令（指向 `docs/evidence/phase-6/`），不是本次实际的重定向。结果：门户与后台、被叫、国家、被叫加国家、仅未经验证、深页共 11 个场景，80 个测量请求全部成功，最大 **239.1 ms**；含 warmups 与深页 warmups 的 96 个请求最大 281.8 ms；失败 0，清理错误 0，API 子进程正常退出。各场景 p50：门户已接通 164.4 ms、门户全部 211.6 ms、后台已接通 163.5 ms、后台全部 210.1 ms，其余场景 57 至 88 ms。

PR 3 的 HTTP 记录是 [../phase-6/list-latency.txt](../phase-6/list-latency.txt)（最大 227.6 ms），PR A 后重测是 [../rate-list-pr-a/list-latency.txt](../rate-list-pr-a/list-latency.txt)（最大 280.0 ms）。PR A 之后话单列表与导出的查询代码没有变化（`git log ec544ba..main -- packages/db apps/api/src packages/shared` 只有 PR 4 的首页与 `tenant-health`），所以这次重测与当前 `main` 的列表代码一致。

## 导出

没有重跑。10 万条导出的成功记录只有 PR 3 的原始运行，重跑 `portal-export-perf.ts` 的完整流程含 5 分钟的总时限测试，不属于廉价重测，这里引用 PR 3 的证据，数据来自仓库里保留的文件，没有新的测量。

**30 秒**：[`export-formal-pr3-…-r2.exit.json`](../phase-6/export-formal-pr3-20261019T1051Z-stream-hold-r2.exit.json) 记录了正式运行（失败 0、清理错误 0）；[PR 3 验收记录](../phase-6/README.md)称 14 个 10 万条测量请求均在 30 秒内，但该次的原始 jsonl 已删除，仓库里没有逐请求耗时。仓库里保留的 10 万条耗时来自 [`export-memory-20261019.json`](../phase-6/export-memory-20261019.json)（同进程 40 次导出，10 万条各 5 次）：门户 440.3 至 459.6 ms，后台 476.8 至 520.7 ms；以及 [`rss-isolated/summary.jsonl`](../phase-6/rss-isolated/summary.jsonl)（42 个新进程各导出一次）：10 万条门户 520.3 至 604.2 ms，后台 577.4 至 616.5 ms。数量级是预算的约 2%。

**内存**：仓库保留的 `rss-isolated/summary.jsonl`（每个进程导出一次，7 轮，中位数，单位 MB）：

| 受众 | 行数    | 峰值 RSS | 请求期间 RSS 增量 |
| ---- | ------- | -------- | ----------------- |
| 门户 | 50,000  | 200.5    | 32.7              |
| 门户 | 100,000 | 233.3    | 64.9              |
| 门户 | 200,000 | 279.2    | 112.1             |
| 后台 | 50,000  | 205.0    | 37.2              |
| 后台 | 100,000 | 238.7    | 70.5              |
| 后台 | 200,000 | 276.9    | 109.9             |

行数乘 4（5 万到 20 万），峰值 RSS 约乘 1.3 到 1.4，请求期间的增量约乘 3.4（门户）与 3.0（后台）。也就是峰值不随行数线性上升，但请求内的增量大致随行数上升，这是此前就记录的未决问题。同进程 40 次导出的结果（[`export-memory-20261019.json`](../phase-6/export-memory-20261019.json)，强制 GC 之后）显示保留堆约 39 MB，且不随行数增长，20 万条重复导出的 RSS 增量中位数门户 5.2 MB、后台 3.9 MB；该记录自己写明「不能据此宣称冷启动 RSS 恒定」。

**数据口径的差异需要用户知道**：[PR 3 验收记录](../phase-6/README.md)正文写的新进程 RSS 峰值中位数是门户 191.2、222.5、266.2 MB，后台 195.5、227.6、264.0 MB，增量门户 31.2、61.9、107.0 MB；而同一目录里保留的 `summary.jsonl` 逐样本算出来的是上表的数字（峰值约高 9 至 13 MB）。两组数字的趋势相同，我没有找到差异的来源，也没有改 PR 3 的记录。

**结论**：不判断这一项是否通过，也没有发明数值门槛。plan 的原文是「内存占用不随条数线性增长（流式输出）」，仓库里的证据一部分（峰值）倾向通过，一部分（请求期间增量）倾向不通过，是否算通过取决于对「内存占用」的解读（峰值 RSS、请求增量，还是保留堆）。**该项未勾选**，需要用户决定口径；如果选择请求增量，需要先决定是否优化流式导出。

## 31 天下界实测

对象是概况查询（`packages/db/src/usage.ts` 的 `readTenantUsageOverview`）的「接通月份」CTE `answered`。决定 40 把「概况 31 天下界」推迟到 PR 7。下界形式与话单列表一致：在 `answered` 的 where 里加 `c.started_at >= b.month_start - interval '31 days'`，其余不变（既有的 `c.started_at < b.month_end` 仍在）。**查询没有修改**，下面只是数字。

| 项目       | 值                                                                                                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据库     | 本机 Docker PostgreSQL 17.9 上的 `fs_billing_perf_pr3_uuid_v4`，租户 `PORTALBIG`（300 万条，2025-10 至 2026-10，14 个月分区）                                                                                                                                                                   |
| 身份与事务 | `fs_billing_app`，`BEGIN READ ONLY`，`app.scope=tenant`、`app.tenant_id=PORTALBIG`，`set local jit = off`，每次 `ROLLBACK`；没有写入，没有碰 `fs_billing`                                                                                                                                       |
| 语句       | `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)`；`answered` 是只跑该 CTE，`overview` 是 `usage.ts` 的整条查询原文（只有 `answered` 的条件不同）                                                                                                                                                        |
| 时间形式   | `固定` 为 `asOf = 2026-10-17T04:00Z`（性能库数据截止日，与 `now` 参数形式相同）；`生产` 为 `statement_timestamp()`（接口不传 `now` 时的形式，运行日 2026-10-22）                                                                                                                                |
| 轮次       | 每个组合先丢弃 1 轮预热，再交替运行 8 轮，每轮的先后顺序也交替（基线先、下界先、基线先……），共 16 次测量；脚本先断言两种写法返回的结果相同                                                                                                                                                      |
| 脚本       | [`packages/db/scripts/overview-lower-bound.ts`](../../../packages/db/scripts/overview-lower-bound.ts)；原始数据 [results.json](overview-lower-bound/results.json) 与 [september-asof/results.json](overview-lower-bound/september-asof/results.json)，各组合最后一次的计划在同目录 `plan-*.txt` |

```sh
set -a; . ./.env; set +a
export PERF_APP_DATABASE_URL="${APP_DATABASE_URL%/*}/fs_billing_perf_pr3_uuid_v4"
pnpm --filter @fs-billing/db exec tsx scripts/overview-lower-bound.ts "$PWD/docs/evidence/phase-6-web/overview-lower-bound"
PERF_AS_OF=2026-09-20T04:00:00Z FORMS=fixed pnpm --filter @fs-billing/db exec tsx scripts/overview-lower-bound.ts "$PWD/docs/evidence/phase-6-web/overview-lower-bound/september-asof"
```

执行时间中位数（范围），单位 ms：

| 月份（asOf）             | 语句       | 时间形式 | 无下界（基线）          | 有 31 天下界            | 差（下界减基线） |
| ------------------------ | ---------- | -------- | ----------------------- | ----------------------- | ---------------- |
| 10 月（2026-10-17）      | `answered` | 固定     | 13.59（13.35–13.78）    | 20.71（20.51–22.23）    | +7.1             |
| 10 月                    | `answered` | 生产     | 96.79（94.29–100.39）   | 128.04（126.04–130.24） | +31.3            |
| 10 月                    | `overview` | 固定     | 102.17（99.42–103.18）  | 107.70（105.39–112.33） | +5.5             |
| 10 月                    | `overview` | 生产     | 88.46（87.60–89.21）    | 96.24（95.01–99.26）    | +7.8             |
| 9 月（2026-09-20，整月） | `answered` | 固定     | 29.79（29.09–30.61）    | 29.59（29.34–31.29）    | −0.2             |
| 9 月                     | `overview` | 固定     | 136.33（132.24–139.80） | 148.93（146.35–153.50） | +12.6            |

计划里能看到的效果：下界使分区在执行器启动时多裁掉没有数据的分区（`Subplans Removed`：10 月固定 0 变 10，10 月生产 1 变 11，9 月固定 0 变 10）。被裁掉的分区在基线里是各返回 0 行的 `cdrs_*_tenant_id_answered_at_idx` 索引扫描，单个耗时在测量噪声以下。当前月份分区仍是整分区扫描：固定形式 14 万行的顺序扫描 13.6 ms，生产形式的同一扫描要 97 ms，计划里边界是含 `statement_timestamp()` 的表达式，推测每行都要重新求值（没有单独验证）。新增的下界条件是又一个同类的逐行过滤条件，推测这就是当前月份大分区上反而更慢的原因（生产形式 `answered` 多 31 ms）。9 月整月分区（60 万行里该租户 23 万行接通）走位图扫描，基线与下界的 `answered` 打平，整条查询的 +12.6 ms 超过两个范围各自的离散度，但没有解释它的来源，我没有进一步分析。

**这次数据给出的结论**：在 14 个分区、300 万条的数据上，31 天下界没有可测的收益，在当前月份反而变慢 5 至 31 ms。它省下的只是对更早分区的空索引探测，探测次数随分区数增长，这里只有 14 个分区，没有测过几年数据（几十个分区）的情形，也没有测过更大的租户。**是否加这个下界由用户决定**；按这些数据，我的倾向是不加。

## 验收映射表核对

按 [phase-6-design.md 验收标准对应计划测试](../../phase-6-design.md#验收标准对应计划测试)逐行用 grep 核对了点名的测试文件和名字。以下点名的从未创建，没有凭空补写，对应的断言存在于其他测试里，表中已改为实际的名字并说明：

- `apps/api/src/portal-cdrs.db.test.ts` 整个文件与其中的 `raw JSON of list and export carries no unverified key or value`；
- `apps/api/src/admin-ledger.db.test.ts` 整个文件（该断言在 `portal-ledger.db.test.ts` 的 `adds payment status, actor and internal note for admins only`）；
- `apps/api/src/portal-ledger.db.test.ts` 的 `raw JSON never carries the credit internal note, payment status or actor`（实际是 `shows a credit recharge as a recharge with the account recharge note and leaks no internal JSON keys or values`）；
- `packages/db/src/portal/cdrs.db.test.ts` 的 `lists a call answered at UTC 2026-09-28 16:30 under 2026-09-29 only`、`accepts from 0001-01-01 and returns only the rows inside that Beijing day`、`offers the countries seen in the range`、`counts hidden unanswered calls in the answered view`、`counts unverified calls for admins only`（实际断言在 `uses the Beijing answered date, applies filters, and counts hidden unanswered rows`、`includes unanswered rows only in all status and leaves totals on an empty page`、`does not expose unverified fields to portal JSON while admins can filter and count them`；`accepts from 0001-01-01 …` 这个名字只存在于 `ledger-merge.db.test.ts`）；
- `apps/api/src/admin-cdr-export.db.test.ts` 的 `writes one cdr_export audit with the filters and the row count` 与 `customer export writes no audit`（实际是 `streams unverified status and commits one acceptance audit with normalized filters`；客户导出不写审计在 `idor.db.test.ts` 的 `portalCdrsExport` 用例里比较前后条数）。

`pnpm test:db` 全部通过，所以这些是命名漂移，不是缺失的覆盖。上述缺口里有一处覆盖偏弱：话单列表的 API 层测试（`idor.db.test.ts` 的 `portalCdrs` 用例）对解析后的响应序列化后断言不含 `unverified`，严格 schema 本来会拒绝多余字段，不是对 `response.body` 原文的断言；原文断言在 e2e 里（真实网络响应）。

## 待用户确认或人工处理

1. 导出内存一项的通过口径（见上文）。
2. 截图一项的 6 个问题（见 [visual-diff.md](visual-diff.md#需要用户判断的项)）。
3. 31 天下界加不加（见上文）。
4. Excel 打开带 BOM 的 UTF-8 CSV 的显示需要在 Windows 上人工核对一次，没有自动化手段（[风险一节](../../phase-6-design.md#风险)已列）。
5. [PR 3 验收记录](../phase-6/README.md)正文的新进程 RSS 中位数与仓库里 `rss-isolated/summary.jsonl` 逐样本结果不一致（见上文导出一节）。
