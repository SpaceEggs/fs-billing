# 费率表五列 PR A 验收

2026-10-20，基于 `origin/main` 的 `2494319` 实现 [rate-list-design.md](../../rate-list-design.md) 的 PR A。后台五列布局属于 PR B。所有写入和迁移均在独立 PostgreSQL 17.9 容器（端口 55434）执行。原工作区和原数据库保持原样；既有性能库仅用于只读 `pg_dump`，复制到独立容器后才迁移、测量。

## 检查结果

| 命令                                                  | 结果                                                                                   | 原始输出                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm check`                                          | lint、格式、类型、单测、Web 构建通过；核心 730 项通过、1 项跳过，Web 391 项通过        | [check.txt](check.txt)                                                            |
| `pnpm db:migrate && pnpm db:seed && pnpm db:migrate`  | 空库成功、再次迁移无变化，种子费用与余额不变                                           | [migrate-seed-migrate.txt](migrate-seed-migrate.txt)                              |
| `pnpm test:db`                                        | 32 个文件、467 项通过                                                                  | [test-db.txt](test-db.txt)                                                        |
| `pnpm test:idor`                                      | 27 项通过                                                                              | [test-idor.txt](test-idor.txt)                                                    |
| `pnpm --filter @fs-billing/api prove:idor <证据目录>` | CI 同款双层隔离证明通过；移除租户 WHERE 后 owner 路径能检测泄漏，app 路径仍由 RLS 隔离 | [prove-idor.txt](prove-idor.txt)、[mutation-proof.json](idor/mutation-proof.json) |
| `pnpm perf:authorize`，连续 5 次                      | 每次 500 条非空 ISO/说明费率、1000 个真实 HTTP 请求，响应逐一校验，全部 `passed: true` | [perf-authorize.txt](perf-authorize.txt)                                          |
| `pnpm test:e2e`                                       | 49 项通过，1 项按配置跳过（PR B 的视觉对照）                                           | [test-e2e.txt](test-e2e.txt)                                                      |

IDOR 的四组 Vitest 报告和覆盖清单保存在 `idor/`。四份重复的 OpenAPI 文件只保留 SHA-256，见 [openapi-hashes.json](idor/openapi-hashes.json)，历史阶段 4 的 OpenAPI 证据没有修改。

## 数据与边界

[迁移与种子 SQL 输出](migration-probe.txt) 包含迁移 0016 在临时旧表、旧分区上的前后查询。费率旧行新增字段为空串，话单旧行新增字段为 NULL，原「英国手机」文本保持原样；两个表的 `relfilenode` 前后相同。完整迁移链和默认值、约束、分区、幂等性另由数据库测试验证。

种子 `447700900123` 的快照为 `GB / 英国 / 手机`；费率 `44` 为 `GB / 英国 / 空说明`，共用前缀 `1` 的 ISO 为空。Worker 数据库测试同时推送 447、44、1 和未接通话单，验证空串写 NULL。种子里的 447 在 10 月 1 日前后仍为 0.0450、0.0480。

测试覆盖强制表头、三种表头别名、BOM/CRLF、行尾空列、物理行错误、重复前缀、ASCII 两位 ISO、CSV 往返；缺少新字段的旧预览保持未消费并报 `PREVIEW_STALE`，旧取消审计补空字段后仍可读取。ISO 在转大写前先检查 ASCII 字母，避免 `ß` 转成 `SS` 后被错误接受。

数据库与 API 测试验证四项搜索、只改 ISO 或说明的版本差异、开户与复制保留字段、门户/后台话单分列、国家选项去重、话单导出的三列及公式中和。IDOR 夹具为不同租户写入不同 ISO/说明并检查各自响应。

## 性能门槛

授权 p95 的五次原值为 9.666, 16.606, 19.642, 8.273, 11.675 ms，中位数 11.675 ms，范围 8.273–19.642 ms，均小于 50 ms。主机 10 核，开始时 load average 为 4.74 / 4.98 / 3.59；部分运行与 `pnpm check` 重叠。测量包含 loopback HTTP、每次读取 500 条费率、业务授权和 JSON 响应校验，不是拒绝请求或未消费的调用。这是本机门槛验收，没有与历史环境比较，也不据此宣称加速或回归。

`portal-list-perf.ts` 在复制并迁移后的 300 万条 UUID v4 性能库上运行 5 轮；目标月份已接通 234277 条、全部 246574 条，80 个实测请求全部成功且小于 500 ms，最慢 280.0 ms。查询场景包括门户、后台、被叫、国家、未经验证及深页。完整消费响应后再按 strict schema 校验。详见 [list-latency.txt](list-latency.txt)。复现命令（工作目录 `apps/api`）：

```sh
PERF_TARGET_DATABASE=fs_billing_perf_pr3_uuid_v4 PERF_DATABASE_PORT=55434 PERF_ROUNDS=5 node --env-file-if-exists=../../.env --import tsx scripts/portal-list-perf.ts
```

该命令需要本地 `.env` 配置属主、app、auth 连接和至少 32 字符的 `BETTER_AUTH_SECRET`，先在复制库执行 `pnpm db:migrate`。原脚本的默认证据路径仍指向阶段 6，实际输出重定向到本目录。首次尝试因未配置性能测试的认证密钥而在发请求前退出，配置本地临时密钥后重跑成功；统计只取完整的成功运行。

## 后续工作

本地未执行测试服重建、部署和 Windows Excel 人工核对。PR B 实现后台五列布局、ISO/说明编辑和可见性提示；阶段 6 PR 4、5 用 `formatCountryLabel` 展示最近话单和话单列表。PR A 没有改这些页面的布局。

## 2026-10-20 审阅补验

补齐审阅指出的四处遗漏：

- 阶段 6 设计的 `components/data-format.tsx` 行补上 `formatCountryLabel` 的共用位置和用途；决定 7 的来源补为「用户 2026-10-19 确认（费率表五列）」。
- 开户 API 的负费率 CSV 补上五列表头，并断言第 2 行的具体原因「费率不能为负：-1」，防止表头错误也让测试通过。
- 视觉用例的非法前缀行改成五列，并断言首条原因「前缀只能是数字：8a6」。显式启用视觉测试后脚本通过，浅色截图人工核对了对应文字；保存[浅色](review-import-errors-light.png)和[深色](review-import-errors-dark.png)截图。这次仅核对夹具和错误文案，不表示 PR B 五列界面的视觉验收已完成。
- 增加真实 `public.cdrs` 分区表的 ISO 行为测试。向父表插入接通话单，确认 `NULL` 和 `GB` 成功并落入 `cdrs_2026_10`；`gb`、`GBR` 均报 SQLSTATE `23514` 且约束名为 `cdrs_iso_check`。不依赖临时表重放迁移。

验证结果：

- `pnpm check` 通过，见 [review-followup-check.txt](review-followup-check.txt)。
- 开户 API 与 CDR 存储两个文件共 46 项通过，见 [review-followup-db.txt](review-followup-db.txt)；最终 CDR 文件复跑 28 项通过，见 [review-followup-cdrs.txt](review-followup-cdrs.txt)。
- `FSB_VISUAL=1 FSB_EVIDENCE_DIR=/tmp/rate-list-pr-a-followup-visual pnpm --filter @fs-billing/web exec playwright test e2e/admin-visual.spec.ts` 通过，完整运行浅色、深色和手机场景，见 [review-followup-visual.txt](review-followup-visual.txt)。其余生成截图留在该临时目录，没有覆盖阶段 5 的历史对照证据。
