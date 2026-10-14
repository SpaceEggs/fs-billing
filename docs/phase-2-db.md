# 阶段 2 验收记录

分支：`phase-2-db`。

## 数据形状

先定表与不变量，再写代码。迁移是手写 SQL（`packages/db/migrations/`），由 `drizzle-orm` 的迁移器按 `meta/_journal.json` 顺序执行并记录在 `drizzle.__drizzle_migrations`；`packages/db/src/schema.ts` 是同一结构的 Drizzle 描述，供类型化查询使用，`migrate.db.test.ts` 核对两者列名一致。手写 SQL 的原因：分区表、触发器、基于会话变量的 RLS 策略、复合外键约束都无法由 `drizzle-kit generate` 生成。

### 角色与连接

| 角色             | 属性                                     | 用途                                                    |
| ---------------- | ---------------------------------------- | ------------------------------------------------------- |
| `fs_billing`     | 超级用户（compose 创建），所有表的 owner | `pnpm db:migrate`、`pnpm db:seed`                       |
| `fs_billing_app` | `LOGIN NOSUPERUSER NOBYPASSRLS`          | API / Worker 运行时连接（`APP_DATABASE_URL`），RLS 生效 |

应用连接后必须在事务内声明身份，否则任何业务表都读不到行（默认拒绝）：

| 身份           | 设置（事务级 `set_config(..., true)`）                | 可见范围         |
| -------------- | ----------------------------------------------------- | ---------------- |
| 租户           | `app.scope = 'tenant'`，`app.tenant_id = <租户 uuid>` | 该租户的行，只读 |
| 管理员         | `app.scope = 'admin'`                                 | 全部行，可写     |
| 系统（Worker） | `app.scope = 'system'`                                | 全部行，可写     |
| 未设置         | 不调用 `set_config`                                   | 0 行（策略为假） |

TS 入口：`withTenant(db, tenantId, fn)`、`withAdmin(db, fn)`、`withSystem(db, fn)`（`packages/db/src/client.ts`）。分区表的各分区也启用 RLS 且不授予应用角色任何权限，只能经父表访问。

**RLS 的信任边界。** 租户编号来自登录之后应用写入的 `app.tenant_id`，不来自 SQL 里客户端自己写的租户条件。`app.scope` 由 `withTenant`、`withAdmin`、`withSystem` 在同一事务里设置。`fs_billing_app` 是 `NOSUPERUSER NOBYPASSRLS`，不能绕过 RLS。拿到 `APP_DATABASE_URL` 并能执行任意 SQL 的主体可以自己 `set_config` 这两个变量。RLS 兜底的是应用漏写过滤，不隔离共享数据库凭据。租户锁的事务级标记 `app.tenant_locks` 也一样：它和 `app.scope` 一样是普通的会话变量，前提是后端代码可信，只经 `lock_tenants` 写它。能执行任意 SQL 的主体故意伪造这个标记，不在威胁模型内。“已持有”还要求 `pg_locks` 里有这把锁，而应用角色不能直接调用 advisory 锁函数（见“租户锁”），所以伪造标记只剩“同键锁由别处拿到”这一条路，范围比单靠标记时更窄。

### 表

所有业务表带 `tenant_id`（`tenants` 自身以 `id` 为租户编号）；例外是全局的 `admins`（仅 `app.scope = 'admin'` 可见）和尚未归属租户的 `unassigned_cdrs`（管理员与系统身份可见，归属后记 `assigned_tenant_id`）。金额 `NUMERIC`（不限精度，计费过程不舍入），费率 `NUMERIC` 加检查 `scale(rate) <= 4`（超过 4 位小数直接拒绝，`NUMERIC(10,4)` 会悄悄四舍五入），时间 `timestamptz`。测试断言库中没有 `real`/`double precision`/`money`/不带时区的 `timestamp` 列。

| 表                         | 主要列                                                                                                                                                                                                             | 约束与规则                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`                  | `id`、`code`、`name`、`currency`、`status`、`overdraft_limit`、联系人/电话/备注                                                                                                                                    | `code` 唯一且为字母数字；`currency ∈ {CNY, USD}`；`status ∈ {active, disabled}`；透支额度 ≥ 0；编码与币种创建后不可修改（触发器）                                                       |
| `admins`                   | `id`、`email`、`name`、`status`、`last_login_at`                                                                                                                                                                   | 全局表，不属于任何租户；仅管理员身份可见                                                                                                                                                |
| `portal_accounts`          | `tenant_id`、`email`、`status`、`last_login_at`                                                                                                                                                                    | `email` 唯一                                                                                                                                                                            |
| `rate_versions`            | `tenant_id`、`effective_from`（默认 `now()`）、`created_by`                                                                                                                                                        | 每个租户一张费率表（design §6.1），所以“费率表”即租户：`UNIQUE (tenant_id, effective_from)`；版本规则见下                                                                               |
| `rate_entries`             | `tenant_id`、`rate_version_id`、`prefix`、`country`、`rate`                                                                                                                                                        | `UNIQUE (rate_version_id, prefix)`；前缀为数字且不以 `00` 开头；费率 ≥ 0、4 位小数；不可修改                                                                                            |
| `ledger_entries`           | `tenant_id`、`kind`、`amount`、`note`、`created_by`、`idempotency_key`、`occurred_at`、`created_at`                                                                                                                | 只增：`UPDATE`/`DELETE`/`TRUNCATE` 由触发器拒绝，且应用角色无这些权限；`UNIQUE (tenant_id, idempotency_key)`；按类型的符号、必填与发生时间检查（见下）；索引 `(tenant_id, occurred_at)` |
| `receivable_settlements`   | `tenant_id`、`ledger_entry_id`、`entry_kind`（恒为 `credit_recharge`）、`received_on`、`note`、`confirmed_by`                                                                                                      | 待收款 → 已收款的状态事件；`(ledger_entry_id, tenant_id, entry_kind)` 外键指向 `ledger_entries (id, tenant_id, kind)`，只能结算赊账充值；`UNIQUE (ledger_entry_id)` 只能结算一次；只增  |
| `tenant_balances`          | `tenant_id`、`balance`、`updated_at`                                                                                                                                                                               | 缓存余额，仅由流水插入触发器维护；应用角色只读；`balance_discrepancies` 视图列出与流水合计不一致的租户                                                                                  |
| `cdrs`                     | `tenant_id`、`call_uuid`、`started_at`（分区键）、`answered_at`、`ended_at`、`caller`、`callee`、`duration_seconds`、`billed_minutes`、`matched_prefix`、`country`、`rate`、`charge`、`hangup_cause`、`unverified` | `PARTITION BY RANGE (started_at)`，按北京时间自然月分区（`cdrs_2026_10` 覆盖 `2026-10-01 00:00+08` 至 `2026-11-01 00:00+08`）；UUID 全局唯一（见下）                                    |
| `call_uuids`               | `call_uuid`、`tenant_id`（可空 = 未归属）、`started_at`                                                                                                                                                            | 非分区登记表，`call_uuid` 主键；`cdrs` 与 `unassigned_cdrs` 共用，由两者的插入触发器写入（见下）；管理员或系统身份可见                                                                  |
| `raw_cdrs`                 | `id`、`tenant_id`（可空）、`call_uuid`（可空）、`body text`、`payload jsonb`（由 `body` 生成）、`received_at`（分区键）                                                                                            | `PARTITION BY RANGE (received_at)`，按北京时间自然月分区，主键 `(id, received_at)`；不按 UUID 去重；管理员或系统身份可见                                                                |
| `unassigned_cdrs`          | `tenant_tag`、`call_uuid`、通话字段、`status`、`ignore_reason`、`assigned_tenant_id`                                                                                                                               | 状态 `pending`/`ignored`/`assigned`，检查约束保证忽略必有原因、归属必有租户；插入时在 `call_uuids` 登记 `tenant_id = NULL`；管理员或系统身份可见                                        |
| `monthly_statements`       | `tenant_id`、`month`、期初、充值、赠送、调账、通话扣费、期末、通话分钟、`details_deleted`、`generated_at`                                                                                                          | `UNIQUE (tenant_id, month)`；检查 期末 = 期初 + 充值 + 赠送 + 调账 − 通话扣费                                                                                                           |
| `operation_logs`           | `admin_id`、`tenant_id`（可空）、`action`、`target`、`details jsonb`、`created_at`                                                                                                                                 | 只增；仅管理员可见                                                                                                                                                                      |
| `system_alerts`            | `tenant_id`（可空）、`kind`、`description`、`started_at`、`recovered_at`、`affected_calls`                                                                                                                         | `kind ∈ {auth_timeout, cdr_failed, email_failed, partition_failed}`；管理员或系统身份可见                                                                                               |
| `balance_alert_settings`   | `tenant_id`（主键）、`threshold`、`emails text[]`                                                                                                                                                                  |                                                                                                                                                                                         |
| `balance_alert_deliveries` | `tenant_id`、`kind`、`balance`、`recipients`、`sent_at`                                                                                                                                                            | `kind ∈ {low_balance, suspended}`；只增                                                                                                                                                 |

### 账本不变量

1. **余额 = 流水合计。** `balance(t) = SUM(ledger_entries.amount WHERE tenant_id = t)`，没有任何流水时为 0。
2. **流水只增。** 任何角色（包括 owner）对 `ledger_entries` 的 `UPDATE`、`DELETE`、`TRUNCATE` 都被触发器拒绝；应用角色另外没有这三项权限。改错用一笔反向“调账”冲正。
3. **状态变化另记。** 赊账充值的收款状态 = 是否存在对应的 `receivable_settlements` 行；`receivables` 视图（`security_invoker`，受 RLS 约束）给出 `pending` / `received`。
4. **缓存余额可重算核对。** `tenant_balances.balance` 由流水插入触发器在同一事务内累加（`balance = balance + amount`，行锁持有到提交）。`balance_discrepancies` 列出缓存与流水合计不同的租户，正常情况下为空。重算是过程 `rebuild_tenant_balances(OUT fixed integer)`。在自动提交的连接上调用 `CALL rebuild_tenant_balances(NULL)`，`fixed` 是这次余额有变化的租户数。不要把这次 `CALL` 放进已经 `BEGIN` 的事务。显式事务里调用时，处理第一个租户的 `COMMIT` 报 SQLSTATE 2D000（invalid transaction termination），外层事务不会被提交。一个租户都没有时过程不执行 `COMMIT`，返回 `fixed = 0`。每一轮只锁一个还没处理过的 `tenant_balances` 行（`FOR UPDATE`），把该租户的流水求和后写回缓存，然后 `COMMIT`。任何时刻只拿着一个租户的锁，所以重算不会和扣费事务死锁。未提交的扣费占着该租户的余额行锁，这一轮 `FOR UPDATE` 会等到它提交，下一句求和已经能看见这笔流水。重算提交之后才插入的流水会等这把锁，再按 `balance = balance + amount` 累加。每轮提交后重新查找还没处理的余额行，调用期间新开的户会在后面的轮次被算进去。最后一次查找之后才提交的开户不在这次调用里，开户触发器写下的余额仍等于当时的流水合计。写流水的事务先调用 `lock_tenants(uuid[])`，见下文“租户锁”。重算不拿租户锁，每次只锁一个租户的余额行，不参与写流水之间的等待。
5. **按类型的符号。** `recharge`、`credit_recharge`、`gift`：金额 > 0，必须有操作管理员；`adjustment`：金额 ≠ 0，必须有操作管理员和非空原因；`call_charge`：金额 < 0，无操作管理员。由检查约束保证。
6. **重试收敛。** 每笔流水带幂等键（通话扣费为 `call:<通话 UUID>`）；`appendLedgerEntry` 以 `ON CONFLICT DO NOTHING` 写入，重试返回原记录，键相同但内容不同则报错。
7. **发生时间决定归属。** `occurred_at` 是流水在账务上发生的时刻，门户按天合并、月账单和核对任务一律按它的北京日期/月份统计，`created_at` 只是写入时间。通话扣费的 `occurred_at` 是接通时间（`LedgerEntryInput` 的 `call_charge` 分支必须给 `occurredAt`）。人工操作不写这两列，都取这次 `INSERT` 的 `now()`，检查约束 `ledger_entries_kind_shape` 要求它们相等。`fs_billing_app` 插入时若 `created_at` 不是 `now()`，触发器 `ledger_entries_stamp_created_at` 拒绝。该表没有 `UPDATE`。历史种子由 owner 连接写入 `created_at`。9-30 23:59 接通、10-01 00:00:30 才写入的扣费归属 9 月。

### 费率版本规则

费率版本是整表快照（阶段 1 的 `RateVersion`），某时刻生效的是 `effective_from ≤ 时刻` 中最晚的版本。

1. `(tenant_id, effective_from)` 唯一。
2. **新版本的生效时间必须晚于该租户所有已有版本。** 已排定未来版本时，“修改当前版本”（插入一个立即生效的新版本）会被拒绝，错误提示“已排定 … 生效的新版本，请先修改该未来版本”。理由：未来版本是排定时的整表快照，不包含之后对当前版本的修改；若允许插入，修改会在未来版本生效时静默丢失。选择“禁止并提示”而非“同步到未来版本”，因为未来版本可能本来就要改同一前缀，自动同步会覆盖管理员的排定意图。
3. 已生效的版本及其条目不可修改、不可删除。触发器在租户锁已持有时用 `clock_timestamp()` 判断是否已生效。`now()` 停在事务开始，不能用来做这个判断。未来版本可以整体删除（取消排定）后重新排定。
4. “立即生效”的版本不传 `effective_from`，由数据库默认值 `now()`（事务开始时刻）填写，因此提交后立刻满足 `effective_from ≤ now()`。

### 租户锁

改费率和写流水的事务，在任何写入之前调用 `lock_tenants(uuid[])`。函数对传入的租户去重、按 `uuid` 升序，逐个拿事务级 advisory 锁 `pg_advisory_xact_lock(tenant_lock_key(id))`。费率和流水共用每个租户的这一把锁。同一租户的这些事务因此串行执行。外键检查、唯一索引等待、执行器为 `BEFORE DELETE` 触发器拿的 `FOR UPDATE` 都发生在拿到租户锁之后。

为什么不会成环：`lock_tenants` 只在本事务除了以下锁之外什么都没拿时，才排队等一把新的租户锁。

1. 本事务通过 `lock_tenants` 拿到的租户锁。它们按 `tenant_id` 升序获取，所以排队者只会等更大的租户。
2. `AccessShare`、`RowShare`、`RowExclusive` 表锁。这几种表锁与 DML 需要的表锁互不冲突。
3. 自己的 `virtualxid`，以及可串行化隔离的 `SIReadLock`。这些锁不阻塞任何人。

没有 `transactionid` 锁说明本事务还没有分配事务号，也就是没写过行，也没加过行锁（`FOR UPDATE`、`FOR SHARE` 等）。所以别的事务不会在它的行或事务号上等待。排队者手里没有持锁者会等的东西。持锁者在锁内的等待只可能指向其他已持锁的事务，或者不在排队的事务。否则 `lock_tenants` 报 SQLSTATE 55000 `租户 <id> 的锁要在本事务的任何写入、行锁和其他锁之前拿`，不排队。原来的死锁是这样形成的：A 先 `SELECT ... FOR UPDATE` 租户行再等租户锁，持锁的 B 写流水时外键 `KEY SHARE` 又等 A 的行锁，结果报 40P01。现在 A 在第一步之后调用 `lock_tenants` 就直接报错。这个规则没有增加任何锁。

- 只能锁当前身份有权访问的租户：租户身份（`app.scope = 'tenant'`）只能锁 `app.tenant_id`，管理员与系统身份可以锁任意租户，未声明身份或身份不完整一律不行。新连接只设置 `app.tenant_id`、不设置 `app.scope` 时，`app_can_see` 返回 NULL 而不是 false，所以函数用 `app_can_see(t) IS NOT TRUE` 判断越权。越权时报 SQLSTATE 42501 `当前身份不能锁租户 <id>`，不拿任何锁。函数是 `SECURITY DEFINER`，检查在函数体里做，应用侧绕不过去。
- 函数每拿到一把锁，就用 `set_config('app.tenant_locks', ..., true)` 把该租户追加到事务级标记里。“已持有”指本事务通过 `lock_tenants` 拿到：标记里有该租户，并且 `pg_locks` 里有这把锁。标记随事务结束或保存点回滚一起消失，所以会话级的同键 `pg_advisory_lock` 和连接池里上一个事务留下的状态都不算持有。
- 应用角色不能直接调用任何 advisory 锁函数：迁移对 `pg_advisory_*`、`pg_try_advisory_*` 的全部重载（会话级与事务级、加锁、尝试、解锁，以及 `pg_advisory_unlock_all`）`REVOKE EXECUTE … FROM PUBLIC, fs_billing_app`，直接调用报 42501 `permission denied for function pg_advisory_lock`。`lock_tenants` 是 `SECURITY DEFINER`，以 owner 执行，不受影响。`pg_catalog` 里的函数只有超级用户能改权限，迁移最后核对一遍，没撤销掉就报错，所以 `pnpm db:migrate` 要以超级用户执行。
- 新开户并在同一事务里建首个费率版本时，先生成租户编号并 `lock_tenants`，再插入租户。种子分两个事务：先写管理员与租户，再在新事务里锁租户，然后写费率、流水和话单。
- 同一事务的全部租户放进一次调用。标记按加锁顺序是升序的。之后再锁一个尚未持有、但比标记里最大租户更小的租户时报 SQLSTATE 55000，不等待。已经持有的租户可以重复传入。
- `rate_versions`、`rate_entries` 的增删和 `ledger_entries` 的插入由触发器检查本事务已持有该租户的锁。没有持有时报 55000，不写入。
- 应用侧 `createRateVersion`、`appendLedgerEntry`、`appendLedgerEntries` 自己调用 `lockTenants`。`appendLedgerEntries` 先校验并规范全部 `tenant_id`，非法值在发出任何 SQL 之前抛出，再一次锁齐全部租户。直接写 SQL 的事务自己先调用 `lock_tenants`。
- `withAdmin`、`withSystem` 作为最外层事务遇到 `40P01`、`40001` 时，回滚后重跑整个事务，最多 3 次。这只是兜底。租户锁下的写入路径不会产生 `40P01`。传入已有事务时它们只开保存点，不重试，错误原样抛给外层：保存点回滚不会撤销外层已经执行的语句和已经拿到的锁，重跑保存点不等于重跑事务。回调可能被重跑，所以只能做数据库操作，并且必须可以重跑：不发邮件、不调外部接口、不改事务外的内存状态。

### 话单唯一与分区

- `cdrs` 分区键为 `started_at`（呼叫开始时间，未接通的话单也有）。分区表的唯一约束必须包含分区键，所以 `UNIQUE (call_uuid, started_at)` 只能挡住同一时间的重复；真正的全局唯一由非分区登记表 `call_uuids (call_uuid PRIMARY KEY)` 保证。删除话单后登记表保留，同一 UUID 再次推送仍被拒绝，不会重复计费。
- **登记表由正式话单与未归属话单共用。** 一个 UUID 的登记只有三种状态：不存在、未归属（`tenant_id IS NULL`）、属于某个租户。
  - `unassigned_cdrs` 的 `BEFORE INSERT` 触发器插入 `tenant_id = NULL` 的登记；UUID 已登记（无论是否归属）时报 `23505 call_uuids_pkey`。
  - `cdrs` 的 `BEFORE INSERT` 触发器插入登记，或认领一条 `tenant_id IS NULL` 的登记（阶段 8 分配未归属话单）；登记已属于任何租户（包括本租户）时报与普通唯一冲突相同的 `23505 call_uuids_pkey`。
  - 因此同一通电话最多归属一个租户、最多扣费一次，阶段 8 把已计费的 UUID 再分配给另一个租户会被数据库拒绝。
  - 触发器在 `ON CONFLICT` 判断之前执行，`INSERT … ON CONFLICT DO NOTHING` 挡不住登记表的冲突；去重的调用方识别 `23505 call_uuids_pkey`（种子先查登记表再插入）。
- `raw_cdrs` 按 `received_at`（收到推送的时间，解析失败时也一定有）的北京月份分区，归档时可以整月分离分区。数据库编码是 UTF-8。`body text` 保存的是按 UTF-8 解码后的文本，不是任意字节。合法 UTF-8 原文的字符原样读回。非法 UTF-8 或正文中的 NUL 不能写入 `text`。`payload jsonb` 是由 `body` 生成的列（`jsonb_or_null(body)`），供查询使用。`body::jsonb` 报 `22P02`、`22P05`（`\u0000`）或 `22003`（数值超出 numeric）时 `payload` 为空，原文照样保存，其他错误照常抛出。`call_uuid` 可空，原文中解析不出 UUID 也能保存；去重不在这张表做。
- `ensure_month_partition(parent, moment)` 幂等地建出 `cdrs` 或 `raw_cdrs` 在 `moment` 所在北京时间月份的分区。调用者的 `app.scope` 必须是 `admin` 或 `system`，否则在加锁之前拒绝。应用角色没有这个函数的 `EXECUTE`。先用 `to_regclass` 检查，已存在就直接返回，不加锁。不存在时才拿该分区的事务级 advisory 锁并再检查一次，然后建表并启用 RLS。只有分区已存在时，并发调用才不会互相串行；创建同一缺失分区的调用会串行执行。本事务持有租户锁（`app.tenant_locks` 标记非空）时一律报 `55000` `建分区要在单独的事务里进行，不能在持有租户锁的事务里`，分区已存在也报，让错误在开发时就暴露。原因见下文“建分区是维护操作”。
- `cdr_ensure_partitions(moment timestamptz DEFAULT now(), months_ahead integer DEFAULT 1)` 以 owner 身份（`SECURITY DEFINER`）建两张表从 `moment` 所在月起、往后 `months_ahead` 个月的分区，默认返回当月与下月共 4 个分区名。应用角色有这个函数的 `EXECUTE`。函数体仍调用 `ensure_month_partition`，所以租户身份和未声明身份报 `42501` `建分区只允许管理员或系统身份`。没有 DEFAULT 分区。落在未建分区月份的插入直接报错，而不是悄悄进入兜底分区。
- **建分区是维护操作，不在写入路径上。** `ensureCdrPartitions(db, { moment?, monthsAhead? })`（`packages/db/src/partitions.ts`）只接受带 `$client: pg.Pool` 的 `PoolDb`，在自己的系统身份事务里调用 `cdr_ensure_partitions`；传事务会在类型检查时失败。`pnpm db:migrate` 和种子各调用一次，种子在持租户锁的事务之前调用。阶段 3 由 Worker 每日调度、启动时执行一次（见 plan.md 阶段 3）。扣费与入库的写入路径遇到缺分区时报 `23514 no partition of relation "cdrs" found for row`，Worker 记日志、写 `partition_failed` 告警，不建分区。
  - 为什么不能在写入路径上建：`CREATE TABLE … PARTITION OF cdrs` 要父表的 AccessExclusive 锁，会等所有读过 `cdrs` 的事务。事务 A 持租户锁，事务 B 读过 `cdrs` 后在 `lock_tenants` 排队等 A（AccessShare 表锁允许排队，见上文“为什么不会成环”），这时 A 建分区就要等 B，成环，1 秒后 `40P01`。`ensure_month_partition` 在持有租户锁时报 `55000`，测试复现了这个交错。
  - 单独的维护事务不在环里：它等读者释放 AccessShare 时，排在它后面的持锁事务的 RowExclusive 请求是软等待，PostgreSQL 的死锁检测会把它调到维护事务前面，不报错。

## 验收标准

数据库测试（`pnpm test:db`）每次运行先删除并重建 `fs_billing_test`，用与 `pnpm db:migrate`、`pnpm db:seed` 相同的代码迁移与写种子，测试以应用角色 `fs_billing_app` 连接。下面的 psql 输出来自 [`evidence/phase-2/acceptance.sql`](evidence/phase-2/acceptance.sql)，在开发库上以应用角色执行，完整输出见 [`acceptance.txt`](evidence/phase-2/acceptance.txt)；脚本中的写操作全部在回滚的事务里。

- [x] **空库上 `pnpm db:migrate && pnpm db:seed` 成功，再迁移一次不报错。** 先 `DROP DATABASE fs_billing` 并重建，`\dt` 输出 `Did not find any relations.`，然后依次执行 `pnpm db:migrate`、`pnpm db:seed`、`pnpm db:seed`、`pnpm db:migrate`，四条命令都以 0 退出（输出见下）。`migrate.db.test.ts` 在已迁移的库上再次调用 `migrateDatabase`，`drizzle.__drizzle_migrations` 仍为 1 行。种子重复执行不新增任何行（流水 50、话单 5、未归属话单 1、UUID 登记 6、费率版本 11、条目 88，前后一致）。
- [x] **余额流水 `UPDATE`、`DELETE` 被数据库拒绝。** 应用角色：`ERROR:  permission denied for table ledger_entries`（UPDATE 与 DELETE 各一次）。owner（超级用户）：`ERROR:  ledger_entries 只能新增，禁止 UPDATE`、`… 禁止 DELETE`；测试另覆盖 `TRUNCATE ledger_entries CASCADE` → `… 禁止 TRUNCATE`，以及之后种子流水仍为 50 行。
- [x] **以租户 A 身份 `SELECT * FROM cdrs` 只返回 A 的数据。** 以 ABC001 身份执行 `SELECT * FROM cdrs`（无租户条件）返回 3 行，`tenant_id` 全部为 ABC001；`count(DISTINCT tenant_id)` = 1。GZT007 身份只看到自己的 2 条话单、自己的流水和自己的租户行；未声明身份时 `cdrs`、`ledger_entries` 均为 0 行；租户身份写入他人流水报 `new row violates row-level security policy for table "ledger_entries"`；直接读分区 `cdrs_2026_09` 报 `permission denied`。
- [x] **ABC001 余额由流水合计算出为 −35.20。** 以 ABC001 身份 `SELECT sum(amount) FROM ledger_entries` → `-35.20`（33 条流水），缓存 `tenant_balances.balance` → `-35.20`，`formatMoney(loadRatingTenant(...).balance)` → `'-35.20'`；`balance_discrepancies` 为空。
- [x] **同一 UUID 的话单插入两次，第二次被唯一约束挡住。** `ERROR:  duplicate key value violates unique constraint "call_uuids_pkey"`；开始时间不同（落在不同分区）的同一 UUID 同样被挡住。
- [x] **建分区只允许管理员或系统身份。** 应用角色可以执行 `cdr_ensure_partitions`，不能执行 `ensure_month_partition`。租户身份与未声明身份调用前者报 `42501` `建分区只允许管理员或系统身份`。系统身份调用返回 4 个分区名。
- [x] **插入下个月的话单前自动建分区，`\d+` 能看到对应分区。** 迁移已建出 `cdrs_2026_10`、`cdrs_2026_11`（以及 `raw_cdrs` 的同月分区）；北京时间 `2026-11-01 01:00` 的话单直接落入 `cdrs_2026_11`；模拟下月的每日任务 `cdr_ensure_partitions(now() + interval '1 month')` 返回 `cdrs_2026_11`、`cdrs_2026_12`、`raw_cdrs_2026_11`、`raw_cdrs_2026_12`，`\d+ cdrs` 列出 4 个分区（见下）。测试用固定时间验证边界：`2027-01-31 23:59:59+08` 落入 `cdrs_2027_01`，`2027-02-01 00:00:00+08` 落入 `cdrs_2027_02`；无分区月份插入报 `no partition of relation "cdrs" found for row`。
- [x] **费率版本（费率表，`effectiveFrom`）唯一。** `ERROR:  duplicate key value violates unique constraint "rate_versions_tenant_effective_from_key"`。
- [x] **已排定未来版本时修改当前版本：禁止，并提示先改未来版本。** 先排定 7 天后的版本，再插入立即生效的版本：`ERROR:  已排定 2026-10-20 01:43:19.278455+00 生效的新版本，请先修改该未来版本`。删除（取消）未来版本后可以修改当前版本；早于当前版本的生效时间被拒绝；已生效版本的条目不可增删改、版本不可删改。规则与理由见上文“费率版本规则”。
- [x] **事务跨过生效时间后不能再改删该版本。** 版本的 `effective_from` 在事务开始之后。`pg_sleep` 到 `clock_timestamp() >= effective_from` 且 `transaction_timestamp() < effective_from` 之后，删除版本报 `42501` `已生效的费率版本不可删除`，增删条目报 `42501` `已生效的费率版本不可修改，请新建版本`。回滚后版本与原条目仍在（1 条，费率前缀 `86`）。
- [x] **首个“立即生效”版本 `effectiveFrom ≤ now`，开户后立刻授权能匹配到费率。** 新开户后不传生效时间插入版本：`effective_now = t`。测试中开户、建版本、提交后，以数据库 `clock_timestamp()` 为时刻调用阶段 1 的 `authorize`：`{ allowed: true, entry: { prefix: '86' }, callableMinutes: 2000, maxSeconds: 14400 }`。对照用例：生效时间取应用时钟且快 5 秒时，同样的调用返回 `{ allowed: false, reason: '无费率' }`。

评审后追加的结构决定（见“已决定事项”），同样由 `pnpm test:db` 与上面的 psql 脚本验证：

- [x] **流水按发生时间归属月份。** owner 写入北京时间 9-30 23:59 接通、10-01 00:00:30 入账的扣费：`statement_month = 2026-09`，`written_month = 2026-10`。种子中 ABC001 的 28 笔通话扣费全部归属 2026-09，合计 `-2486.30`（设计稿本月消费）。人工充值只倒填 `occurred_at` 时报 `violates check constraint "ledger_entries_kind_shape"`。应用角色把人工调账的 `occurred_at` 和 `created_at` 一起写成 `2026-09-01` 时报 `42501` `created_at 由数据库生成`。不写这两列的调账成功，且 `occurred_at = created_at = transaction_timestamp()`。
- [x] **未归属与正式话单共用 UUID 登记表。** 先进未归属话单的 UUID 登记为 `tenant_id = NULL`，之后写入 ABC001 的正式话单时认领成功（测试读回登记表为该租户）；同一 UUID 再给 GZT007：`duplicate key value violates unique constraint "call_uuids_pkey"`；已在正式话单中的 UUID 再进未归属话单：同样报 `call_uuids_pkey`。
- [x] **原始话单按 UTF-8 文本原样保存，按收到时间分区。** 数据库编码是 UTF-8，`body` 是 `text`。含换行、制表符、多余空格、非字母序键和重复键 `"billsec"` 的 124 字节原文：读回 `body` 与写入的字面量完全相同，`payload` 为规范化副本 `{"a": [1, 2], "z": 1, "variables": {…, "billsec": "231"}}`；北京时间 `2026-10-31 23:59:59` 收到的落入 `raw_cdrs_2026_10`。截断的原文、含 `\u0000` 的原文，以及数值 `{"n":1e1000000}` 照样保存，`payload` 为空。
- [x] **持有租户锁时建分区被拒绝，不再死锁。** A 持租户锁，B 读过 `cdrs` 后在 `lock_tenants` 上排队，A 再调用 `cdr_ensure_partitions('2032-05-15')`（分区不存在）：A 报 `55000 建分区要在单独的事务里进行，不能在持有租户锁的事务里`，A 回滚后 B 拿到锁。旧实现里 B 收到 `40P01 deadlock detected`。分区已存在时持锁调用同样报 `55000`。
- [x] **分区已存在时不加锁。** 另一个连接持有 `cdrs_2026_10` 与 `cdrs_2031_03` 的建分区锁时，`lock_timeout = 300ms` 下 `cdr_ensure_partitions('2026-10-12')` 立即返回 4 个分区名；`cdr_ensure_partitions('2031-03-15')`（分区不存在）报 `55P03 canceling statement due to lock timeout`。把加锁移回检查之前，这个测试失败。
- [x] **系统告警可记录建分区失败。** `INSERT INTO system_alerts (kind, …) VALUES ('partition_failed', …)` 成功；未定义的类型报 `violates check constraint "system_alerts_kind_check"`。

### 迁移与种子输出

```text
$ psql …/postgres -c "DROP DATABASE fs_billing WITH (FORCE)" -c "CREATE DATABASE fs_billing"
DROP DATABASE
CREATE DATABASE
$ psql …/fs_billing -c "\dt"
Did not find any relations.
$ pnpm db:migrate
迁移完成
$ pnpm db:seed
┌─────────┬──────────┬──────────┬───────────┐
│ (index) │ code     │ currency │ balance   │
├─────────┼──────────┼──────────┼───────────┤
│ 0       │ 'ABC001' │ 'CNY'    │ '-35.20'  │
│ 1       │ 'BJH003' │ 'CNY'    │ '1286.40' │
│ 2       │ 'CDT018' │ 'CNY'    │ '0.00'    │
│ 3       │ 'GLB009' │ 'USD'    │ '-15.02'  │
│ 4       │ 'GZT007' │ 'CNY'    │ '86.50'   │
│ 5       │ 'HZX014' │ 'CNY'    │ '-100.36' │
│ 6       │ 'NYC021' │ 'USD'    │ '2140.00' │
│ 7       │ 'SGN011' │ 'USD'    │ '12.30'   │
│ 8       │ 'SHC005' │ 'CNY'    │ '8950.00' │
│ 9       │ 'XYZ002' │ 'USD'    │ '-4.82'   │
└─────────┴──────────┴──────────┴───────────┘
$ psql …/fs_billing -c "SELECT (SELECT count(*) FROM ledger_entries) AS ledger, …"
 ledger | cdrs | unassigned | call_uuids | versions | entries
--------+------+------------+------------+----------+---------
     50 |    5 |          1 |          6 |       11 |      88
$ pnpm db:seed   # 再执行一次，输出同上
$ psql …/fs_billing -c "SELECT (SELECT count(*) FROM ledger_entries) AS ledger, …"
 ledger | cdrs | unassigned | call_uuids | versions | entries
--------+------+------------+------------+----------+---------
     50 |    5 |          1 |          6 |       11 |      88
$ pnpm db:migrate
迁移完成
```

余额与设计稿（管理后台第一批租户列表）逐一相同。

### psql 输出摘录（应用角色）

```text
== 应用角色
  current_user  | rolsuper | rolbypassrls
----------------+----------+--------------
 fs_billing_app | f        | f

== 余额流水 UPDATE / DELETE
ERROR:  permission denied for table ledger_entries
ERROR:  permission denied for table ledger_entries

== 以 ABC001 身份 SELECT * FROM cdrs（SQL 中没有租户条件）
              tenant_id               |              call_uuid               | … |    callee     | … | charge
--------------------------------------+--------------------------------------+---+---------------+---+--------
 0d3c98d0-cb4b-47c1-87dc-bd5b8211f7e9 | a0000001-0000-4000-8000-000000000001 | … | 447700900123  | … |   0.18
 0d3c98d0-cb4b-47c1-87dc-bd5b8211f7e9 | a0000001-0000-4000-8000-000000000002 | … | 18765550100   | … |   0.25
 0d3c98d0-cb4b-47c1-87dc-bd5b8211f7e9 | a0000001-0000-4000-8000-000000000003 | … | 8613800138000 | … |      0

 cdrs | tenants
------+---------
    3 |       1

== ABC001 余额（流水合计与缓存）
 ledger_total | entries
--------------+---------
       -35.20 |      33

 balance
---------
  -35.20

== 未声明身份
 cdrs | ledger
------+--------
    0 |      0

== 同一 UUID 插入两次
INSERT 0 1
ERROR:  duplicate key value violates unique constraint "call_uuids_pkey"
DETAIL:  Key (call_uuid)=(e0000000-0000-4000-8000-000000000001) already exists.

== 未归属与正式话单共用 UUID 登记表
INSERT 0 1
-- 分配给 ABC001：认领未归属的登记
INSERT 0 1
-- 同一 UUID 再给 GZT007
ERROR:  duplicate key value violates unique constraint "call_uuids_pkey"
DETAIL:  Key (call_uuid)=(e0000000-0000-4000-8000-000000000003) already exists.
-- 已在正式话单中的 UUID 再进未归属话单
ERROR:  duplicate key value violates unique constraint "call_uuids_pkey"
DETAIL:  Key (call_uuid)=(a0000001-0000-4000-8000-000000000001) already exists.

== 流水发生时间
-- 种子中 ABC001 按 occurred_at 的北京月份汇总通话扣费
  month  | call_charges | entries
---------+--------------+---------
 2026-09 |     -2486.30 |      28

-- 应用角色回填 created_at 的人工调账被拒绝
ERROR:  created_at 由数据库生成

-- 人工操作倒填发生时间
ERROR:  new row for relation "ledger_entries" violates check constraint "ledger_entries_kind_shape"

== 原始话单：原文逐字节保存（空白、键序、重复键），payload 为规范化副本
    partition     | body_identical | bytes |                                                payload
------------------+----------------+-------+--------------------------------------------------------------------------------------------------------
 raw_cdrs_2026_10 | t              |   124 | {"a": [1, 2], "z": 1, "variables": {"uuid": "7f1c2a9e-0d3b-4c5e-8a6f-1b2c3d4e5f60", "billsec": "231"}}

-- 不是合法 JSON 的原文也保存，payload 为空
    partition     |        body         | payload_null
------------------+---------------------+--------------
 raw_cdrs_2026_11 | {"uuid": "truncated | t

-- 数值超出 numeric 的 JSON 原文也保存，payload 为空
      body       | payload_null
-----------------+--------------
 {"n":1e1000000} | t

                                                                  Partitioned table "public.raw_cdrs"
…
 body        | text                     |           | not null |                                                  | extended | …
 payload     | jsonb                    |           |          | generated always as (jsonb_or_null(body)) stored | extended | …
 received_at | timestamp with time zone |           | not null | now()                                            | plain    | …
Partition key: RANGE (received_at)
Indexes:
    "raw_cdrs_pkey" PRIMARY KEY, btree (id, received_at)
…
Partitions: raw_cdrs_2026_09 FOR VALUES FROM ('2026-08-31 16:00:00+00') TO ('2026-09-30 16:00:00+00'),
            raw_cdrs_2026_10 FOR VALUES FROM ('2026-09-30 16:00:00+00') TO ('2026-10-31 16:00:00+00'),
            raw_cdrs_2026_11 FOR VALUES FROM ('2026-10-31 16:00:00+00') TO ('2026-11-30 16:00:00+00')

== 系统告警类型含 partition_failed
       kind       |       description
------------------+--------------------------
 partition_failed | 建分区 cdrs_2026_12 失败

ERROR:  new row for relation "system_alerts" violates check constraint "system_alerts_kind_check"

== 下月分区
  partition   |       started_at
--------------+------------------------
 cdrs_2026_11 | 2026-10-31 17:00:00+00

 cdr_ensure_partitions
-----------------------
 cdrs_2026_11
 cdrs_2026_12
 raw_cdrs_2026_11
 raw_cdrs_2026_12

                                                   Partitioned table "public.cdrs"
…
Partition key: RANGE (started_at)
Indexes:
    "cdrs_pkey" PRIMARY KEY, btree (call_uuid, started_at)
    "cdrs_tenant_answered_at" btree (tenant_id, answered_at)
Policies:
    POLICY "operator_delete" FOR DELETE
      USING (app_is_operator())
    POLICY "operator_insert" FOR INSERT
      WITH CHECK (app_is_operator())
    POLICY "operator_update" FOR UPDATE
      USING (app_can_see(tenant_id))
      WITH CHECK (app_is_operator())
    POLICY "tenant_read" FOR SELECT
      USING (app_can_see(tenant_id))
Triggers:
    cdrs_register_call_uuid BEFORE INSERT ON cdrs FOR EACH ROW EXECUTE FUNCTION cdrs_register_call_uuid()
Partitions: cdrs_2026_09 FOR VALUES FROM ('2026-08-31 16:00:00+00') TO ('2026-09-30 16:00:00+00'),
            cdrs_2026_10 FOR VALUES FROM ('2026-09-30 16:00:00+00') TO ('2026-10-31 16:00:00+00'),
            cdrs_2026_11 FOR VALUES FROM ('2026-10-31 16:00:00+00') TO ('2026-11-30 16:00:00+00'),
            cdrs_2026_12 FOR VALUES FROM ('2026-11-30 16:00:00+00') TO ('2026-12-31 16:00:00+00')

== 费率版本：同一费率表相同生效时间
ERROR:  duplicate key value violates unique constraint "rate_versions_tenant_effective_from_key"

== 费率版本：已排定未来版本时新建立即生效版本
        effective_from
------------------------------
 2026-10-20 01:43:19.278455+00

ERROR:  已排定 2026-10-20 01:43:19.278455+00 生效的新版本，请先修改该未来版本

== 费率版本：开户后首个立即生效版本
        effective_from         | effective_now
-------------------------------+---------------
 2026-10-13 01:43:19.280066+00 | t
```

以 owner（超级用户）执行：

```text
$ psql "$DATABASE_URL" -c "UPDATE ledger_entries SET amount = 0" -c "DELETE FROM ledger_entries" -c "SELECT * FROM balance_discrepancies"
ERROR:  ledger_entries 只能新增，禁止 UPDATE
ERROR:  ledger_entries 只能新增，禁止 DELETE
 tenant_id | code | cached_balance | ledger_total
-----------+------+----------------+--------------
(0 rows)
```

分区边界是北京时间的月初：`cdrs_2026_10` 从 `2026-09-30 16:00:00+00`（= 2026-10-01 00:00 北京时间）开始。

## 本地运行证据

环境：Linux x64，Node.js 24.21.0，pnpm 10.34.7，PostgreSQL 17.9（`pnpm db:up`），验证日期 2026-10-12。

| 命令            | 结果                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`    | 0 退出；ESLint（金额规则已覆盖 `packages/db`）、Prettier、TypeScript 全部通过；Vitest 10 个文件 119 个测试通过（不连接数据库）                                                                          |
| `pnpm test:db`  | 0 退出；7 个文件 93 个测试通过（`migrate`、`client`、`tenant-lock`、`ledger`、`rls`、`cdrs`、`rates`）                                                                                                  |
| `pnpm coverage` | `packages/rating` 行覆盖率 100%（137/137），阈值 95% 不变                                                                                                                                               |
| `pnpm build`    | 0 退出，含 `packages/db`                                                                                                                                                                                |
| DB 测试的覆盖率 | 以 `--coverage` 运行 `test:db`：`rates.ts` 行覆盖 100%，`ledger.ts` 97.91%，`client.ts` 96.29%。`seed.ts`、`partitions.ts` 不在统计里，因为它们在 `globalSetup`（主进程）中执行，不在被统计的工作进程里 |

新增测试能失败：临时把 `ensure_month_partition` 的加锁移到检查之前、把 `cdrs` 触发器改回普通 `INSERT`，`pnpm test:db` 中“分区已存在时不等待建分区锁”“由正式话单认领”“再给第二个租户被拒绝”3 个测试失败；当时恢复后 49 个全部通过。当前套件是 93 个。本轮新增的“新连接只设置 app.tenant_id”“持租户锁建缺失分区”“应用角色不能直接调用 advisory 锁函数”3 个测试在修复前的代码上失败：逐项撤回对应修复，各自的测试失败；撤回建分区的 55000 检查时，“持租户锁建缺失分区”里读者收到 `40P01 deadlock detected`。

CI 在 PostgreSQL 启动后增加两步：空库上 `pnpm db:migrate && pnpm db:seed && pnpm db:migrate`，以及 `pnpm test:db`。

上述命令在本轮修改之后重新执行。表中数字是 2026-10-12 这次执行的结果。空库上 `pnpm db:migrate`、`pnpm db:seed`、再一次 `pnpm db:migrate` 都以 0 退出。第二次迁移打印“迁移完成”。种子余额 ABC001 为 `-35.20`。

## 设计取舍

- **迁移手写 SQL，Drizzle 只做查询描述。** 分区、触发器、RLS、复合外键无法由 `drizzle-kit generate` 生成；用一个来源（SQL）避免两份半真半假的结构，`migrate.db.test.ts` 核对 17 张表的列名与 Drizzle 描述一致。
- **“费率表”即租户。** design §6.1 每个租户一张费率表，所以不建 `rate_tables`，唯一约束为 `(tenant_id, effective_from)`。
- **修改当前版本的规则选“禁止并提示”**，实现为“新版本必须晚于所有已有版本”这一条不变量，而不是针对“立即生效”的特殊判断；同时挡住倒填历史。
- **立即生效取数据库时间。** 不传 `effective_from`，由列默认值 `now()` 填写；对照测试证明应用时钟快几秒就会让开户后立即授权变成“无费率”。
- **RLS 身份用事务级会话变量，默认拒绝。** 未声明身份时任何业务表 0 行。管理员与系统身份可见全部。各分区不授予应用角色权限，只能经父表访问。应用角色不是超级用户。租户编号和 `app.scope` 由应用设置，见上文“RLS 的信任边界”。
- **流水双重保护。** 触发器对所有角色（含 owner）拒绝 `UPDATE`/`DELETE`/`TRUNCATE`；应用角色另外没有这些权限，所以应用侧看到的是 `permission denied`，owner 看到的是触发器信息。
- **收款状态是事件。** `receivable_settlements` 独立成表，复合外键保证只能结算本租户的赊账充值，唯一约束保证只能结算一次；状态由 `receivables` 视图派生。
- **话单 UUID 全局唯一用登记表，正式与未归属话单共用。** 分区表的唯一约束必须含分区键；`call_uuids` 主键挡住跨分区的重复，且删除话单后仍保留，防止同一通话重复计费。流水的幂等键唯一约束是按租户的，挡不住同一 UUID 分别记到两个租户；只有一张全局登记表能从结构上排除，而“先查两处再写”在并发下有竞态。
- **`cdrs` 分区键用 `started_at`。** 未接通的话单没有接通时间；呼叫开始与接通相差几秒，只影响月底最后几秒的分区归属，不影响按接通时间的账务统计。
- **流水加 `occurred_at` 而不是改用 `created_at` 统计。** 扣费在接通之后才写入，跨月的电话按写入时间会算进下个月，plan 阶段 7 的“期末余额 = 截至月末的流水合计”在月底失败。没有加 `occurred_at ≤ created_at` 检查：接通时间来自 FreeSWITCH 的时钟，与数据库时钟有偏差时会让扣费写入失败。应用角色的 `created_at` 必须是数据库 `now()`。不用列权限，因为 Drizzle 的 INSERT 会列出该列并写 `DEFAULT`，列权限会拒绝这次合法插入。种子的历史时间走 owner 连接，触发器不限制 owner。
- **`raw_cdrs` 按 `received_at` 分区，原文存 `text`。** 数据库编码是 UTF-8，`body` 保存解码后的文本。6 个月后归档就是整月分离分区再导出，不在大表上逐行删除。`jsonb` 会规范空白、重排键、合并重复键，不能按收到的文本原样恢复，所以原文另存，`payload` 由原文生成，两者不会不一致。解析函数只捕获 `22P02`（`invalid_text_representation`）、`22P05`（`untranslatable_character`，`\u0000`）和 `22003`（`numeric_value_out_of_range`），其他错误照常抛出。
- **建分区先查后锁，且只允许管理员或系统身份。** 每日任务和启动时的调用几乎总是遇到已存在的分区，分区已存在时，先查后锁让它们不互相等待；同一缺失分区的创建仍会串行执行。应用角色可以执行 `cdr_ensure_partitions`，函数内部仍要求 `app.scope` 为 `admin` 或 `system`。`ensure_month_partition` 不授予应用角色。
- **不建 DEFAULT 分区，写入路径不建分区。** 落在未建分区月份的话单直接报错并告警（FreeSWITCH 落盘重推，维护任务补建分区后成功），而不是悄悄进入兜底分区，也不在持租户锁的写入事务里建分区。
- **币种一致在类型层保证。** `appendLedgerEntry(tx, tenant: TenantRef<C>, entry: LedgerEntryInput<NoInfer<C>>)`，CNY 金额记入 USD 租户是类型错误（测试中的 `@ts-expect-error`）。数据库的金额列不带币种，由租户币种决定。
- **金额按 `Decimal.toFixed()` 原样写入。** 不补零也不舍入，例如 `100.00` 存为 `100`；显示时用阶段 1 的 `formatMoney`。
- **种子中的通话扣费是按日汇总的流水**（与设计稿余额流水一致），`occurred_at` 取通话当日北京时间 23:59:59，`created_at` 是次日 00:05 左右的扣费时间；未逐通生成话单；种子另含 5 条示例话单（ABC001 3 条、GZT007 2 条），其费用由阶段 1 的 `priceCall` 计算，用于演示 RLS，不计入流水。

## 已决定事项

评审中提出的 6 个问题已决定，结构改动直接改在 `0000_init.sql`（迁移尚未上生产）：

1. **首个费率版本可以倒填：已决定。** 数据库层允许（只要求新版本晚于所有已有版本，种子用 `2026-09-01` 复现设计稿的 9 月数据）。倒填第一个版本改不动任何已有账务：已接通的话单必须有费率（`cdrs_answered_shape`），所以有费率之前不可能有已计费话单。阶段 5 的管理接口强制“指定时间 ≥ now()”，页面本来只提供“立即/指定时间”两种选择；该项已列入 plan.md 阶段 5 验收标准。
2. **通话扣费一通一笔，按 `occurred_at` 归属：已决定并实现。** 流水保持每通一笔（幂等键 `call:<UUID>`），授权依赖实时余额；门户的“按天合并”只在显示层按 `occurred_at` 的北京日期分组。阶段 3 写 `occurred_at = answered_at`，阶段 6/7 的合并显示、月账单与核对任务按 `occurred_at` 的北京日/月统计（已列入 plan.md）。
3. **登录凭据用 Better Auth 自带表：已决定，阶段 4 实现。** 认证表放在不启用 RLS 的 `auth` schema（登录时还不知道租户）；`admins`、`portal_accounts` 保留为业务资料表，各加 `auth_user_id` 一对一关联；邮箱以认证表为唯一来源；Better Auth 用单独授权的数据库角色。代价是管理员和客户不能共用一个邮箱。已列入 plan.md 阶段 4 验收标准；本阶段两张表不含密码列，不需要改。
4. **UUID 登记表两类话单共用：已决定并实现。** 见上文“话单唯一与分区”。
5. **原始话单按月分区并保存原文：已决定并实现。** 见上文“话单唯一与分区”。归档与恢复在阶段 8。
6. **建分区先查后锁，覆盖 `raw_cdrs`：已决定并实现。** 建分区只作为维护操作运行：pg-boss 每日任务、Worker 启动时执行；写入路径缺分区报错并写 `partition_failed` 告警，不建分区。已列入 plan.md 阶段 3 验收标准；告警类型已加入检查约束。

## 后续决定与已解决事项

1. **生产环境的应用角色密码** 由 `pnpm db:migrate` 按 `APP_DATABASE_URL` 设置；部署方式在阶段 10 确定。
2. **认领登记时是否要求未归属话单已标记为“已分配”。** 现在 `cdrs` 能认领任何 `tenant_id IS NULL` 的登记，不检查对应的 `unassigned_cdrs` 行是否在同一事务中改为 `assigned` 且 `assigned_tenant_id` 一致。阶段 8 的分配流程在同一事务中完成这几步；是否要用触发器强制，阶段 8 决定。
3. **重复推送的原文全部保存，阶段 3 已实现。** 每次收到的原始推送都写入 `raw_cdrs`，同一通话推送两次保留两份原文；正式话单和扣费仍按 UUID 去重。
4. **pg-boss 由 owner 安装，阶段 3 已实现。** 应用角色没有 `CREATE` 权限；部署时执行 `pnpm --filter @fs-billing/worker queue:migrate`，脚本使用 `DATABASE_URL` 的 owner 连接安装队列 schema。Worker 使用应用角色且关闭自动迁移。

## 范围边界

本阶段只提供表结构、约束、身份与少量读写函数（`appendLedgerEntry`、`appendLedgerEntries`、`createRateVersion`、`loadRatingTenant`）。话单入库与扣费流程（阶段 3）、登录（阶段 4）、开户与余额操作界面（阶段 5）在后续阶段实现。

## 阶段 3 的评审修正

保存点测试直接读取 `app.tenant_locks`，断言加锁后的租户数组和回滚后的空数组；只接受 `TransactionRollbackError`，不吞掉其他异常。分区维护入口通过连接池 `$client` 类型排除事务，类型测试用 `@ts-expect-error` 验证。

`0000_init.sql` 只修正并发建分区的注释，SQL 行为不变。已核对当前 drizzle-orm 0.45.4 的 `pg-core/dialect.js`：迁移器记录 hash，但按最后已应用的 `created_at` 与 journal 的 `folderMillis` 比较决定是否执行，不校验历史 hash。注释变动不重跑已应用迁移，也不更新其记录的 hash；新库记录新 hash。升级迁移器时需要重新核对这一行为。
