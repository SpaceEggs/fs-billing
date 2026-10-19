# 费率表五列改造设计（ISO / 国家 / 号码前缀 / 说明 / 费率）

本文是实施方案，交给实现者逐步执行。依据是 2026-10-19 起草时的 `origin/main`（`331779b`）和阶段 6 PR 3 分支 `origin/codex/phase-6-pr3-cdr-backend`（草稿 PR #43，`68717d0`，尚未合并）。文中路径和函数名都在上述两处核对过；PR 3 才有的文件标「PR 3 新增」，本方案才有的标「本方案新增」。

**开工时机：阶段 6 PR 3 合并之后才开始**，分两个 PR：PR A「数据与契约」、PR B「后台费率页」，见 [PR 拆分与顺序](#8-pr-拆分与顺序)。

## 1. 背景与目标

### 1.1 现状

费率表一行一个前缀，三列 `prefix,country,rate`，其中 `country` 既当国家名又当备注。种子里 `44,英国` 和 `447,英国手机` 就是这样区分的。

| 位置                                                                       | 现状                                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/rating/src/rates.ts`                                             | `RateEntry { prefix, country, perMinute }`                                                                                                       |
| `packages/rating/src/csv.ts`                                               | `parseRateCsv` / `formatRateCsv`，`HEADER_ALIASES = ['prefix,country,rate', '前缀,国家,费率']`；表头可有可无，靠「第一个非空行第一格含字母」判断 |
| `packages/db/migrations/0000_init.sql`、`packages/db/src/schema.ts`        | `rate_entries(prefix, country, rate)`，`country text NOT NULL CHECK (btrim(country) <> '')`                                                      |
| `apps/worker/src/ingest.ts:176`                                            | 计费时把 `entry.country` 快照进 `cdrs.country`                                                                                                   |
| 话单列表、国家筛选、CDR CSV 导出（阶段 6）、月账单「按国家汇总」（阶段 7） | 全部读 `cdrs.country`。CSV 里这一列叫「国家/备注」                                                                                               |
| 后台租户详情「费率」标签（阶段 5，已完成）                                 | `apps/web/src/pages/admin/tenant-tabs/rates-tab.tsx` 表头 `前缀 / 国家/备注 / 费率（元/分钟）`，搜索框「搜索前缀或国家」                         |
| 客户门户                                                                   | 不显示费率表（[pages.md](pages.md) 第 113 行）。费率只在后台出现，但「国家/备注」会经话单显示给客户                                              |

### 1.2 目标

新费率表五列：

| 列                 | 含义                                                        | 例子           |
| ------------------ | ----------------------------------------------------------- | -------------- |
| ISO                | 国家代码，两位字母（ISO 3166 alpha-2 的写法），存大写，可空 | `GB`           |
| Country            | 国家名，必填                                                | `英国`         |
| Destination Prefix | 号码前缀，一行一个，规则同现在                              | `447`          |
| Description        | 说明，可空。同一个国家可以有多行，说明和费率各不相同        | `手机`、`固定` |
| Rate               | 每分钟费率，规则同现在                                      | `0.0450`       |

存储仍是一个前缀一行，最长前缀匹配、`matched_prefix`、授权性能和版本比较的原理都不变。变化只在于：国家名和说明从一个字段拆成独立字段，话单也分开保存，这样「按国家」的统计不会被「英国固定 / 英国手机」拆成两行。

## 2. 已决定

用户于 2026-10-19 确认的 8 项（D1 至 D8），加上本方案自定的取值（S 开头，汇总在 [3.2](#32-本方案自定待用户确认的取值)）；其中 S10、S11、S12 已由用户于 2026-10-19 确认，其余仍待用户确认。已决定不表示已实现。

| #   | 决定                                                                                                                                                                                            | 来源                 | 落在哪里                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| D1  | 仍然一行一个前缀，不做多前缀单元格，不做分组。存储一个前缀一行；最长前缀匹配、`matched_prefix`、授权性能、版本差异的原理不变                                                                    | 用户 2026-10-19 确认 | [4](#4-数据模型与迁移)；PR A                                                                                |
| D2  | 导出表头 `ISO,Country,Destination Prefix,Description,Rate`。导入大小写不敏感，另接受 `Destination Prefixes` 和中文表头 `ISO,国家,号码前缀,说明,费率`。Country 必填；ISO 和 Description 可空     | 用户 2026-10-19 确认 | [5](#5-csv-格式规范)；`packages/rating/src/csv.ts`；PR A                                                    |
| D3  | ISO 有值时必须是两位字母（ISO 3166 alpha-2 写法，如 GB、US），可空（卫星、国际网络，或 `1` 这类共用前缀）。存大写                                                                               | 用户 2026-10-19 确认 | [5.3](#53-逐列规则)；csv.ts、`adminRateEntrySchema`、迁移检查约束；PR A                                     |
| D4  | 旧三列 CSV（`prefix,country,rate` / `前缀,国家,费率`）不再接受，导入失败。给出专门的错误提示而不是泛泛的「表头无法识别」                                                                        | 用户 2026-10-19 确认 | [5.4](#54-错误信息)；PR A                                                                                   |
| D5  | 话单分开保存 ISO、国家、说明（`cdrs` 新增列）。国家筛选选项和阶段 7「按国家汇总」只按国家分组（英国固定和英国手机合计为一个英国）。这修改了阶段 6 决定 7（原为「国家/备注」）                   | 用户 2026-10-19 确认 | [4.3](#43-cdrs)、[7.2](#72-需要更新的-phase-6-designmd-行)；PR A                                            |
| D6  | 门户和后台话单列表的国家列显示合并的「英国 · 手机」，说明为空只显示「英国」。话单 CSV 导出把单列「国家/备注」换成三列 `ISO`、`国家`、`说明`。说明会显示给客户，管理员不得在其中填内部供应商备注 | 用户 2026-10-19 确认 | [6.7](#67-packagesshared)、[6.9](#69-appsapi-pr-3-新增)；PR A（契约与导出）、PR 5（页面）、PR B（提示文案） |
| D7  | 不回填。迁移只加列，旧费率条目的 ISO 和说明为空，旧话单保持原来的国家文本。种子按新格式重写（保持前缀和费率不变，阶段 1 至 5 的验收数字不变），测试服重新播种                                   | 用户 2026-10-19 确认 | [4.4](#44-旧数据不回填)、[4.5](#45-种子映射)；PR A                                                          |
| D8  | 阶段 6 PR 3 合并后才开始，分 PR A（数据与契约）和 PR B（后台费率页）两个 PR                                                                                                                     | 用户 2026-10-19 确认 | [8](#8-pr-拆分与顺序)                                                                                       |

## 3. 需要用户知晓的推论

### 3.1 由已决定直接推出的后果

1. **表头变成必填。** 现在解析器看第一个非空行第一格有没有字母来判断表头。新格式第一列是 ISO，数据行 `GB,英国,447,手机,0.0450` 同样以字母开头，这个办法分不出来。所以第一个非空行必须匹配某个接受的表头，否则整个文件失败。没有表头的 CSV 以前能导入，现在不行。
2. **表头出错时只报表头这一条错误，不再逐行报。** 旧格式文件的每一行都会因列数不对而失败，几千行错误对操作员没有帮助。表头错误在该物理行返回后停止。
3. **旧版本的导出文件也不能再导入。** 管理员手里存的旧 `prefix,country,rate` 导出文件、旧模板、线下维护的表都要改成五列。错误提示会说清楚怎么改（见 [5.4](#54-错误信息)）。
4. **ISO 只检查格式，不对照官方代码表。** `ZZ`、`XX` 这类不存在的代码会被接受。要对照代码表另行决定，见[不在本次范围](#11-不在本次范围)。
5. **国家名写法一致变得重要。** 国家筛选和阶段 7 汇总都按国家文本精确分组。「英国」和「英国 」（尾空格，会被去掉）是同一个，但「英国」和「大不列颠」就是两个国家。以前 `44` 写「英国」、`447` 写「英国手机」是两个选项，现在要写成同一个国家名。
6. **老话单和新话单的国家选项会并存一段时间。** 因为不回填，筛选下拉在同时包含新旧话单的日期范围里会出现「英国」和「英国手机」两项，旧话单的国家文本保持原样。阶段 7 对旧月份的「按国家汇总」也是旧分法（英国和英国手机分行），新月份是新分法。
7. **说明对客户可见。** 它会出现在门户话单的国家列和 CSV 导出里。后台编辑框和导入对话框要有提示，见 [6.12](#612-appsweb-pr-b)。供应商名称、成本、内部备注不得写在这里。
8. **共用前缀的 ISO 为空。** 例如 `1` = 美国/加拿大，国家名写「美国/加拿大」，ISO 留空。这是用户允许的，但按 ISO 统计时这些行不会归入任何国家。
9. **后台费率表的列顺序变了。** ISO 在最前，号码前缀在第三列，而列表仍按前缀排序，所以同一国家的多行不一定相邻（`1`、`1876`、`44`、`447` 的顺序）。本方案不改排序，见 S17。

### 3.2 本方案自定、待用户确认的取值

下表是用户没有逐项决定的取值，本方案先按下表实现，理由写在右栏。标「已确认」的由用户于 2026-10-19 确认，其余仍待用户审阅。

| #   | 取值                                                                                                                                                                     | 理由                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| S1  | 领域层和接口里 `iso`、`description` 是必填字符串，空值用 `''`；`rate_entries` 列是 `NOT NULL DEFAULT ''`。`cdrs` 列可空，空值用 `NULL`，Worker 写入时把 `''` 转成 `NULL` | 费率条目没有「未知」状态；话单有（旧话单、未接通），`NULL` 能区分「没数据」。展示时两者一样处理                   |
| S2  | Description 和 Country 一样最长 200 字、不能含换行                                                                                                                       | 现有代码里 Country 的上限是 200（`adminRateEntrySchema`、`apps/web/src/lib/rates.ts`、话单 `country` 过滤），沿用 |
| S3  | 国家和说明的 CSV 单元格不做公式中和：`formatRateCsv` 继续只用 `quoteCsvCell`，保持 LF 换行、无 BOM                                                                       | 导出文件要能原样再导入，加单引号会静默改掉国家名。话单 CSV 已经过 `csvCell` 中和，客户拿到的文件是安全的          |
| S4  | 下载的 CSV 模板用中文表头加两行示例：`ISO,国家,号码前缀,说明,费率` / `GB,英国,44,,0.0200` / `GB,英国,447,手机,0.0450`，仍带 BOM 和 CRLF                                  | 现有模板就是中文表头；两行示例演示「一个国家多行」                                                                |
| S5  | `rate_entries.iso` 加检查约束；`cdrs.iso` 加检查约束（`NOT VALID` 后 `VALIDATE`）；说明不加数据库约束                                                                    | 与 Country 现状对齐（长度只在应用层限制）                                                                         |
| S6  | 话单 CSV 三列的位置在原「国家/备注」处依次放 `ISO`、`国家`、`说明`；未接通行 `ISO` 和 `说明` 为空，`国家` 写 `未接通`                                                    | 保持阶段 6 决定 34「未接通行与页面一致」                                                                          |
| S7  | 话单列表（电脑和手机）的国家列表头由「国家/备注」改为「国家」                                                                                                            | 「备注」的含义已并入合并显示                                                                                      |
| S8  | 后台搜索匹配前缀、ISO、国家、说明四项，大小写不敏感，子串匹配                                                                                                            | 在现有的前缀、国家搜索上扩到 ISO 和说明                                                                           |
| S9  | 旧预览（迁移前保存在 `admin_rate_previews` 里、不含 `iso`/`description`）按失效处理，管理员重新预览；操作日志里旧的 `rate_schedule_cancel` 条目仍要能读，缺失字段补 `''` | 预览有效期只有 60 分钟；审计记录是永久的                                                                          |
| S10 | PR A 里带上后台 Web 的最小适配（不改版面），e2e 的 CSV 文本和接口夹具也在 PR A 转成新格式。真正的版面改动在 PR B                                                         | 已确认。`pnpm check` 含全仓类型检查，CI 每个 PR 都跑 e2e；契约一变，Web 不改就过不了，见 [8](#8-pr-拆分与顺序)    |
| S11 | 种子的 `44` 说明留空（调用显示为「英国」），`447` 说明写「手机」                                                                                                         | 已确认。用户选择 `44` 不写说明，它的话单显示「英国」。`447` 的「手机」仍演示同一国家多行、说明与费率各不相同      |
| S12 | 测试服重新播种：重建数据库，迁移，播种，再重做认证种子和队列迁移，见 [9.5](#95-测试服上线)                                                                               | 已确认。测试服没有需要保留的非种子数据；种子是幂等的，不会覆盖已有数据，所以必须重建                              |
| S13 | `parseRateCsv` 新增可选的逐行校验回调，取代数据库层现有的「逐行重新解析」                                                                                                | 表头必填后，单独解析一行会失败，原做法不再可行，见 [6.1](#61-packagesrating)                                      |
| S14 | 后台手机端每行显示「前缀、`国家 · 说明`、费率」，不单独显示 ISO                                                                                                          | 手机宽度放不下五列                                                                                                |
| S15 | 排定版本对当前表的行内提示：只有国家、ISO、说明变化而费率不变时，写「MM-DD 起更新名称」，而不是重复现在的费率                                                            | 现有提示只会写新费率，标签变化时会误导                                                                            |
| S16 | 单条编辑可改 ISO、国家、说明、费率，前缀只读                                                                                                                             | 前缀是行的键                                                                                                      |
| S17 | 列表和导出仍按前缀升序                                                                                                                                                   | 不改查询，避免动 `readVersion` 的顺序                                                                             |

## 4. 数据模型与迁移

### 4.1 迁移 SQL

文件：`packages/db/migrations/0016_rate_list_iso_description.sql`（本方案新增）。编号取开工时 `origin/main` 的下一个；编写时最新是 `0015_rls_initplan.sql`，PR 3 分支没有新迁移。迁移器按 `--> statement-breakpoint` 分句，整个文件在一个事务里执行；前例是 `0003_billing_number.sql`（`SET LOCAL lock_timeout`、可空列、`NOT VALID` 加 `VALIDATE`）。

```sql
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 费率条目：常量默认值，PostgreSQL 11 起只改目录，不重写表，也不触发 rate_entries_guard（它拦截 UPDATE，ADD COLUMN 不是 UPDATE）。
ALTER TABLE rate_entries
  ADD COLUMN iso text NOT NULL DEFAULT '',
  ADD COLUMN description text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE rate_entries ADD CONSTRAINT rate_entries_iso_check
  CHECK (iso = '' OR iso ~ '^[A-Z]{2}$');
--> statement-breakpoint
-- 话单：可空、无默认值的列，只改目录。cdrs 是按月分区的父表，ADD COLUMN 递归到每个分区；之后新建的分区自动带上这两列。
ALTER TABLE cdrs ADD COLUMN iso text, ADD COLUMN description text;
--> statement-breakpoint
ALTER TABLE cdrs ADD CONSTRAINT cdrs_iso_check
  CHECK (iso IS NULL OR iso ~ '^[A-Z]{2}$') NOT VALID;
--> statement-breakpoint
ALTER TABLE cdrs VALIDATE CONSTRAINT cdrs_iso_check;
```

`packages/db/migrations/meta/_journal.json` 追加 `{"idx": 16, "version": "7", "when": 1793232000000, "tag": "0016_rate_list_iso_description", "breakpoints": true}`（`when` 是上一条 `1793145600000` 加一天）。

已在 PostgreSQL 17.9（与仓库 compose 相同）的临时库上用简化表验证：按月分区的 `cdrs` 加两个可空无默认值的列后，父表和分区的 `relfilenode` 不变（没有重写）；`CHECK ... NOT VALID` 加在分区父表上会同时落到分区，`VALIDATE` 后父表和分区都是已验证；对已有数据的普通表加 `NOT NULL DEFAULT ''` 没有重写，旧行读出为空串。没有对完整迁移链运行，实现者要在 `pnpm test:db` 和 `pnpm db:migrate && pnpm db:seed && pnpm db:migrate` 里再确认。

注意：

- 授权已是表级的 `GRANT SELECT, INSERT, DELETE ON rate_versions, rate_entries, cdrs TO fs_billing_app`（`0000_init.sql:695`），新列自动包含，不需要新授权。
- `rate_entries` 的触发器拒绝所有 `UPDATE`，所以回填在数据库层面也做不到，和 D7 一致。
- 先迁移、后部署代码是安全的：旧 Worker 和旧 API 在新结构上仍能运行（旧 INSERT 不带新列，得到 `''` / `NULL`）。
- `VALIDATE` 与 `ADD COLUMN` 在同一个事务，`ACCESS EXCLUSIVE` 锁会持有到扫描结束。上线前（`0010` 的注释同样假定「仅限未上线」）这没问题。上线后 `cdrs` 很大时，改成迁移里只写 `NOT VALID`，旧行全是 `NULL`，天然满足约束，可以不验证，或另行在维护窗口里 `VALIDATE`（`SHARE UPDATE EXCLUSIVE`，不阻塞写入）。

### 4.2 `schema.ts`

`packages/db/src/schema.ts`：

```ts
export const rateEntries = pgTable('rate_entries', {
  // ...原有列...
  prefix: text('prefix').notNull(),
  iso: text('iso').notNull().default(''), // 新增
  country: text('country').notNull(),
  description: text('description').notNull().default(''), // 新增
  rate: numeric('rate').notNull(),
});

export const cdrs = pgTable('cdrs', {
  // ...原有列...
  country: text('country'),
  iso: text('iso'), // 新增，可空
  description: text('description'), // 新增，可空
});
```

`packages/db/src/migrate.db.test.ts` 里已有的 `Drizzle 表描述与迁移后的列一一对应`（逐表比较列名）会在漏改时失败，不需要改它。另加一个专门的测试，见 [9.1](#91-单元与数据库测试)。

### 4.3 `cdrs`

- 两列都可空。约束 `cdrs_answered_shape`（已接通必须有 `matched_prefix`、`country`、`rate`）**不改**，ISO 和说明不是计费必需的字段，不进入该约束。
- `cdrs.iso` 只检查格式（`cdrs_iso_check`）；说明不加数据库约束（S5）。
- 写入规则（Worker 和种子共用）：`iso = entry.iso || null`，`description = entry.description || null`，未接通话单两者都是 `NULL`。
- `country` 的含义不变，仍是快照时的国家名；`unassigned_cdrs` 没有 `country` 列，不动。阶段 8 认领未归属话单并补扣费时，必须用同一个快照函数写 `iso`、`description`，本方案不提前实现，但在 [7.4](#74-阶段-7-与阶段-8) 记下。
- 分区、索引不变。`country = ?` 过滤和国家选项 `GROUP BY country` 的查询形状不变，不需要新索引（阶段 6 决定 20、22 仍然成立）。

### 4.4 旧数据不回填

- 已有 `rate_entries` 行：`iso = ''`、`description = ''`。管理后台里显示为空单元格；这些条目随下一次导入或编辑被新值取代（版本是整表快照）。
- 已有 `cdrs` 行：`iso`、`description` 为 `NULL`，`country` 保持原文（如「英国手机」）。
- 不写任何 `UPDATE`。

### 4.5 种子映射

`packages/db/src/seed.ts` 的 `RATES_CSV`（第 151 行）改成新格式。前缀和费率逐行不变，所以阶段 1 至 5 以及阶段 6 PR 1、2 的验收数字（费用、余额、447 在 10 月 1 日前后分别为 0.0450 和 0.0480）不变。国家名统一，`44` 和 `447` 都是「英国」，这样按国家汇总是一个英国；`44` 说明为空，其话单显示「英国」，`447` 的话单显示「英国 · 手机」。

| 前缀 | ISO | Country     | Description | Rate   | 与原种子的差别             |
| ---- | --- | ----------- | ----------- | ------ | -------------------------- |
| 86   | CN  | 中国        |             | 0.0500 | 加 ISO                     |
| 1    |     | 美国/加拿大 |             | 0.0100 | ISO 空（共用前缀）         |
| 1876 | JM  | 牙买加      |             | 0.2500 | 加 ISO                     |
| 44   | GB  | 英国        |             | 0.0200 | 加 ISO                     |
| 447  | GB  | 英国        | 手机        | 0.0450 | 国家由「英国手机」拆成两列 |
| 81   | JP  | 日本        |             | 0.0350 | 加 ISO                     |
| 65   | SG  | 新加坡      |             | 0.0280 | 加 ISO                     |
| 852  | HK  | 中国香港    |             | 0.0300 | 加 ISO                     |

```text
ISO,Country,Destination Prefix,Description,Rate
CN,中国,86,,0.0500
,美国/加拿大,1,,0.0100
JM,牙买加,1876,,0.2500
GB,英国,44,,0.0200
GB,英国,447,手机,0.0450
JP,日本,81,,0.0350
SG,新加坡,65,,0.0280
HK,中国香港,852,,0.0300
```

同一文件里还有三处要跟着改：

- 第 461 行 `RATES_CSV.replace('447,英国手机,0.0450', '447,英国手机,0.0480')` 是对 CSV 文本的字符串替换，改成 `'GB,英国,447,手机,0.0450'` → `'GB,英国,447,手机,0.0480'`。替换不到时 `replace` 不报错，ABC001 的十月版本就悄悄没有调价；替换后加断言（结果必须不同于原文），`packages/db/src/rates.db.test.ts` 的 `种子租户 ABC001：10 月 1 日前后 447 分别使用 0.0450 与 0.0480` 也会拦住。
- 第 667 行 `seedCdrs` 写话单时 `country: entry.country` 后面补 `iso`、`description`（空串转 `NULL`）。种子里 `447700900123` 这通电话因此成为「英国 · 手机」，可用于冒烟。
- 播种是幂等的：`seedDatabase` 对已有费率版本的租户直接跳过（第 450 行 `seeded.has`），话单按 `existing` 跳过。所以已有数据库不会因为改了种子而变化，测试服的做法见 [9.5](#95-测试服上线)。

## 5. CSV 格式规范

### 5.1 表头

导出（`formatRateCsv`）写：

```text
ISO,Country,Destination Prefix,Description,Rate
```

导入接受下列三种之一。比较前每格去掉首尾空白并转小写，所以 `iso,COUNTRY,destination prefix,Description,RATE` 同样可以；行尾多余的空列（`...,Rate,,`）与数据行一样被忽略。

| 表头                                                | 说明                     |
| --------------------------------------------------- | ------------------------ |
| `ISO,Country,Destination Prefix,Description,Rate`   | 导出格式                 |
| `ISO,Country,Destination Prefixes,Description,Rate` | 复数写法                 |
| `ISO,国家,号码前缀,说明,费率`                       | 中文表头，与下载模板一致 |

### 5.2 解析流程

在 `parseRateCsv` 里按物理行处理，沿用现有的 BOM、`\r?\n` 分行、空行忽略、`splitRow`（RFC 4180，引号内不能换行）和行号约定（含表头，从 1 开始）。

1. 取第一个非空行，用 `splitRow` 拆开，去掉行尾多余的空单元格，再与上表比较。
2. 不匹配就返回单个错误 `{ line: 表头所在物理行, reason }` 并**停止**，不检查任何数据行（见 [5.4](#54-错误信息) 选哪条信息）。
3. 匹配则逐行处理数据行，每行取第一个失败原因，规则见下节，全文件错误一并返回；有任何错误则整体失败，不导入任何一行。
4. 没有数据行时返回 `{ line: 1, reason: '文件没有费率行' }`（同现在，行号取 1）。

### 5.3 逐列规则

每行先去掉行尾多余的空单元格（单元格数超过 5 且最后一个为空时才去，与现在对三列的做法相同），然后必须正好 5 列。检查顺序如下，每行报第一个失败项。

| 顺序 | 列                 | 规则                                                                                     | 变化                                            |
| ---- | ------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1    | 列数               | 必须 5 列                                                                                | 原为 3 列                                       |
| 2    | Destination Prefix | 只含数字；不能以 `00` 开头；文件内不重复（重复报在后出现的那一行，并指出首次出现的行号） | 不变，三条原有信息原样保留                      |
| 3    | ISO                | 空，或两位字母（大小写均可，存大写）。只检查格式，不对照官方代码表                       | 新增                                            |
| 4    | Country            | 非空                                                                                     | 信息由「国家/备注不能为空」改为「国家不能为空」 |
| 5    | Description        | 任意文本，可空，首尾空白被去掉                                                           | 新增，不在解析器里检查长度                      |
| 6    | Rate               | 数字、非负、最多 4 位小数                                                                | 不变                                            |

长度限制（Country 和 Description 各 200 字、不含换行、费率文本 128 字符）不在解析器里检查，仍由接口契约 `adminRateEntrySchema` 把关，与现状一致（`packages/shared/src/api/admin/admin.test.ts` 的 `CSV countries obey the response limit when validating parsed entries` 记录了这个分工）。数据库层改用逐行校验回调接入，见 [6.1](#61-packagesrating) 和 [6.5](#65-packagesdb管理服务)。

重复前缀的登记发生在前缀自身合法之后、其余列校验之前，这一点与现状相同：后面某行即使因国家为空而失败，它的前缀也已登记，会让更后面的同前缀行报重复。

### 5.4 错误信息

沿用现有措辞风格（短句、冒号后跟原值）。

| 情形                                                                                                                   | 信息                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 第一个非空行是旧表头 `prefix,country,rate` 或 `前缀,国家,费率`；或者是没有表头的旧数据行（3 个单元格且第一格全是数字） | `不再支持三列格式（前缀、国家、费率）。请改用五列并保留表头：ISO,Country,Destination Prefix,Description,Rate；可在导入对话框下载 CSV 模板` |
| 第一个非空行是其他内容（含新格式的数据行）                                                                             | `表头无法识别，第一行必须是：ISO,Country,Destination Prefix,Description,Rate（也可用中文表头 ISO,国家,号码前缀,说明,费率）`                |
| 列数不对                                                                                                               | `应为 5 列，实际 N 列`                                                                                                                     |
| 前缀（三条不变）                                                                                                       | `前缀只能是数字：X` / `前缀不能以 00 开头（国际冠字应去掉）：X` / `前缀 X 与第 N 行重复`                                                   |
| ISO                                                                                                                    | `ISO 必须是两位字母，或留空：X`                                                                                                            |
| Country                                                                                                                | `国家不能为空`                                                                                                                             |
| 费率（三条不变）                                                                                                       | `费率不是数字：X` / `费率不能为负：X` / `费率最多 4 位小数：X`                                                                             |
| 引号相关（不变）                                                                                                       | `引号未闭合（引号内不能换行）` / `引号后只能是逗号` / `未加引号的字段中不能有引号`                                                         |
| 没有数据行                                                                                                             | `文件没有费率行`                                                                                                                           |
| 契约校验（国家或说明超过 200 字、费率文本超过 128 字符）                                                               | `adminRateEntrySchema` 的 Zod 信息，由数据库层的逐行回调返回第一条，与现状一致。换行不可能出现在 CSV 单元格里，所以这里不会出现换行信息    |

引号相关三条在表头行上也可能出现，此时按表头行报该信息并停止。

### 5.5 导出格式

`formatRateCsv(entries)`：

- 首行 `ISO,Country,Destination Prefix,Description,Rate`，行尾 `\n`，文件末尾也有 `\n`，无 BOM（同现状，`admin-rates.spec.ts` 断言首行相等，所以不能加 BOM）。
- 每行 `iso,country,prefix,description,rate`，费率固定 4 位小数，ISO 和说明为空时输出空单元格。
- 每个单元格只经 `quoteCsvCell`（含逗号、引号、换行或首尾空白时加引号）。S3：不做公式中和，保证导出再导入后国家名不变。话单 CSV 走 `csvRecord`，是中和过的。
- 导出再导入必须得到相同的条目（包含 ISO 为空、说明含逗号和引号的情形）。

### 5.6 示例

有效，一国多行，ISO 为空的共用前缀，ISO 小写（存为 `KR`），说明含逗号（单元格加引号）：

```text
ISO,Country,Destination Prefix,Description,Rate
GB,英国,44,,0.0200
GB,英国,447,手机,0.0450
,美国/加拿大,1,,0.0100
kr,韩国,82,"首尔, 手机",0.0500
```

有效，中文表头，BOM 与 CRLF，行尾多余逗号：

```text
ISO,国家,号码前缀,说明,费率,,
JP,日本,81,,0.0350,,
```

无效及信息：

| 内容                                                | 信息（行号为物理行）                                           |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `prefix,country,rate` 后接 `44,英国,0.0200`         | 第 1 行：不再支持三列格式……（只此一条）                        |
| `44,英国,0.0200`（旧格式、没有表头）                | 第 1 行：不再支持三列格式……                                    |
| `GB,英国,447,手机,0.0450`（新格式但没有表头）       | 第 1 行：表头无法识别，第一行必须是……                          |
| 表头后 `GBR,英国,44,,0.02`                          | 第 2 行：ISO 必须是两位字母，或留空：GBR                       |
| 表头后 `G1,英国,44,,0.02`                           | 第 2 行：ISO 必须是两位字母，或留空：G1                        |
| 表头后 `GB,,44,,0.02`                               | 第 2 行：国家不能为空                                          |
| 表头后 `GB,英国,447,手机`                           | 第 2 行：应为 5 列，实际 4 列                                  |
| 表头后 `GB,英国,44,,0.02` 与 `GB,英国,44,手机,0.05` | 第 3 行：前缀 44 与第 2 行重复（同一国家的多行必须是不同前缀） |
| 表头后 `GB,英国,0044,,0.02`                         | 第 2 行：前缀不能以 00 开头（国际冠字应去掉）：0044            |
| 只有表头                                            | 第 1 行：文件没有费率行                                        |

## 6. 各包改动清单

只列要改的文件和位置，行号是 `origin/main`（`331779b`）或 PR 3 分支的行号，合并后会有位移，以函数名为准。

### 6.1 `packages/rating`

| 文件                                         | 改动                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/rates.ts`                               | `RateEntry` 增加 `readonly iso: string`、`readonly description: string`，必填，`''` 表示没有。`longestPrefix`、`findRate` 不改，返回的条目自带这两个字段                                                                                                                                                                                           |
| `src/csv.ts`                                 | 按第 5 节重写：`HEADER_ALIASES` 换成三个新表头；去掉「第一格含字母」的启发式，表头必填；旧格式专门信息；5 列解析；`formatRateCsv` 写新表头与五列。`parseRateCsv(text, currency, options?)` 新增可选参数 `options.validateEntry?: (entry: RateEntry<C>) => string \| undefined`，在内置检查全部通过后对每个条目调用，返回字符串就作为该物理行的错误 |
| `src/csv.test.ts`                            | 重写，见 [9.1](#91-单元与数据库测试)。`csvCell` 等公式中和的测试原样保留                                                                                                                                                                                                                                                                           |
| `src/rates.test.ts`、`src/authorize.test.ts` | 夹具补 `iso`、`description`                                                                                                                                                                                                                                                                                                                        |

`validateEntry` 是为了替换数据库层现有的做法：`packages/db/src/admin/rates.ts` 第 379 至 399 行和 `packages/db/src/admin/csv.ts` 第 34 至 54 行，对文件的每一行单独再调一次 `parseRateCsv(line)`，再用 `adminRateEntrySchema.safeParse` 收集契约错误，这样解析错误和契约错误能一起报。表头必填后，单独解析一行会因为没有表头而全部失败，这个做法行不通，所以改成回调。

### 6.2 `packages/db/src/schema.ts`、迁移

见第 4 节。

### 6.3 `packages/db/src/rates.ts`

- `createRateVersion`（第 23 行起）：插入 `rateEntries` 时补 `iso: entry.iso`、`description: entry.description`。
- `loadRatingTenant`（第 56 行起）：查询列补 `iso: rateEntries.iso`、`description: rateEntries.description`，组装 `RateEntry` 时带上（`leftJoin` 下为 `null` 的行不入表的判断保持，`iso`、`description` 用 `?? ''`）。授权与入库都走这个函数，会多读两个文本列。授权性能见 [9.3](#93-性能)。

### 6.4 `packages/db/src/seed.ts`

见 [4.5](#45-种子映射)：`RATES_CSV`、第 461 行的替换、`seedCdrs`。

### 6.5 `packages/db`（管理服务）

| 文件                        | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/admin/rates.ts`        | `readVersion`（第 76 行起）查询列补 `iso`、`description`，仍按前缀排序。`differences`（第 121 行）：「修改」的判断改为 `iso`、`country`、`description` 任一不同或费率数值不同。`getRates` 的搜索（第 288 至 297 行）改成前缀、`iso`、`country`、`description` 四项，大小写不敏感。`writeVersion`、`importPreview`、`exportRates` 里构造 `RateEntry` 与导出条目的三处（第 224、386 至 410、593 行附近）补两个字段。`importPreview` 删掉逐行重新解析（第 379 至 399 行），改为 `parseRateCsv(text, currency, { validateEntry })`，回调里用 `adminRateEntrySchema.safeParse` 并返回第一条问题的信息。`rate_schedule_cancel` 的审计内容（第 631 行 `entries: version.entries`）自动带上新字段 |
| `src/admin/csv.ts`          | `parseInitialRateCsv` 同样删掉第 34 至 54 行的逐行重新解析，改为回调                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/admin/tenants.ts`      | 开户初始费率：`entries` 分支（第 218 行）、`copy` 分支（第 262 行）构造 `RateEntry` 时补 `iso`、`description`；`csv` 分支经 `parseInitialRateCsv`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/admin/rate-preview.ts` | `ratePreviewPayloadSchema.entries` 仍用 `adminRateEntrySchema`（必填新字段）。迁移前保存、不含新字段的预览在 `commit` 里 `safeParse` 失败，走现有的 `PREVIEW_STALE`（S9），不需要兼容代码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `scripts/portal-perf.ts`    | 阶段 6 的性能原型，导出段有自己的表头，**不改**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

操作日志：`packages/db/migrations/0014_audit_reader.sql` 的保存查询 `audit_operation_logs` 直接返回 `details jsonb`，不解析内容，**不改**；`audit.db.test.ts` 不受影响。可能读到旧审计内容的是 `packages/shared` 的 `auditContentSchema`，见 6.7。

### 6.6 `apps/worker`

| 文件                                                                          | 改动                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ingest.ts`                                                               | 第 176 行旁边补 `iso: entry && entry.iso !== '' ? entry.iso : null`、`description: entry && entry.description !== '' ? entry.description : null`                           |
| `src/app.ts`                                                                  | 授权接口调用 `loadRatingTenant`，不用 `country`，不改                                                                                                                      |
| `src/charge.ts`、`src/invalid-cdr.ts`、`src/reconcile.ts`                     | 没有 `country`，不改                                                                                                                                                       |
| `scripts/perf-authorize.ts`                                                   | 第 38 至 42 行造 500 条费率，补 `iso: ''`、`description: ''`（让它能编译）。可以改成每条带 `iso: 'ZZ'`、`description: '压测'`，让文本列的读取成本包含在 p95 里，建议这样做 |
| `src/app.db.test.ts`、`src/cdr-time.db.test.ts`、`src/reliability.db.test.ts` | 费率夹具补两个字段；新增快照测试，见 9.1                                                                                                                                   |
| 根目录 `tests/cdr-time.test.ts`                                               | 第 58、64 行的 `RateEntry` 夹具补两个字段                                                                                                                                  |

全仓搜索 `RateEntry` 夹具：`git grep -n "perMinute:" -- apps packages tests`（核对时 `origin/main` 有 15 个文件含 `perMinute:`，其中 `packages/rating/src/billing.ts`、`money.ts` 与费率条目无关）。

### 6.7 `packages/shared`

| 文件                                                                                   | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/admin/rates.ts`                                                               | `adminRateEntrySchema`（strict）增加 `iso`、`description`，必填。`iso: z.string().trim().toUpperCase().regex(/^(?:[A-Z]{2})?$/, 'ISO 必须是两位字母，或留空')`；`description` 与 `country` 同样先拒绝 `\r\n`（信息「说明不能包含换行」）再 `trim().max(200)`，允许空串；`country` 的换行信息改为「国家不能包含换行」。Zod 4 的 `toUpperCase()` 是按添加顺序执行的变换，实现者用测试确认「小写输入 → 大写输出，输出再解析不变」                                              |
| `src/api/admin/audit.ts`                                                               | `rate_schedule_cancel` 的 `entries` 现在用 `adminRateEntriesResponseSchema`（第 130 行）。旧审计行里的条目只有 `prefix`、`country`、`rate`，新 strict schema 会解析失败，而这个 schema 就是阶段 8 操作日志页读取历史内容用的 `auditContentSchema`。改为单独的宽松条目 schema：`adminRateEntrySchema.extend({ iso: <同上>.default(''), description: <同上>.default('') })`，输出总是五个字段。`auditChangeSchema.field` 的枚举**不改**：费率相关审计的 `changes` 始终是 `[]` |
| `src/api/cdr-fields.ts`                                                                | `cdrFields` 增加 `iso: z.string().regex(/^[A-Z]{2}$/).nullable()`、`description: z.string().nullable()`（门户、后台、首页最近话单共用这一个对象，三处自动生效）。`checkCdrShape` 不变。新增并导出共用格式化函数 `formatCountryLabel`，见下                                                                                                                                                                                                                                  |
| `src/api/portal/*.test.ts`、`src/api/admin/*.test.ts`、`src/api/query-reparse.test.ts` | 话单夹具补 `iso`、`description`（strict schema 会拒绝缺键的数据）                                                                                                                                                                                                                                                                                                                                                                                                           |

**共用格式化函数**（门户、后台、阶段 7 月账单明细展示必须一致）放在 `packages/shared/src/api/cdr-fields.ts`，经 `src/index.ts` 的 `export * from './api/index.js'` 已有的路径导出，名字 `formatCountryLabel`：

```ts
/** 「英国 · 手机」；说明为 null、空串或纯空白时只返回国家。分隔符是空格、中点 U+00B7、空格。 */
export function formatCountryLabel(
  country: string,
  description: string | null | undefined,
): string;
```

CSV 导出不用它（CSV 是三列）。国家筛选下拉、按国家汇总也不用它（只按国家）。测试放新文件 `packages/shared/src/api/cdr-fields.test.ts`（本方案新增）。

### 6.8 `apps/api`

接口层本身没有对 `country` 的处理。要做的是夹具和断言：`src/admin-rates.test.ts`、`src/admin-rates.db.test.ts`、`src/admin-tenants.db.test.ts`（含五列之前的 CSV 文本，PR 3 分支第 704 行）、`src/idor.db.test.ts`（插话单的 SQL 不带新列也能运行；建议给两个租户的话单写入不同的 `iso`/`description`，断言各自看到自己的值）。`apps/api/src/routes/register.ts` 第 111 行的 CSV 体积检查与列无关，不改。

OpenAPI 由 Zod 生成（`pnpm --filter @fs-billing/api openapi`），仓库里只有阶段 4 的历史证据 `docs/evidence/phase-4-api/openapi.json`，不更新。

### 6.9 `apps/api`（PR 3 新增）

下列文件由 PR 3 引入，PR A 在 PR 3 合并后修改：

| 文件                                                               | 改动                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/portal/cdrs.ts`                                   | `portalCdrProjection`（第 16 行）的 `jsonb_build_object` 增加 `'iso'`、`'description'`；`queryCdrs` 里 `filtered` 和 `page` 两个 CTE 的列表（第 50、77 行）增加 `c.iso, c.description`；`portalCdrExportCursorQuery`（第 182 行起）增加 `c.iso as "iso"`、`c.description as "description"`。`listCountries` 不改（仍 `GROUP BY country`） |
| `packages/db/src/admin/cdrs.ts`                                    | 与上同：`filtered`、`page` 两个 CTE（第 41、69 行），`adminCdrExportCursorQuery`（第 132 行起）。投影复用 `portalCdrProjection`，不用再加                                                                                                                                                                                                 |
| `packages/db/src/cdr-query.ts`                                     | 不改。`country = ?` 精确匹配现在天然是「该国家的所有说明」                                                                                                                                                                                                                                                                                |
| `apps/api/src/routes/exports.ts`                                   | `cdrHeaders` 把 `'国家/备注'` 换成 `'ISO'`、`'国家'`、`'说明'`（位置不变，在「被叫号码」之后）；`CdrExportRow` 增加 `iso: string \| null`、`description: string \| null`；门户与后台两处 `rowToCells`：`row.iso ?? ''`、`row.country ?? '未接通'`、`row.description ?? ''`。后台导出仍多一列「验证状态」                                  |
| 测试                                                               | `packages/db/src/portal/cdrs.db.test.ts`、`packages/db/src/admin/cdrs.db.test.ts`、`apps/api/src/portal-cdr-export.db.test.ts`、`apps/api/src/admin-cdr-export.db.test.ts`、`apps/api/src/idor.db.test.ts`：夹具与断言，新增测试见 9.1                                                                                                    |
| `apps/api/src/routes/cdrs.ts`、`apps/api/src/export/stream-csv.ts` | 不改（表头由调用方传入）                                                                                                                                                                                                                                                                                                                  |

阶段 6 设计文档提到的 `apps/api/scripts/portal-list-perf.ts` 在 PR 3 分支上没有（2026-10-19 核对）。如果合并时已有，PR A 后重跑一次并记录。

### 6.10 `packages/db` 其他

`src/cdrs.db.test.ts`、`src/usage.db.test.ts` 等插话单的 SQL 不带新列也能运行，不必改；新增测试放在 `src/rates.db.test.ts`、`src/migrate.db.test.ts`。

### 6.11 `apps/web`：PR A 的最小适配

只为让 `pnpm typecheck`、`pnpm test`、e2e 在契约变化后通过，**不改版面**：

| 文件                                                                                                         | 改动                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/rates.ts`                                                                                           | `validateRateEdit` 返回的条目补 `iso: current.iso`、`description: current.description`，「新费率与当前费率相同」的比较也带上两个字段；`diffRateTables` 的比较加 `iso`、`description`（与服务端同步）                                                                                                                       |
| `src/lib/rate-csv.ts`                                                                                        | `rateCsvTemplate.text` 换成 S4 的新模板                                                                                                                                                                                                                                                                                    |
| `src/components/admin/rate-import-dialog.tsx`（第 506 行）、`src/pages/admin/tenant-create.tsx`（第 158 行） | 格式提示文字由 `prefix,country,rate` 换成五列表头，其余不动                                                                                                                                                                                                                                                                |
| 单元测试夹具                                                                                                 | `src/lib/rates.test.ts`、`src/components/admin/rate-import-dialog.test.tsx`、`rate-copy-dialog.test.tsx`、`src/pages/admin/tenant-tabs/rates-tab.test.tsx`、`src/admin.test.tsx`、`src/refresh-errors.test.tsx`：条目补两个字段，CSV 文本换成五列                                                                          |
| e2e                                                                                                          | `e2e/admin.ts`（第 61 行 `createTenant` 的 `rates` 类型）、`e2e/admin-rates.spec.ts`（`rates` 夹具、CSV 文本、第 271、301 行对首行的断言）、`e2e/admin-onboarding.spec.ts`（第 4 至 8 行 CSV）、`e2e/admin-visual.spec.ts`（第 50 至 57、168、169、232 行）转成新格式。`e2e/db.ts` 直接插话单的 SQL 不带新列也能运行，不改 |

### 6.12 `apps/web`（PR B）

| 文件                                                       | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/admin/tenant-tabs/rates-tab.tsx`                | 电脑表头由 `前缀 / 国家/备注 / 费率（unit）`（第 378 至 384 行）改为 `ISO / 国家 / 号码前缀 / 说明 / 费率（unit）`，行内单元格同序；搜索框 `aria-label` 与 `placeholder` 由「搜索前缀或国家」改为「搜索前缀、ISO、国家或说明」，空结果提示（第 351 行）同步；手机每行 `前缀 + formatCountryLabel(country, description) + 费率`（S14）；`editNotice` 和编辑按钮 `aria-label` 里的 `${prefix} ${country}` 改为用 `formatCountryLabel`；行内提示按 S15 |
| `src/components/admin/rate-edit-dialog.tsx`                | 表单字段：前缀（只读）、ISO、国家（必填）、说明、费率。说明输入下的提示：`说明会显示在客户的话单里，请勿填写内部备注`。确认页 `RateComparison`（第 280 行起）在 ISO、国家、说明任一变化时分别显示 `旧 → 新`（现在只有国家一行）。草稿类型 `RateEditDraft` 增加 `iso`、`description`，`issueFields` 增加 `entry.iso`、`entry.description`                                                                                                            |
| `src/lib/rates.ts`                                         | `validateRateEdit`：ISO 去空白、转大写、空或两位字母（错误「ISO 必须是两位字母，或留空」）；国家必填（「请输入国家」）；说明最多 200 字、不含换行；「无变化」的判断包含全部字段。`scheduledRowHints` 按 S15                                                                                                                                                                                                                                         |
| `src/components/admin/rate-changes-table.tsx`              | 表头 `变动 / ISO / 号码前缀 / 国家 / 说明 / 当前费率 / 新费率 / 涨跌`；「修改」行里 ISO、国家、说明有变化的单元格显示 `旧 → 新`（旧值划线）；`key` 仍用 `${kind}-${prefix}`                                                                                                                                                                                                                                                                         |
| `src/components/admin/rate-preview.tsx`（第 157 行）       | 删除列表 `${prefix} ${country}` 改为用 `formatCountryLabel`                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/components/admin/rate-import-dialog.tsx`              | 格式提示（第 504 至 509 行）改为 `格式：ISO,Country,Destination Prefix,Description,Rate　每行一个前缀，覆盖整张费率表`，加一句「说明会显示给客户，请勿填写内部备注」；错误列表本身不变（原始内容列仍取物理行）。第 608 行的校验规则文字补「ISO 为两位字母或留空；国家必填」                                                                                                                                                                         |
| `src/lib/rate-csv.ts`、`src/pages/admin/tenant-create.tsx` | PR A 已改，PR B 只在需要时调整文案                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/components/admin/rate-copy-dialog.tsx`                | 没有 `country` 引用，复用 `RateChangesTable`，无需改                                                                                                                                                                                                                                                                                                                                                                                                |

话单页面（`components/cdr/*`、`pages/portal/cdrs.tsx`、`pages/admin/tenant-tabs/cdrs-tab.tsx`）属 PR 5，见第 7 节。

## 7. 与阶段 6、阶段 7 的衔接

### 7.1 PR 3、PR 4、PR 5、PR 6

- **PR 3**：见 6.9。本方案不要求 PR 3 现在改；PR 3 先按现状合并，PR A 紧随其后改。PR 3 里已有的测试（如 `packages/db/src/portal/cdrs.db.test.ts` 的 `offers the countries seen in the range`）语义不变。
- **PR 5（话单页）**：PR A 应在 PR 5 合并前落地，让 PR 5 直接在新字段上建界面：国家列用 `formatCountryLabel(cdr.country, cdr.description)`，表头「国家」（S7），国家下拉只列国家，详情对话框沿用合并显示（ISO 不单独显示，只出现在 CSV 里）。**若 PR 5 已在进行**，开发分支需要：并入 PR A 后更新组件夹具（`portalCdrSchema` 是 strict，缺 `iso`/`description` 键的夹具会解析失败）；把列显示换成 `formatCountryLabel`；e2e 的话单夹具（`apps/web/e2e/db.ts` 的直接 INSERT）给至少一行写 `iso`、`description`，验证「英国 · 手机」。**若 PR 5 已合并**，PR A 自己承担上述三项，并在 PR 描述里单列。
- **PR 4（首页）**：最近 10 通话单使用 `portalRecentCallSchema`（同样展开 `cdrFields`），夹具要补两个键，显示用 `formatCountryLabel`。
- **PR 6（流水页）**：不涉及。
- **PR 7（e2e 与视觉对照）**：必须在 PR B 合并之后。

### 7.2 需要更新的 `phase-6-design.md` 行

行号为 `origin/main` 的 `331779b`。PR A 随代码一起改文档。

| 行      | 现文                                         | 改为                                                                                                                                                     |
| ------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15      | `PortalCdr` 字段列表含 `country`             | 加 `iso`（大写两位字母或 null）、`description`（字符串或 null）；说明「未接通为 null」                                                                   |
| 17      | `country` 精确匹配                           | 补「`country` 是国家名，不含说明；选某国家会包含它的所有说明」                                                                                           |
| 19      | `CdrCountriesResponse`：出现过的国家/备注    | 出现过的国家（不含说明）                                                                                                                                 |
| 146     | 列表 SQL 的 select 列表                      | 加 `iso, description`                                                                                                                                    |
| 186–195 | 国家选项，195 行「国家/备注」                | 改为「国家」；查询不变                                                                                                                                   |
| 263     | CSV 表中 `国家/备注` 一行                    | 换成三行 `ISO`、`国家`、`说明`；未接通写法按 S6                                                                                                          |
| 409     | Web 复用表 `components/data-format.tsx` 一行 | 加一行：`formatCountryLabel` 在 `packages/shared`，话单列表、详情、首页最近话单共用                                                                      |
| 524     | 决定 3「话单 CSV 列等于表格列加详情字段」    | 加注「其中国家/备注由 ISO、国家、说明三列取代，见 [rate-list-design.md](rate-list-design.md)」                                                           |
| 528     | 决定 7「国家筛选选项为……国家/备注」          | 改为「……国家（不含说明）」，来源加「用户 2026-10-19 确认（费率表五列）」                                                                                 |
| 609     | PR 3 一行                                    | 文件边界末尾加「费率表五列改造的 PR A 随后修改本行列出的查询与导出列，见 rate-list-design.md」                                                           |
| 末尾    | 决定表                                       | 新增决定 39：话单分开保存 ISO、国家、说明；国家筛选与按国家汇总只按国家；列表合并显示「国家 · 说明」；用户 2026-10-19 确认；落实指向 rate-list-design.md |

阶段 6 其余决定（31 被叫号码、33–36 导出格式、38 挂断原因）不受影响。

### 7.3 其他需要更新的文档

在 PR A 里随代码更新（描述契约与数据）：

| 文件                                                        | 位置                                        | 改动                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plan.md`                                              | 第 88 行（阶段 1 的 CSV 解析与校验定义）    | 改为五列定义，加注「阶段 1 当时的三列格式已被 rate-list-design.md 取代」；第 240 行的 CSV 验收项补「中文表头 `ISO,国家,号码前缀,说明,费率`」 |
| `docs/design.md`                                            | 第 222、231、246 行                         | 费率条目字段；匹配例子 `447`（英国 · 手机）；CSV 导入表头                                                                                    |
| `docs/phase-1-rating.md`                                    | 第 65 行（CSV 规则的整段说明）              | 末尾加「自 2026-10-19 起改为五列，见 rate-list-design.md」，不重写历史                                                                       |
| `docs/phase-2-db.md`                                        | 第 39、43 行（`rate_entries`、`cdrs` 的列） | 补 `iso`、`description`                                                                                                                      |
| `apps/web/.agents/skills/verify/features/rate-csv.md`       | 全文                                        | 表头、「header 可选」改为必填、导出表头、五列规则；`Gotchas` 里的「重复前缀」「多行」仍有效                                                  |
| `apps/web/.agents/skills/verify/features/db-cdr-storage.md` | 第 31 行                                    | 补 `iso`/`description` 可空                                                                                                                  |
| `docs/freeswitch.md`                                        | 第 100 至 112 行 SQL                        | 查询仍有效（按国家名和前缀筛），不必改；若愿意可加 `OR e.iso = 'CN'`                                                                         |
| `docs/phase-5-design.md`                                    | 第 187、262、343 行                         | 是已完成阶段的历史决定，不重写；各加一句指向本文的「已被取代」注记                                                                           |

在 PR B 里更新（描述页面）：`docs/pages.md` 第 94 至 103 行示例数据表、第 143 与 149 行（话单列「国家/备注」改「国家」，合并显示）、第 167 行（按国家汇总：国家、通话数……）、第 255 至 256 行（费率表列与搜索范围）。`docs/pages.md` 在 `.prettierignore` 里，保持原格式。

### 7.4 阶段 7 与阶段 8

- **阶段 7 月账单「按国家汇总」**（[plan.md](plan.md) 第 281 行、[pages.md](pages.md) 第 167 行）：按 `cdrs.country` 分组，不看 ISO 和说明。账单明细 CSV（该月话单明细）使用与话单导出相同的三列。旧月份有「英国」「英国手机」分行的情况（3.1 第 6 点）要在阶段 7 设计里说明。客户门户第二批设计稿的账单页有「英国手机」一行，实现时按国家汇总显示「英国」，属已决定的差异，记入阶段 7 的视觉对照。
- **阶段 8 认领未归属话单并补扣费**：必须沿用 Worker 的快照规则写 `iso`、`description`（4.3）。建议把快照抽成一个函数，供 `apps/worker/src/ingest.ts` 与认领流程共用。

### 7.5 视觉对照怎么记

管理后台第二批设计稿的 §7、§8、§10（`rates-tab.tsx` 文件头注释所引的章节：费率列表、单条编辑、导入）和「管理后台 CSV 导入原型」按三列或带「国家/备注」画的，实现后列变成五列。阶段 6 PR 7 的对照证据里，这些页面的差异记为 (a)「已决定的改动」，来源写 `rate-list-design.md` 决定 D1、D2、D6，不算缺陷（分类沿用 [阶段 5 视觉对照差异清单](evidence/phase-5-web/visual-diff.md) 的 (a)(b)(c)(d)）。受影响的页面和变体：`tenant-rates` 的电脑与手机、`tenant-rates-scheduled`、导入对话框的各步骤、编辑对话框的两步。客户门户第一批的话单页「国家/备注」列同样记 (a)（S7、D6）。截图用的种子和 e2e 夹具已经是新格式。

## 8. PR 拆分与顺序

| PR  | 内容                                                                                                                                                                                                                                                                                       | 依赖                                       | 文件边界                                                                                                                                                                                                                          | 验收与证据                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | 数据与契约：`RateEntry`、CSV 解析与导出；迁移 0016；`schema.ts`；`packages/db` 的费率、管理服务、开户、种子；`packages/shared` 的费率与审计 schema、`cdrFields`、`formatCountryLabel`；Worker 快照；适配 PR 3 的话单后端与导出；Web 最小适配和 e2e 夹具转换；文档（7.2、7.3 的 PR A 部分） | PR 3 已合并                                | `packages/rating`、`packages/db`（含 `migrations/0016*`、`meta/_journal.json`）、`packages/shared`、`apps/worker`、`apps/api`（PR 3 的话单与导出文件、夹具）、`apps/web` 的 6.11 所列文件、`tests/cdr-time.test.ts`、相关 `docs/` | `pnpm check`、`pnpm test:db`、`pnpm test:idor`、CI 的 `prove:idor`、`pnpm perf:authorize` 重跑（p95 < 50 ms）、完整 `pnpm test:e2e`；迁移后 `pnpm db:migrate && pnpm db:seed && pnpm db:migrate` 幂等；证据放 `docs/evidence/rate-list-pr-a/README.md`（命令输出、旧行读出为空的查询、新话单快照的查询、perf 输出） |
| B   | 后台费率页：列、搜索、编辑对话框、导入与复制预览、变动表、提示文案；单元测试与 e2e 新增                                                                                                                                                                                                    | PR A 已合并。可与阶段 6 的 PR 4–6 并行开发 | `apps/web/src/pages/admin/tenant-tabs/rates-tab.tsx`、`src/components/admin/rate-*.tsx`、`src/lib/rates.ts`、对应单元测试、`e2e/admin-rates.spec.ts` 等 e2e 新增用例、`docs/pages.md`                                             | `pnpm check`、完整 `pnpm test:e2e`；浅色、深色、手机三种宽度各一张费率页与编辑、导入对话框截图，差异按 7.5 记录；证据放 `docs/evidence/rate-list-pr-b/README.md`；**必须先于阶段 6 PR 7 合并**                                                                                                                      |

顺序：PR 3 合并，然后 PR A，然后 PR B。PR A 在 PR 5 合并之前落地，PR B 在 PR 7 之前合并。

**与最初分工的差别（S10，用户 2026-10-19 已确认）：** 最初的分工是把 `lib/rate-csv.ts` 和 e2e 的 CSV 夹具放 PR B。但 PR A 一改契约，Web 的类型检查、模板下载（旧表头导入会失败）和 e2e（CI 的 `web-e2e` 每个 PR 都跑，`createTenant` 夹具缺新字段、CSV 导入用旧格式、首行断言旧表头）都会变红，所以这部分最小适配只能放在 PR A，PR B 做真正的界面和新增用例。如果希望 PR A 完全不碰 Web，唯一的办法是 PR A 与 PR B 合成一个 PR。

## 9. 验证方案

### 9.1 单元与数据库测试

「新增」表示本方案新增的测试名，「改」表示在原有测试上调整。

**`packages/rating/src/csv.test.ts`（重写）**

- `valid five-column file with header, BOM and CRLF`
- `accepts Destination Prefixes, any header case and the Chinese header`
- `trailing empty columns are tolerated on header and rows`
- `ISO is uppercased, may be empty, and rejects three letters, digits and non-ASCII`（`GBR`、`G1`、`英国`）
- `country is required and description may be empty`
- `one country can have several prefixes with different descriptions and rates`
- `header is mandatory: a data row first is reported as an unrecognized header`
- `old three-column header or headerless three-column rows get the dedicated message and only that error`
- `near-miss header %s reports its physical line`（保留原用例，加 `ISO,Country,Prefix,Description,Rate`、`ISO，Country，…`）
- `row errors keep their physical line numbers`（5 列版本的原表格用例）
- `duplicate prefix across descriptions is rejected`
- `validateEntry errors are merged with parser errors by physical line`
- `export writes the five-column header and parses back to the same entries`（含 ISO 为空、说明含逗号、引号）
- `export keeps LF, no BOM and four-decimal rates`
- 原有 `csvCell`、`csvRecord`、`neutralizeCsvFormula` 的用例不变

**`packages/rating`**：`rates.test.ts` 新增 `longest prefix returns the matched entry's own iso and description`（`447…` 得到 GB/手机，`44…` 得到 GB/空说明）。

**`packages/shared`**

- `src/api/admin/rates.test.ts`：`rate entry iso is trimmed, uppercased and re-parses to itself`、`rate entry rejects a three-letter iso and a description with a line break`、`description over 200 characters is rejected`
- `src/api/admin/admin.test.ts`：`rate_schedule_cancel audit parses entries written before iso and description existed`（旧三字段条目输出补 `''`）；改 `CSV countries obey the response limit when validating parsed entries` 的 CSV 文本
- `src/api/cdr-fields.test.ts`（新文件）：`formatCountryLabel joins country and description`、`formatCountryLabel drops an empty or blank description`
- 话单契约：`portal and admin CDRs require iso and description keys`、`CDR iso must be two uppercase letters or null`

**`packages/db`**

- `migrate.db.test.ts` 新增 `adds iso and description to rate_entries (not null, default empty) and to cdrs (nullable)`：查 `information_schema.columns`，在 `cdrs_2026_10` 之类的分区上也查；再断言 `rate_entries_iso_check` 与 `cdrs_iso_check` 存在且已验证
- `rates.db.test.ts` 新增：`createRateVersion stores iso and description and loadRatingTenant returns them`、`rows inserted without iso and description read back as empty strings`、`rate_entries_iso_check rejects lowercase and three-letter ISO`、`cdrs_iso_check rejects lowercase ISO and accepts NULL`；改 `entries()` 辅助函数（第 25 行）用五列；保留 `种子租户 ABC001：10 月 1 日前后 447 分别使用 0.0450 与 0.0480`；新增 `种子费率表带 ISO 与说明：44 为 GB 且说明为空，447 为 GB 手机，1 的 ISO 为空`
- `admin/rates.db.test.ts` 新增：`search matches prefix, iso, country and description case-insensitively`、`a description-only or iso-only change is a modified row in the preview`、`exports the five-column CSV and reimports it unchanged`、`old three-column CSV is rejected with the dedicated message and writes nothing`、`copy keeps iso and description`、`cancelling a future version audits entries with iso and description`；改 `invalid CSV reports all physical rows and writes no versions or audits`、`Chinese CSV preview binds actor purpose and path and commits all rows once`、`rejects multiline edits without writes and reimports exported quoted countries`、`exports four decimal CSV and a same transaction audit`；`maps incompatible persisted payloads to PREVIEW_STALE without consuming them or writing rates` 加一个迁移前预览（无新字段）的用例
- `admin/csv.test.ts`：`reports parser and contract errors together using physical row numbers` 改用回调实现并更新 CSV 文本
- `admin/tenants.db.test.ts`：`initial rates from entries, CSV and copy keep iso and description`；第 212、251 行的 CSV 文本换成五列
- PR 3 新增的 `portal/cdrs.db.test.ts`、`admin/cdrs.db.test.ts`：`returns iso, country and description separately`、`country filter matches every description of that country`、`country options list each country once whatever the description`、`unanswered calls have null iso and description`

**`apps/worker`**：`app.db.test.ts` 新增 `接通话单把费率条目的 ISO、国家和说明快照进话单`（447 号码得到 `GB`/`英国`/`手机`）、`条目没有 ISO 或说明时话单写入 NULL 而不是空串`、`未接通话单的 ISO 与说明为 NULL`；改第 120、636、643、838 行附近夹具。

**`apps/api`**：`admin-rates.test.ts`、`admin-rates.db.test.ts` 夹具；`idor.db.test.ts` 两租户各带不同 `iso`/`description`，断言互不可见；`portal-cdr-export.db.test.ts`、`admin-cdr-export.db.test.ts`：`export header has ISO, 国家 and 说明 in place of 国家/备注`、`unanswered row writes 未接通 only in the country column`、`a description starting with = is neutralized in the export`。

**`apps/web`（PR B）**

- `src/lib/rates.test.ts`：`validateRateEdit uppercases iso and requires country`、`validateRateEdit treats a description-only change as a change`、`diffRateTables marks iso and description changes as modified`、`scheduledRowHints says rename when only labels change`
- `src/pages/admin/tenant-tabs/rates-tab.test.tsx`：`shows ISO, 国家, 号码前缀, 说明 and 费率 columns`、`search finds a row by ISO or description`
- `src/components/admin/rate-import-dialog.test.tsx`：改第 178、194 行附近的错误列表用例；新增 `shows the dedicated message for an old three-column file`、`import hint names the five columns and warns that descriptions are visible to customers`
- `src/components/admin/rate-changes-table.test.tsx`（新文件）：`modified rows show old → new for iso, country and description`
- 编辑对话框（放在 `admin.test.tsx` 或新文件）：`edit dialog edits iso, country, description and rate and warns about customer visibility`
- e2e（`apps/web/e2e/admin-rates.spec.ts`）新增：`shows ISO, country, prefix, description and rate columns`、`edits ISO and description and audits the change`、`rejects an old three-column CSV with the format hint`；`admin-onboarding.spec.ts` 已有的 `creates a run-unique tenant, imports rates, credits 500 and opens portal account` 用新格式 CSV；`admin-visual.spec.ts` 的 `matches seeded admin pages in light dark and mobile` 照旧运行

### 9.2 命令

均来自根 `package.json` 和各包 `package.json`。

| 目的                                         | 命令                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 全部检查（lint、格式、类型、单测、Web 构建） | `pnpm check`                                                                                                                          |
| 起库、迁移、播种、再迁移                     | `pnpm db:up && pnpm db:migrate && pnpm db:seed && pnpm db:migrate`                                                                    |
| 数据库验收测试                               | `pnpm test:db`                                                                                                                        |
| IDOR                                         | `pnpm test:idor`；CI 同款 `pnpm --filter @fs-billing/api prove:idor <输出目录>`                                                       |
| 授权性能                                     | `pnpm perf:authorize`（即 `pnpm --filter @fs-billing/worker perf:authorize`）                                                         |
| Web e2e                                      | `pnpm test:e2e`（即 `pnpm --filter @fs-billing/web test:e2e`；需要库已迁移并播种）                                                    |
| 视觉对照                                     | `FSB_VISUAL=1 FSB_EVIDENCE_DIR=$PWD/docs/evidence/<目录> pnpm --filter @fs-billing/web exec playwright test e2e/admin-visual.spec.ts` |
| 单个测试文件                                 | `pnpm exec vitest run packages/rating/src/csv.test.ts`                                                                                |

### 9.3 性能

`loadRatingTenant` 每次授权和入库都读出租户的全部费率版本，现在每行多两个文本列。PR A 里重跑 `pnpm perf:authorize`（500 条费率、1000 次请求），要求输出 `passed: true`、p95 < 50 ms，输出贴进证据。阶段 3 收尾基线 p95 约 5.5 至 6.3 ms（[收尾性能证据](evidence/phase-3-closeout/perf-authorize.txt)），差异应在噪声范围内；`perf-authorize.ts` 的费率行建议带非空 `iso`、`description`，使这两列的读取成本计入。若 p95 明显变差，退路是授权路径只读 `prefix`、`rate`，把标签读取放在入库路径，这需要拆分 `loadRatingTenant`，到时另行评估，不预先做。

话单列表、汇总、国家选项的查询形状没有变化，不需要重测 300 万条的数据；PR 3 若带了 `portal-list-perf.ts`，PR A 后跑一次整请求耗时，确认每页仍小于 500 ms。

### 9.4 人工核对

1. 后台导入新模板，再导出，再导入，条目不变；导入旧三列文件，看到专门的提示，费率表不变。
2. 种子库里 ABC001 的话单：`447700900123` 一行在话单接口返回 `country: 英国`、`iso: GB`、`description: 手机`，门户和后台列表显示「英国 · 手机」，国家下拉只有「英国」一项（不含「英国手机」）。
3. 话单 CSV 导出：表头是 `ISO`、`国家`、`说明`，未接通行国家列写「未接通」。
4. 打开 Windows Excel 看一次带中文说明的 CSV 是否正常（BOM 在话单导出里已有，费率导出没有 BOM，是现状）。

### 9.5 测试服上线

测试服没有需要保留的非种子数据（S12，用户已确认），所以走重建。步骤保持通用，不含主机地址和密钥：

1. 先备份：代码目录整体复制一份，数据库 `pg_dump -Fc`。
2. 解包新代码，`pnpm install --frozen-lockfile`，构建 Web。
3. 重建数据库：删除并重新创建测试库，用**维护环境里的属主 `DATABASE_URL`** 运行迁移（`packages/db` 的 `src/bin/migrate.ts`，即 `pnpm db:migrate`），**不要用运行环境的连接串**，运行环境没有属主权限，迁移会失败。
4. 播种：`pnpm db:seed`，再重做认证种子和队列迁移（`pnpm --filter @fs-billing/api auth:seed`、`pnpm --filter @fs-billing/worker queue:migrate`）。种子是幂等的，不会覆盖已有数据，这是必须重建而不是原地播种的原因。
5. 重启 API 与 Worker。
6. 冒烟：在后台导入、导出一次费率；按 [worker-api.md](worker-api.md) 向 Worker 的话单接口推一条 447 开头的接通话单（或用真实测试通话），在门户话单看到「英国 · 手机」，在后台话单和 CSV 导出里看到 `GB`、`英国`、`手机`；再推一条 44 开头（非 447）的话单，显示「英国」。保留数据、只导入新版本的做法没有被选用。

## 10. 验收标准

PR A：

- [ ] `pnpm check` 通过；`pnpm test:db`、`pnpm test:idor` 通过；CI 的 `prove:idor` 通过
- [ ] `pnpm db:migrate && pnpm db:seed && pnpm db:migrate` 在空库上成功且第二次迁移无变化；迁移 0016 之后，旧行读出 `iso = ''`、`description = ''`（费率）和 `NULL`（话单）
- [ ] `parseRateCsv` 的表头必填；新旧表头、别名、中文表头、旧格式专门提示、逐列规则全部有测试；导出再导入逐字段一致
- [ ] 契约：`adminRateEntrySchema` 要求 `iso`、`description`；`rate_schedule_cancel` 旧审计内容仍能被 `auditContentSchema` 解析；迁移前的预览按失效处理
- [ ] 版本差异、搜索、复制、开户初始费率、导出都带 ISO 和说明；只改 ISO 或只改说明在预览里是「修改」
- [ ] Worker 把 ISO、国家、说明快照进话单，空值写 `NULL`；种子 447 话单为 英国 / 手机 / GB
- [ ] 话单列表、首页最近话单、后台话单的响应带 `iso`、`description`；原始 JSON 里门户仍没有 `unverified`；国家筛选和国家选项只按国家
- [ ] 话单 CSV 导出是 `ISO`、`国家`、`说明` 三列，没有「国家/备注」；说明里的 `=` 开头被中和
- [ ] `pnpm perf:authorize` 重跑 p95 < 50 ms，输出入证据
- [ ] 种子按 4.5 映射，阶段 1 至 5 的验收数字不变；`phase-6-design.md` 与 7.3 列出的文档已更新
- [ ] 完整 `pnpm test:e2e` 通过（夹具已转新格式）

PR B：

- [ ] 费率页表头为 `ISO / 国家 / 号码前缀 / 说明 / 费率（单位）`，行内顺序相同；手机显示前缀、`国家 · 说明`、费率
- [ ] 搜索框能按前缀、ISO、国家、说明找到行
- [ ] 编辑对话框可改 ISO、国家、说明、费率，前缀只读；校验与服务端一致；有「说明会显示在客户的话单里」提示
- [ ] 导入、复制的预览和排定版本的变动表显示 ISO、国家、说明的前后变化
- [ ] 导入对话框的格式提示和下载的模板是五列；导入旧三列文件显示专门提示
- [ ] `pnpm check`、完整 `pnpm test:e2e` 通过；浅色、深色、手机截图及差异记录（按 7.5）入证据
- [ ] 在阶段 6 PR 7 合并之前已合并

整体：

- [ ] 测试服按 9.5 完成迁移与重新播种，冒烟看到「英国 · 手机」

## 11. 不在本次范围

- 一个单元格多个前缀、前缀区间（D1）
- 回填历史话单的 ISO 和说明，把旧「英国手机」合并回「英国」（D7）
- 对照官方 ISO 3166 代码表校验 ISO（3.1 第 4 点）
- 客户门户展示费率表（[pages.md](pages.md) 第 113 行：门户不显示费率表）
- 按 ISO 统计或筛选（本方案只按国家文本）
- 费率表按国家或 ISO 排序、分组展示（S17）
- 费率导出加 BOM 或改换行（现状）
- 阶段 8 认领未归属话单的快照实现（只在 7.4 记下要求）
- 修改阶段 6 性能原型 `packages/db/scripts/portal-perf.ts` 里的导出列
