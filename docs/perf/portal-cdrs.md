# 客户门户话单、余额流水与 CSV 导出的 PostgreSQL 17 性能原型

2026-10-17 在 PostgreSQL 17.9 上实测阶段 6 客户门户的三类读路径：话单列表（`docs/pages.md` §2.3）、余额流水（按天合并加累计余额）、话单 CSV 导出。验收标准见 `docs/plan.md` 阶段 6：300 万条话单上每月翻页每页小于 500 ms，10 万条导出小于 30 s 且内存不随条数线性增长。

- **话单列表**：不新增任何索引，现有 `cdrs_tenant_answered_at` 与 0010 的 `cdrs_tenant_started_at` 预计满足 500 ms 的预算。大租户一个北京月有 234,277 条已接通、12,297 条未接通，最差的一页加汇总栏约 290 ms（分开测得的单项 p50 相加，不是整请求实测）。整请求和 HTTP 验收在阶段 6 的 PR 3：`apps/api/scripts/portal-list-perf.ts` 经 HTTP 重复请求。
- **瓶颈**：汇总、模糊搜索和深翻页的约 100 ms 里，约四分之三是 RLS 谓词对每行重复调用 `current_setting`。把 `tenant_read` 策略改写成 InitPlan 形式后，汇总从 91 ms 降到 24 ms，深翻页从 48 ms 降到 16 ms。这是本次最大的杠杆，但属于安全策略改动，需要单独评审，见[RLS 谓词](#rls-谓词是读路径的主要耗时)。
- **余额流水**（修正排序键之前的聚合，PR 2 重测新查询）：先按北京日合并、再对约 33 行做窗口累计，用最近一张月账单的期末做锚点，三个月份都是 119 到 163 ms。后台现在的相关子查询写法一页要 54 s。
- **导出**：`DECLARE CURSOR` 加 `FETCH 5000`，10 万条 305 ms，20 万条的 RSS 比 5 万条只多约 15 MB，一次性查询则多约 198 MB。
- **预算缺口**：按现有索引，租户每月话单翻到 1.75 倍（约 41 万条）时，"全部"视图的深翻页加汇总会超过 500 ms，这个倍数是线性推算，没有实测。RLS 谓词改写后推算能撑到约 6 倍。

## 建议

| 问题             | 建议                                                                                           | 依据                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 翻页方式         | `LIMIT 50 OFFSET` 加总数。keyset 不上线，留作备用                                              | 设计稿要页码和"共 N 条"，keyset 无法跳页。OFFSET 最差一页：已接通 143 ms，全部 176 ms。keyset 任意深度 1.9 ms，已用 `verify` 确认与 OFFSET 同页同行 |
| 汇总栏           | 每次请求一条聚合 SQL，总数取自同一条的 `count(*)`；不做预聚合                                  | 已接通 100 ms，全部 110 ms，p95 不超过 113 ms。"含未接通 N"另一条 5.6 到 7.6 ms。耗时与月内行数线性，约每行 0.43 µs                                 |
| 索引             | 阶段 6 不加。下文给出两条可选索引的 DDL，只有在 RLS 改写后仍超预算时才采用                     | 现有索引下最差请求约 290 ms。两条候选合计 475 MB，约为整张话单堆的 70%                                                                              |
| 被叫号码模糊搜索 | 对 `billing_number` 做 `LIKE '%q%'`，不建 `pg_trgm`                                            | 常见子串 p50 102.5 ms，罕见子串 99 ms，p95 不超过 106 ms。搜索在月内扫描，耗时由月内行数决定                                                        |
| 国家筛选         | 直接加 `country = ?`，不建索引                                                                 | 首页 1.6 到 2.0 ms，汇总 21 到 47 ms，比不筛选的 100 ms 快                                                                                          |
| "全部"视图排序   | `ORDER BY coalesce(answered_at, started_at) DESC, call_uuid DESC`，与 design.md 的归属口径一致 | 不加索引时首页 138 ms，深页 176 ms，都在预算内。表达式索引把首页降到 1.6 ms，深页不变                                                               |
| 余额流水         | 先按北京日合并、再窗口累计，锚点用最近一张月账单期末，无月账单时回退为月初前流水合计           | 9 月 158 ms，10 月 119 ms，12 月 163 ms，与月份新旧无关。月初前求和锚点 9 月要 1123 ms                                                              |
| 后台流水（54 s） | 改成按月范围的窗口函数，不再逐行相关子查询                                                     | 同月逐条窗口加余额锚点 482 ms，约快 113 倍。无月份范围时的耗时没测                                                                                  |
| 导出             | `DECLARE ... NO SCROLL CURSOR`，`FETCH 5000`，边取边写                                         | 10 万条 305 ms，堆峰值稳定在约 68 MB。一次性查询 20 万条堆峰值 210 MB                                                                               |

## 话单列表

数据和口径见[数据和环境](#数据和环境)。每个变体在 `withTenant` 事务里执行，计时包含 `begin`、`set_config` 和 `commit`。20 轮，前 2 轮预热不计，每轮按轮换起点跑一遍全部变体。下表时间单位 ms。"基线"是现有索引，"候选"是再加两条候选索引（见[建议的 migration](#建议的-migration)）。原始数据见 [timings.json](portal-cdrs/timings.json)，各变体的 `EXPLAIN (ANALYZE, BUFFERS)` 在 [plans/baseline](portal-cdrs/plans/baseline) 和 [plans/candidates](portal-cdrs/plans/candidates)。

| 变体                               | 基线 p50 | 基线 p95 | 候选 p50 | 候选 p95 |
| ---------------------------------- | -------- | -------- | -------- | -------- |
| Q1 已接通 第 1 页                  | 2.1      | 2.9      | 1.8      | 2.0      |
| Q1 已接通 中间页（OFFSET 117,150） | 142.8    | 162.7    | 52.5     | 57.3     |
| Q1 已接通 最后一页（OFFSET）       | 140.2    | 143.7    | 98.9     | 104.6    |
| Q1 已接通 最后一页（反向取）       | 2.0      | 2.7      | 1.8      | 2.2      |
| Q1 已接通 中间页（延迟回表）       |          |          | 45.3     | 47.4     |
| Q2 全部 第 1 页（coalesce 排序）   | 138.3    | 141.8    | 1.6      | 2.1      |
| Q2 全部 中间页（coalesce 排序）    | 175.5    | 180.4    | 176.0    | 179.8    |
| Q2 全部 中间页（延迟回表）         |          |          | 117.5    | 121.9    |
| Q2 全部 第 1 页（UNION ALL 两路）  | 136.2    | 140.8    | 136.9    | 140.2    |
| Q2 全部 第 1 页（按 started_at）   | 1.9      | 2.5      | 1.6      | 1.9      |
| Q2 全部 中间页（按 started_at）    | 60.3     | 61.8     | 59.5     | 61.2     |
| Q3 已接通汇总                      | 100.1    | 103.7    | 100.2    | 102.4    |
| Q3 未接通计数                      | 7.6      | 8.5      | 5.6      | 5.9      |
| Q3 全部汇总                        | 110.4    | 112.3    | 109.7    | 113.0    |
| Q4 常见子串 第 1 页                | 102.7    | 105.1    | 102.5    | 105.0    |
| Q4 常见子串 汇总                   | 100.0    | 106.1    | 100.4    | 103.1    |
| Q4 罕见子串 第 1 页                | 99.3     | 104.7    | 99.0     | 102.6    |
| Q4 罕见子串 汇总                   | 99.1     | 103.1    | 97.8     | 100.1    |
| Q5 keyset 中间页                   | 1.9      | 2.6      | 1.7      | 1.8      |
| Q6 常见国家（中国）第 1 页         | 1.8      | 2.7      | 1.6      | 2.2      |
| Q6 常见国家 汇总                   | 47.0     | 53.6     | 46.4     | 47.6     |
| Q6 罕见国家（牙买加）第 1 页       | 2.0      | 2.5      | 1.8      | 2.1      |
| Q6 罕见国家 汇总                   | 21.6     | 23.1     | 21.4     | 21.9     |

读法。

- **Q1 第 1 页**：现有索引上 `Incremental Sort` 只取 50 行，已经是 2 ms。候选索引只改善深页。
- **Q1 深页**：基线对 OFFSET 11.7 万的中间页选了位图扫描加外部排序，`Sort Method: external merge  Disk: 27728kB`，耗时 143 ms。候选 `(tenant_id, answered_at, call_uuid)` 让索引顺序直接满足排序，去掉排序，降到 52 ms。后半段页反向取（升序跳过 `总数 - offset - 50` 条，应用层倒序）最后一页只要 2 ms。反向取的中间页没有单独测，按对称推断仍是 143 ms 左右，所以基线索引下反向取不改变最差情况。
- **Q2 全部视图**：基线要读整个月 246,574 行再 top-N 排序，第 1 页就是 138 ms。表达式索引把第 1 页降到 1.6 ms，中间页不变，因为规划器宁愿位图扫描加外部排序。强制关闭排序后同一张索引的中间页是 56 ms，见[调参对照](#调参对照)。`UNION ALL` 两路没有收益。按 `started_at` 排序能用现有索引，中间页 60 ms，但改变了排序口径，见下一节。
- **Q3、Q4**：基线和候选没有差别，所有行都要扫月内全部行，约 100 ms。
- **Q5**：keyset 在任何深度都是 1.7 到 1.9 ms，`verify` 断言它与 OFFSET 中间页返回同样的 50 个 `call_uuid`。
- **Q6**：筛选后首页很快，因为按序扫描很快凑齐 50 行命中。命中率更低的国家会扫更多行，最坏退化为扫整月。

### 计划摘录

基线中间页，位图扫描加外部排序：

```text
Limit  (actual time=143.295..143.299 rows=50 loops=1)
  ->  Sort  (actual time=137.295..141.461 rows=117150 loops=1)
        Sort Key: cdrs.answered_at DESC, cdrs.call_uuid DESC
        Sort Method: external merge  Disk: 27728kB
        ->  Append  (actual time=0.005..102.731 rows=234277 loops=1)
              ->  Bitmap Heap Scan on cdrs_2026_09 cdrs_2  (actual time=3.941..95.549 rows=234276 loops=1)
                    Heap Blocks: exact=6144
```

候选中间页，索引顺序直接满足排序：

```text
Limit  (actual time=53.283..53.306 rows=50 loops=1)
  ->  Merge Append  (actual time=0.010..51.443 rows=117150 loops=1)
        ->  Index Scan Backward using cdrs_2026_09_tenant_id_answered_at_call_uuid_started_at_idx on cdrs_2026_09 cdrs_2
              (actual time=0.005..47.695 rows=117150 loops=1)
```

"全部"第 1 页，基线与候选：

```text
-- 基线
Sort  Sort Key: (COALESCE(cdrs.answered_at, cdrs.started_at)) DESC, cdrs.call_uuid DESC
      Sort Method: top-N heapsort  Memory: 50kB
  ->  Bitmap Heap Scan on cdrs_2026_09 cdrs_2  (actual time=4.033..101.542 rows=246573 loops=1)
-- 候选
Merge Append  Sort Key: (COALESCE(cdrs.answered_at, cdrs.started_at)) DESC, cdrs.call_uuid DESC
  ->  Index Scan Backward using cdrs_2026_09_tenant_id_coalesce_call_uuid_started_at_answer_idx
        (actual time=0.010..0.033 rows=50 loops=1)
```

已接通汇总，两边都读月内全部行：

```text
->  Bitmap Heap Scan on cdrs_2026_09 cdrs_2  (actual time=4.037..92.995 rows=234276 loops=1)
      Filter: (answered_at >= ... AND answered_at < ... AND COALESCE((current_setting('app.scope'::text, true) = ANY ...
      Rows Removed by Filter: 12299
      Heap Blocks: exact=6144
```

列表和汇总计划只访问 `cdrs_2026_08` 和 `cdrs_2026_09`，其他月份分区在规划期被裁剪。延迟回表的连接腿列出了全部分区，但除命中的分区外都是 `never executed`。8 月分区只返回 1 行，那是 8 月 31 日接通以前开始、9 月 1 日零点后接通的跨月通话，`fixture.json` 里 `answered_crossing` 为 1。`started_at` 的下界取月初前一天并在应用层算好再传参，规划期就能裁剪分区（`$1 - interval` 是 STABLE，只能在执行期裁剪）。

### 全部视图的排序口径

`docs/design.md` 规定已接通按接通时间、未接通按开始时间归属，所以全部视图的月份归属和排序都用 `coalesce(answered_at, started_at)`。测试数据的振铃最长 27 s。按 `started_at` 排序时，相邻两行的先后顺序可能与页面显示的接通时间相差一个振铃时长，中间页能用现有索引做到 60 ms。这是产品取舍，不是性能问题，本次不建议采用，除非"全部"深翻页变成瓶颈。

### 调参对照

默认配置是 `random_page_cost=4`、`work_mem=4MB`，生产多半是 SSD。为排除"基线只是没调参"，用 `PERF_SETTINGS="random_page_cost=1.1,work_mem=64MB"` 对关键变体重测 10 轮，数据见 [tuned.json](portal-cdrs/tuned.json)。

| 变体                | 基线 p50 / p95 | 候选 p50 / p95 |
| ------------------- | -------------- | -------------- |
| Q1 第 1 页          | 3.0 / 4.0      | 2.7 / 3.6      |
| Q1 中间页           | 60.0 / 61.6    | 50.5 / 53.0    |
| Q1 最后一页         | 118.0 / 120.9  | 96.3 / 99.5    |
| Q2 全部 第 1 页     | 139.4 / 144.5  | 2.6 / 4.1      |
| Q2 全部 中间页      | 162.7 / 175.4  | 161.8 / 175.5  |
| Q3 已接通汇总       | 104.2 / 114.3  | 103.0 / 110.9  |
| Q4 常见子串 第 1 页 | 104.9 / 107.0  | 105.2 / 110.3  |

调参后基线 Q1 中间页从 143 ms 降到 60 ms：规划器改用有序索引扫描加 `Incremental Sort`，不再外部排序。所以 Q1 深页的候选索引收益在生产配置下只剩 60 到 50 ms，更不需要。Q2 全部中间页仍是 162 ms，计划是 `started_at` 索引扫描加 65 MB 的 top-N 排序。另做一次只用于诊断的对照，加上 `enable_sort=off` 强制走表达式索引的有序扫描，中间页 56.1 / 58.3 ms，延迟回表 49.1 / 51.8 ms。这说明候选索引本身够用，是规划器没选它；`enable_sort=off` 不能用于生产。

## RLS 谓词是读路径的主要耗时

汇总、模糊搜索这类扫描月内约 24 万行的查询约 100 ms，计划里只有一个 `Bitmap Heap Scan`，读 6144 页全在 shared buffers，I/O 不是瓶颈。对照实验发现这 100 ms 大部分在 RLS 谓词。`cdrs` 的 `tenant_read` 策略是 `app_can_see(tenant_id)`，内联后成为逐行求值的 `current_setting('app.scope')` 和 `nullif(current_setting('app.tenant_id'), '')::uuid`，出现在每个扫描节点的 `Filter` 里。这些函数 `provolatile = s`、`proparallel = u`。

三项对照。

- 以库主身份（绕过 RLS）执行同一条汇总：并行计划（`Gather`，2 个 worker），13 到 21 ms。关闭并行后 18 到 21 ms，仍是 index-only 扫描。同一个索引、同一批行，`fs_billing_app` 身份要 101 ms，且没有并行。
- 在事务内把 `tenant_read` 改成 InitPlan 形式后以 `fs_billing_app` 身份重跑，事务 `rollback`，库不变。改写后的计划仍然没有并行，谓词变成 `(InitPlan 1).col1 OR ...`，只求值一次，所以收益来自去掉逐行求值，不是并行：

  ```sql
  ALTER POLICY tenant_read ON cdrs USING (
    (SELECT app_is_operator())
    OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id())));
  ```

- 覆盖索引不能替代它：在 9 月分区临时建 `(tenant_id, answered_at) INCLUDE (started_at, billed_minutes, charge, country)`，汇总变成 `Index Only Scan`、`Heap Fetches: 0`、读页从 7361 降到 2227，耗时仍是 101 ms，见 [covering-summary.txt](portal-cdrs/probes/covering-summary.txt)。瓶颈是逐行 CPU，不是读页。测完已删除该索引。

| 变体（含候选索引，各 6 遍）   | 原策略 p50 | InitPlan 策略 p50 | 倍数 |
| ----------------------------- | ---------- | ----------------- | ---- |
| Q3 已接通汇总                 | 91.4       | 23.9              | 3.8  |
| Q1 中间页                     | 48.2       | 15.7              | 3.1  |
| Q4 常见子串 第 1 页           | 106.4      | 35.9              | 3.0  |
| Q7 9 月按天窗口（月账单锚点） | 159.1      | 89.8              | 1.8  |

后三行改写了 `cdrs`、`ledger_entries`、`monthly_statements` 三张表的策略。脚本和原始输出见 [rls-initplan.sql](portal-cdrs/probes/rls-initplan.sql) 与 [rls-initplan.txt](portal-cdrs/probes/rls-initplan.txt)，每个数字是各 6 遍的中位数，首遍偏慢。

建议：把这条作为单独的变更评审，不并入阶段 6 的性能结论。它改动所有租户可见表的读策略，两种写法等价（`tenant_id = NULL` 在过滤里不通过，与 `coalesce(..., false)` 相同），但必须跑 `pnpm test:db` 的 RLS 用例。本次没有跑，也没有把它加进 `packages/db/migrations`。收益是读路径整体约 3 到 4 倍，对租户翻倍的余量比任何新索引都大。

## 余额流水

本节全部数字测的是修正排序键之前的合并查询（按 `at, id NULLS FIRST` 排序开窗，没有 `array_agg(id ORDER BY occurred_at DESC, id DESC)` 算出的 `sort_id`）。现在的查询多了这个有序聚合，耗时没有重测。PR 2 用同一个脚本 `packages/db/scripts/portal-perf.ts` 在 `fs_billing_perf` 上重测并把结果记在这里。

门户余额流水要把通话扣费按北京日合并，并显示每行变动后的累计余额。比较三种写法和三种锚点（月初余额），都在 `fs_billing_perf` 的大租户上（285 万条扣费流水加 38 条人工流水，分布在 13 个北京月）。

- **逐条窗口**：先对月内每条流水算 `sum(amount) over (order by occurred_at, id)`，再把扣费按天合并取当天最后一笔后的余额。
- **按天窗口**：先 `group by` 北京日合并，再对约 33 行做窗口。合并行放在当天最后一笔扣费的时间，相邻行的余额逐行对得上。`verify` 断言了这一点，也断言合并行余额等于逐条窗口里当天最后一笔后的真实余额。
- **锚点**：`prior` 是月初前全部流水之和，`balance` 是 `tenant_balances` 减月初及之后的流水，`statement` 是最近一张月账单期末加它之后到月初的流水。

| 变体                                | 基线 p50                       | 基线 p95 | 候选 p50 | 候选 p95 |
| ----------------------------------- | ------------------------------ | -------- | -------- | -------- |
| 9 月 逐条窗口，prior 锚点           | 1299.8                         | 1470.6   | 1307.8   | 1315.4   |
| 9 月 逐条窗口，balance 锚点         | 481.6                          | 503.2    | 479.8    | 487.2    |
| 9 月 按天窗口，prior 锚点           | 1122.7                         | 1172.2   | 1127.0   | 1169.6   |
| 9 月 按天窗口，balance 锚点         | 299.5                          | 312.1    | 297.8    | 302.8    |
| 9 月 按天窗口，statement 锚点       | 158.0                          | 161.5    | 158.3    | 161.7    |
| 10 月（本月）按天窗口，balance 锚点 | 168.5                          | 173.8    | 166.8    | 170.9    |
| 10 月 按天窗口，statement 锚点      | 119.2                          | 121.5    | 118.8    | 121.7    |
| 上年 12 月 按天窗口，prior 锚点     | 312.0                          | 339.1    | 311.4    | 320.0    |
| 上年 12 月 按天窗口，balance 锚点   | 1136.1                         | 1237.2   | 1143.4   | 1166.3   |
| 上年 12 月 按天窗口，statement 锚点 | 163.3                          | 175.3    | 163.1    | 168.6    |
| 后台现状，9 月 50 行（3 次）        | 54,743.7 / 54,171.5 / 54,252.9 |          |          |          |

两条候选索引都与流水无关，基线与候选的差只是噪声。

- **窗口位置**：同样用 prior 锚点，按天窗口 1123 ms，逐条窗口 1300 ms；同样用 balance 锚点，300 ms 对 482 ms。逐条窗口要对月内 23 万行排序累计，按天窗口只对约 33 行。
- **锚点**：`statement` 是唯一与月份新旧无关的，三个月都是 119 到 163 ms，主要耗时是月内 `group by`。`prior` 要读月初前全部流水，9 月前有约 270 万行，所以 1123 ms，12 月前流水少，只要 312 ms。`balance` 要读月初之后全部流水，12 月之后有 250 万行，1136 ms。
- **边界情况**：`statement` 锚点在没有任何月账单时返回空行，余额成为 `NULL`。生产实现需要回退到 `prior`（没有月账单就意味着租户很新，前面流水少，开销小）。脚本里 `verify` 断言三种锚点在 9 月、10 月、12 月结果完全一致。
- **后台现状**：`packages/db/src/admin/balance.ts:41` 对每行执行一个相关子查询，求所有更早流水之和。9 月一页 50 行要对 272 万行求和 50 次，每次约 1.1 s，合计 54 s（`read=3678216` 个缓冲页）。解释计划见 [q7-admin-correlated-sum.txt](portal-cdrs/plans/candidates/q7-admin-correlated-sum.txt)。
- **对后台的意义**：把 `balanceAfter` 改成对筛选范围内行的窗口函数加月初锚点，同月逐条窗口加 balance 锚点是 482 ms，约快 113 倍。后台没有月份筛选时（扫全部 285 万条流水再取 50 行）耗时没测，不能引用上面的数字，需要先限定范围或另行测量。按页只算页内行余额（总余额减去更新的流水之和）更便宜，也没有测。

## 汇总栏、总数与整请求

一次翻页请求至少含一条列表 SQL 和一条汇总 SQL，已接通视图再加一条未接通计数。下面是已测单项 p50、p95 相加，不是整请求实测。

| 请求                         | 基线 p50 | 基线 p95 | 说明                                |
| ---------------------------- | -------- | -------- | ----------------------------------- |
| 已接通 中间页加汇总加未接通  | 250.5    | 274.9    | 142.8 + 100.1 + 7.6                 |
| 全部 中间页加汇总            | 285.9    | 292.7    | 175.5 + 110.4                       |
| 已接通 第 1 页加汇总加未接通 | 109.8    | 115.1    | 2.1 + 100.1 + 7.6，汇总栏仍要扫整月 |

汇总是首页的主要耗时。两条 SQL 放在同一个事务里串行执行；用两个连接并行的话，请求耗时变成较慢的一条，但没有测。

## 冷缓存

`coldObservation` 对 Q1 第 1 页、Q1 中间页、Q3 汇总，先用 `pg_buffercache_evict` 清掉本库全部 shared_buffers，再用新连接 `DISCARD ALL` 后连跑 3 次。

| 变体          | 清掉的缓冲页 | 3 次耗时 ms         |
| ------------- | ------------ | ------------------- |
| Q1 第 1 页    | 16342        | 9.7, 1.9, 1.8       |
| Q1 中间页     | 219          | 152.2, 135.8, 140.0 |
| Q3 已接通汇总 | 7574         | 116.6, 103.7, 101.6 |

清缓冲后第一次比热的慢，第 1 页多 8 ms，汇总多 13 ms，中间页多约 16 ms。容器的 OS 页缓存仍是热的，这不是冷磁盘，真正的磁盘冷读没有测。数据集 2.9 GB，`shared_buffers` 只有 128 MB，所以热态数字已经包含从 OS 缓存拷贝页的开销。

## 索引大小

3,000,000 条话单（加 38 万条其他租户话单，合计约 340 万行），话单堆 670 MB。大小来自 `timings.json` 的 `indexSizes`，是所有分区之和。

| 索引                        | 大小   | 说明                                                                                                |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `cdrs_tenant_answered_at`   | 226 MB | 现有，`(tenant_id, answered_at)`                                                                    |
| `cdrs_tenant_started_at`    | 133 MB | 现有，0010                                                                                          |
| `cdrs_tenant_answered_keys` | 222 MB | 候选，`(tenant_id, answered_at, call_uuid) INCLUDE (started_at)`                                    |
| `cdrs_tenant_all_keys`      | 253 MB | 候选，`(tenant_id, coalesce(answered_at, started_at), call_uuid) INCLUDE (started_at, answered_at)` |

两条候选合计 475 MB，约为话单堆的 71%。每条话单入库、更新接通信息时都要多写两条索引项，这个写放大没有测。

## 导出

导出查询按 `answered_at, call_uuid` 取 2026-09 北京月内全部已接通话单，转成 CSV（`BOM + 表头 + CRLF`，按 RFC 4180 加引号）写文件。每次在独立子进程里跑，记录耗时和峰值 RSS，3 轮交替跑游标和一次性查询。一次性查询是 `select` 全部行进内存再拼字符串。游标是 `DECLARE portal_export NO SCROLL CURSOR FOR ...`，每次 `FETCH 1000`。数据见 [export.json](portal-cdrs/export.json)，每轮断言行数和文件行数。

| 方式            | 条数    | 耗时 ms（中位数） | 峰值 RSS MB | 堆峰值 MB |
| --------------- | ------- | ----------------- | ----------- | --------- |
| 游标 FETCH 1000 | 50,000  | 324               | 151.5       | 66.3      |
| 游标 FETCH 1000 | 100,000 | 681               | 156.3       | 66.2      |
| 游标 FETCH 1000 | 200,000 | 1626              | 166.6       | 74.1      |
| 一次性查询      | 50,000  | 191               | 173.1       | 64.2      |
| 一次性查询      | 100,000 | 325               | 241.7       | 112.7     |
| 一次性查询      | 200,000 | 522               | 371.4       | 210.6     |

子进程启动后 RSS 是 132 MB。

- **内存**：一次性查询每多一千行多约 1.3 MB（5 万到 20 万条，RSS 多 198 MB），游标每多一千行约 0.1 MB（多 15 MB）。游标的堆峰值 66 到 74 MB 基本不随条数变化，增长部分是垃圾回收滞后，不是累积。验收的"内存不随条数线性增长"成立。
- **耗时**：游标比一次性查询慢，10 万条 681 ms 对 325 ms。限制因素是 `FETCH` 往返次数，不是计划。补充实验（[export-probe.json](portal-cdrs/export-probe.json)，10 万条，各 3 次）：

  | FETCH 大小        | 100  | 1000 | 5000 | 1000 且 `cursor_tuple_fraction=1` |
  | ----------------- | ---- | ---- | ---- | --------------------------------- |
  | 耗时 ms（中位数） | 655  | 430  | 305  | 357                               |
  | 堆峰值 MB         | 67.8 | 68.2 | 67.8 | 66.7                              |

  `FETCH 5000` 最快，且内存不变，建议采用。`cursor_tuple_fraction=1` 能再快约 17%，这一项收益小，不建议为它改会话设置。这组 `FETCH 1000` 的 430 ms 与上表主跑的 681 ms 差较大，两次运行之间机器负载可能不同（机器上有其他进程，负载均值约 2.6），原因没有进一步查，所以 10 万条导出的区间应当读作 0.3 到 0.8 s。

- **大租户**：`PORTALBIG` 的 9 月有 234,277 条，游标 1.1 到 1.2 s（RSS 159 到 162 MB），一次性查询 0.6 s（RSS 417 MB）。
- **预算**：10 万条 0.3 到 0.8 s，对 30 s 有 40 倍以上余量。10 万条文件 11.2 MB，真实客户下载时，带宽低于约 3 Mbit/s 才会逼近 30 s，这是算术，没有测。
- **没有覆盖的部分**：脚本写文件，不含 HTTP、压缩和慢客户端。游标要求整个导出在一个事务里完成，慢客户端会长时间占住一个连接和一个快照，需要 `statement_timeout`、`idle_in_transaction_session_timeout` 和连接池上限保护。
- **CSV 内容**：`callee` 列保留原始拨号串，可能以 `+` 或 `00` 开头。以 `+` 开头的单元格在 Excel 里会被当成公式或数字，生产实现要决定是否加前缀。本脚本沿用 `formatRateCsv` 的引号规则（已把 `quote` 导出为 `quoteCsvCell` 供脚本使用），没有处理这一点。

## 建议的 migration

两条索引都是可选项，不在 `packages/db/migrations`。如果采用，注意 0010 开头的注释：普通 `CREATE INDEX` 在分区父表上会阻塞写入，且 migrator 在事务内运行，只适合上线前的空库、开发库和 CI。上线后必须按分区 `CREATE INDEX CONCURRENTLY`，在事务外，再挂到用 `ON ONLY` 建的父索引上，流程见 `docs/plan.md` 阶段 10 的运行手册。

```sql
-- 上线前：开发库、CI 与空库。
CREATE INDEX cdrs_tenant_answered_keys
  ON cdrs (tenant_id, answered_at, call_uuid) INCLUDE (started_at);
CREATE INDEX cdrs_tenant_all_keys
  ON cdrs (tenant_id, (coalesce(answered_at, started_at)), call_uuid)
  INCLUDE (started_at, answered_at);
```

```sql
-- 上线后：父索引 ON ONLY，逐分区 CONCURRENTLY（事务外），再 ATTACH。
CREATE INDEX cdrs_tenant_all_keys ON ONLY cdrs
  (tenant_id, (coalesce(answered_at, started_at)), call_uuid)
  INCLUDE (started_at, answered_at);
-- 对每个分区重复，例如 cdrs_2026_09：
CREATE INDEX CONCURRENTLY cdrs_2026_09_tenant_all_keys ON cdrs_2026_09
  (tenant_id, (coalesce(answered_at, started_at)), call_uuid)
  INCLUDE (started_at, answered_at);
ALTER INDEX cdrs_tenant_all_keys ATTACH PARTITION cdrs_2026_09_tenant_all_keys;
```

如果只能选一条，选 `cdrs_tenant_all_keys`：它让全部视图第 1 页从 138 ms 降到 1.6 ms（86 倍），是唯一一个数量级的变化。`cdrs_tenant_answered_keys` 只让深页从 143 ms 降到 52 ms，调参后基线本身就是 60 ms，不值得 222 MB。

## 预算缺口

- **500 ms**：300 万条话单、单月 23 万条已接通的租户，各单项 p50 相加的组合都低于 300 ms，预计满足预算，没有缺口。这些组合是单项相加，不是整请求实测，整请求和 HTTP 验收在阶段 6 的 PR 3。
- **租户翻倍**：耗时随月内行数线性增长（每行约 0.4 µs），翻倍后"全部"中间页加汇总约 570 ms，超过预算（推算，没有实测）。按此推算现有索引的上限约 41 万条/月。单项里，Q3 汇总翻倍后约 200 ms，Q4 约 200 ms，Q1 中间页约 290 ms，都在预算内，是组合超了。
- **候选索引能多撑多少**：只改善已接通深页（143 到 52 ms，翻倍后约 105 ms）和"全部"第 1 页。汇总、模糊搜索和"全部"深页都不变，所以租户翻倍后"全部"中间页加汇总仍约 570 ms。
- **RLS 改写**：按本次测得的 3 到 4 倍推算，约能撑到 6 倍（约 140 万条/月），没有实测，也没有在翻倍租户上验证。
- **后台流水**：现状 54 s，远超任何合理预算。
- **没有缺口的项**：导出 10 万条 0.3 到 0.8 s（预算 30 s）；余额流水按天窗口 119 到 163 ms（修正排序键之前的聚合的实测，PR 2 重测），但翻倍后每月流水到 50 万行，线性推算约 320 ms。

## 数据和环境

测量环境为本地 OrbStack Docker，ARM64 PostgreSQL 17.9（容器 `fs-billing-postgres-1`），10 个逻辑 CPU，约 8 GiB 内存。库是同一容器里独立的 `fs_billing_perf`，不是开发库 `fs_billing`。服务器使用默认配置：`shared_buffers=128MB`、`work_mem=4MB`、`random_page_cost=4`、`jit=on`、`max_parallel_workers_per_gather=2`、`effective_cache_size=4GB`。完整设置和数据概况见 [fixture.json](portal-cdrs/fixture.json)。测量时机器上还有其他进程，接手后查看时负载均值约 2.6。

数据是合成的，不含客户数据。固定 `asOf=2026-10-17T04:00:00Z`，测量月是 2026-09 北京月（`2026-09-01 00:00+08` 到 `2026-10-01 00:00+08`）。

- **大租户 `PORTALBIG`**：300 万条话单，均匀分布在最近 365 天，12 个以上北京月，95% 接通。9 月有 234,277 条已接通和 12,297 条未接通；跨月接通 1 条；最长振铃 27 s；3 万条（1%）`unverified`。国家 20 个，按 `u^2.5` 偏斜，中国占 9 月已接通的 30%（70,390 条），牙买加 2%（4,815 条）。10% 的话单打给 2000 个常用号码，子串 `100000` 命中 11,821 条，`424242` 只命中 1 条。流水 2,850,149 条通话扣费，另有每月 1 日充值、15 日赠送、20 日调账各 12 到 13 条，以及每个完整月一行月账单。
- **导出租户**：`EXPORT50K`、`EXPORT100K`、`EXPORT200K`，各自在 2026-09 月内全部接通。
- **三个小租户 `PORTALS1` 到 `PORTALS3`**：各 3 万条，用来验证 RLS 隔离。
- **库大小**：2884 MB，在建候选索引之前测得，不含两条候选。

**测量了什么**

- 每个计时的 SQL 都断言返回非空；`verify` 在计时前断言：keyset 页等于 OFFSET 页，反向最后一页等于正向最后一页，已接通、未接通、全部、两个子串的计数都等于库主直查的真值，三种余额锚点结果相同，最新一行余额等于 `tenant_balances`，另一个租户看不到大租户话单。候选索引建成后再断言延迟回表页等于普通页。导出断言条数和文件行数。
- 基线与候选两个阶段是先后各 20 轮，不是交替；两个阶段之间建索引并 `vacuum (analyze)`。每个阶段内变体轮换起点。
- 计时用单连接 `pg`，在 Node 端测，包含事务开关和往返，不含 HTTP。p95 取 20 个样本的第 19 个，所以接近最大值，读作"最差几次"。

**没有测量的部分**：冷磁盘读取；并发（单连接）；HTTP 层、序列化和压缩；写入侧（索引写放大、扣费入库）；翻倍租户（用线性推算）；`pg_trgm`；以上都是结论的局限。

## 复现

使用本地 PostgreSQL 17 的专用库。脚本只允许回环地址和名为 `fs_billing_perf` 的库，`app` 连接必须是 `fs_billing_app`；`seed` 对已种满的租户跳过，对半途中断的租户会失败，需要删库重建。需要先对该库跑迁移并写入管理员，这两步在本次接手前已完成，下面的命令没有在新库上重跑验证。

```sh
docker exec fs-billing-postgres-1 psql -U fs_billing -d postgres -c 'create database fs_billing_perf'
DATABASE_URL=postgresql://fs_billing:local-development-only@127.0.0.1:5432/fs_billing_perf \
APP_DATABASE_URL=postgresql://fs_billing_app:local-app-only@127.0.0.1:5432/fs_billing_perf \
  sh -c 'pnpm db:migrate && pnpm db:seed'

export PERF_DATABASE_URL=postgresql://fs_billing:local-development-only@127.0.0.1:5432/fs_billing_perf
export PERF_APP_DATABASE_URL=postgresql://fs_billing_app:local-app-only@127.0.0.1:5432/fs_billing_perf
export PERF_AS_OF=2026-10-17T04:00:00Z

cd packages/db
pnpm exec tsx scripts/portal-perf.ts seed
pnpm exec tsx scripts/portal-perf.ts measure
```

`seed` 约 3 百万行加 285 万条流水。`measure` 依次完成清理候选索引、基线 20 轮、建候选索引、候选 20 轮、后台现状 3 次、冷缓存观察、导出，写入 `docs/perf/portal-cdrs/`。结果 JSON 用 `JSON.stringify` 写出，提交前需要 `pnpm exec prettier --write docs/perf/portal-cdrs/*.json`，否则 `pnpm format:check` 会失败。

调参和只测部分变体用环境变量，不动其余结果：

```sh
PERF_OUT=/tmp/portal-tuned PERF_ROUNDS=10 \
PERF_SETTINGS="random_page_cost=1.1,work_mem=64MB" \
PERF_ONLY='^(Q1 answered (mid|last)|Q2 all (p1|mid)|Q3 answered summary)$' \
  pnpm exec tsx scripts/portal-perf.ts measure

PERF_FETCH=5000 pnpm exec tsx scripts/portal-perf.ts export EXPORT100K cursor /tmp/export.csv
docker exec -i fs-billing-postgres-1 psql -U fs_billing -d fs_billing_perf \
  < docs/perf/portal-cdrs/probes/rls-initplan.sql
```

`PERF_ONLY` 设置后跳过冷缓存观察、后台现状和导出。`measure` 会删除并重建两条候选索引，结束时库处于"候选索引已建"的状态。本次测完保留了 `fs_billing_perf`，没有删除。

## 文件

- [fixture.json](portal-cdrs/fixture.json)：服务器设置、各租户行数、分区、流水、`facts`。
- [timings.json](portal-cdrs/timings.json)：基线与候选各变体 p50/p95，冷缓存，索引大小，后台现状 3 次。
- [tuned.json](portal-cdrs/tuned.json)：调参对照和强制不排序的诊断对照。
- [export.json](portal-cdrs/export.json)、[export-probe.json](portal-cdrs/export-probe.json)：导出 3 轮和 FETCH 大小补充实验。
- [plans/baseline](portal-cdrs/plans/baseline)、[plans/candidates](portal-cdrs/plans/candidates)：每个变体的 `EXPLAIN (ANALYZE, BUFFERS)`。
- [probes](portal-cdrs/probes)：RLS 策略对照和覆盖索引实验。

全部文件合计小于 1 MB，所以保留了完整计划。脚本是 `packages/db/scripts/portal-perf.ts`。
