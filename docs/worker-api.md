# Worker 接口（阶段 3）

Worker 独立于 Web/API，默认监听 `127.0.0.1:3001`。生产环境设置内网 IPv4 地址。运行时只使用 `APP_DATABASE_URL`（`fs_billing_app`）；业务与队列写入经 `withSystem`，写入前调用 `lockTenants`，不新增业务锁。金额由阶段 1 的 decimal.js 计价函数计算，不舍入。

## 启动与配置

```sh
pnpm db:migrate
pnpm --filter @fs-billing/worker queue:migrate
pnpm --filter @fs-billing/worker start
```

`queue:migrate` 是部署操作，使用 `DATABASE_URL` 的 owner 安装 pg-boss schema、建 `charge-cdr`、`reconcile-cdr-charges`、`maintain-cdr-partitions` 与内部调度队列并授权。可重复执行；运行时关闭自动迁移与建 schema。当前固定 pg-boss 12.37.1，升级版本时需要单独迁移队列 schema。

| 环境变量             | 要求                                               |
| -------------------- | -------------------------------------------------- |
| `APP_DATABASE_URL`   | PostgreSQL URL，用户必须为 `fs_billing_app`        |
| `WORKER_HOST`        | 默认 `127.0.0.1`，仅接受回环或 RFC1918 IPv4        |
| `WORKER_PORT`        | 默认 `3001`，整数 1–65535                          |
| `WORKER_SHARED_KEY`  | 至少 16 字符                                       |
| `WORKER_ALLOWED_IPS` | 逗号分隔的非空 IP 列表，例如 `127.0.0.1,10.0.0.10` |

`POST /authorize` 与 `POST /cdr` 必须带 `X-Billing-Key`，缺失或错误返回 401（固定长度 SHA-256 摘要经 `timingSafeEqual` 比较），来源 IP 不在白名单返回 403。使用连接的实际 IP，不信任代理头。`GET /health` 返回 `{"status":"ok","service":"worker"}`，不检查数据库。

## POST /authorize

`Content-Type: application/json`：

```json
{
  "tenant": "ABC001",
  "callee": "867551234567",
  "dialedNumber": "07551234567",
  "billingNumber": "867551234567",
  "uuid": "7f1c2a9e-0d3b-4c5e-8a6f-1b2c3d4e5f60"
}
```

`tenant` 是非空字母数字编码，精确匹配（不补零、不改大小写）。`uuid` 必须为 UUID；授权不登记 UUID、不冻结余额、不产生扣费。新协议的 `callee` 传规范化计费号码，`dialedNumber` 传原始拨号。`dialedNumber` 是归一化输入，`billingNumber` 是可选投影。Worker 调用 `packages/rating/src/dialed.ts` 的 `resolveBillingNumber` 重新计算；投影必须与结果完全一致。

`dialedNumber` 只允许一个可选的开头 `+` 和 1–17 位 ASCII 数字。`+` 或 `00` 开头表示国际号码，去掉该冠字；没有冠字表示国内号码，先去掉一个开头的 `0`，再加 `86`。最终计费号码必须以 1–9 开头、长度为 6–15 位。`+13055551234` 得到 `13055551234`，裸拨 `13055551234` 得到 `8613055551234`。非法字符或长度超限返回 HTTP 400、SIP 484。`callee` 或投影不一致返回 HTTP 503，并记录计费号码不一致日志。

放行返回 HTTP 200：

```json
{ "allowed": true, "maxSeconds": 14400, "billingNumber": "867551234567" }
```

旧协议仅传 `tenant`、`callee` 与 `uuid`，其中 `callee` 按 6–15 位、首位非零的国际号码直接校验。旧 Lua 的裸拨国内号码并非国际号码，在滚动部署窗口仍可能匹配 `1` 前缀、误按 NANP 计费。以 `0` 开头的旧号码现在是格式错误，返回 HTTP 400、SIP 400，兼容旧 Lua 的错误码映射。没有 `dialedNumber` 时不补 `86`，成功响应仍为 `{"allowed":true,"maxSeconds":14400}`。`billingNumber` 不能单独出现；缺少 `dialedNumber` 却提供投影按号码不一致处理，返回 HTTP 503。

`maxSeconds` 是整数，按实时余额加透支额度、当前生效版本的最长前缀费率计算，单通最多 14400 秒。每次从 DB 加载，不缓存余额或费率。

业务拒绝返回 HTTP 200：

```json
{ "allowed": false, "reason": "余额不足", "sipCode": 402 }
```

| reason       | 建议 SIP code          | HTTP |
| ------------ | ---------------------- | ---- |
| 号码格式错误 | 新协议 484，旧协议 400 | 400  |
| 租户不存在   | 404                    | 200  |
| 租户已停用   | 403                    | 200  |
| 无费率       | 404                    | 200  |
| 余额不足     | 402                    | 200  |

号码字段缺失或类型错误同样返回 HTTP 400 `{"allowed":false,"reason":"号码格式错误","sipCode":484}`；没有 `dialedNumber` 的旧协议使用 `sipCode:400`。其他无效请求（例如 UUID 错误）返回 HTTP 400 `{"error":"授权请求格式错误"}`。数据库不可用时返回 HTTP 503 `{"error":"授权服务暂不可用"}`，不向客户端暴露数据库错误详情。FreeSWITCH 的 [授权脚本](../freeswitch/scripts/billing_authorize.lua) 先校验号码，只有合法号码在授权返回 503、整个请求超过 1.5 秒或无有效响应时才放行 1800 秒并设置 `billing_unverified=true`。非法号码在调用 `/authorize` 前返回 SIP 484 并挂断。正常放行在接通后执行 `sched_hangup +N`，拒绝执行建议的 SIP code。

## POST /cdr

正文是直接的 mod_json_cdr JSON 文本，可使用 `application/json` 或 `text/plain`。不接受 `cdr=<urlencoded JSON>` 包装；FreeSWITCH 设置 `encode=false` 与 `encode-values=false`，经本机 relay 添加 `X-Billing-Key` 后转发。配置与落盘重推步骤见 [FreeSWITCH 接入](../freeswitch/README.md)。真实字段布局见 [sample-cdr.json](../freeswitch/examples/sample-cdr.json)。`times` 位于 `callflow[]` 中，单位为微秒；业务解析使用 `variables` 中的时间戳，优先取 `*_uepoch` 微秒，缺失时才回退到 `*_epoch` 秒。两者同时提供时必须属于同一整秒，否则按时间校验失败处理；保存到 Date 与数据库时截断到毫秒，不四舍五入。

| variables 字段                            | 解析与不变量                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `uuid`                                    | UUID，规范成小写；去重的唯一键                                                                                            |
| `billing_tenant`                          | 精确的租户编码，缺失按空标签处理                                                                                          |
| `start_epoch` / `end_epoch`               | 正整数 epoch 秒，支持数字字符串或整数                                                                                     |
| `answer_epoch`                            | 缺失时从 `answer_uepoch` 取整秒，两者都缺失按 0；0 表示未接通；接通时必须在开始与结束之间                                 |
| `billsec` / `duration`                    | 非负整数秒（最大 2147483647），支持数字字符串；duration 等于结束减开始，billsec 不超过接通后秒数；未接通 billsec 必须为 0 |
| `billing_unverified`                      | 布尔值或字符串 `true` / `false`，缺失为 false                                                                             |
| `caller_id_number` / `destination_number` | 主叫与被叫字符串；旧协议被叫直接按国际号码校验，错误也保存为未归属话单                                                    |
| `billing_dialed_number`                   | 新协议原始拨号标记；优先作为展示被叫与归一化输入                                                                          |
| `billing_number`                          | 可选计费投影；存在时必须与原始拨号重新计算的结果一致                                                                      |
| `hangup_cause`                            | 挂断原因，缺失为空字符串                                                                                                  |

`start_uepoch`、`answer_uepoch`、`end_uepoch` 接受非负整数或数字字符串；无效值不能回退到秒数。时间先按微秒校验先后顺序，再截断到毫秒。

`caller_id_number` 与 `destination_number` 优先取 `variables`，缺失时取首个 `callflow` 的 `caller_profile`，仍缺失则为空字符串。新协议的 `billing_dialed_number` 优先于这些被叫字段，避免 `execute_extension` 改变 `destination_number` 后丢失客户原始拨号。缺主叫不拒绝话单；缺被叫按号码格式错误保存为未归属话单。

CDR 与授权调用同一个 `resolveBillingNumber`。存在 `billing_dialed_number` 时按新协议归一化并核验可选 `billing_number`；只有 `destination_number` 的旧话单直接按国际号码校验，不再次补 `86`，裸拨国内号码仍可能误按 NANP 计费，领先 `0` 的号码为格式错误。没有原始拨号标记却提供 `billing_number`，或投影不一致时，话单以 `计费号码不一致` 原因进入未归属待办，保存 Worker 计算的号码并写 `cdr_failed` 告警，不能收费。格式错误保存 NULL 计费号码。

其他 mod_json_cdr 字段不参与业务解析，原文全部保留。输入形状和输出类型由 `packages/shared/src/worker.ts` 的 Zod schema 派生。

处理顺序：

1. 将收到的 UTF-8 文本原样写入 `raw_cdrs.body`，在独立系统事务里提交。每次推送一行，包括重复和损坏正文。保留空白、字段顺序与重复键；`payload` 是数据库生成的规范副本。先保存后解析，原文行的 `tenant_id`、`call_uuid` 保持 NULL；响应 `rawId` 可定位原文，UUID 可从 payload 查询。
2. JSON 语法损坏时仍保留原文、返回 200 `invalid` 并告警。JSON 可解析但结构/时间校验失败时，保存 `unassigned_cdrs(status=pending)`、原因和 `raw_id/raw_received_at` 原文引用，返回 200 `unassigned` 并写 `cdr_failed`。未知 UUID/开始/结束时间为 NULL，不伪造通话数据；有效 UUID 仍由 `call_uuids` 去重，缺开始时间时登记表使用收到时间作为占位，人工修正前不能认领。缺 UUID 的每次推送各有待办，人工按原文处理；不自动猜测两份正文是否同一通话。
3. 解析成功后检查 `call_uuids`。已登记即返回 `duplicate`，不会将重推变成未归属话单的认领。入口设置事务级 `app.cdr_ingest=true`，登记触发器也禁止认领，因此并发插入同样只允许一条；只将 `23505` 且约束为 `call_uuids_pkey` 的冲突识别为重复，不使用话单 `ON CONFLICT DO NOTHING`。
4. 缺标签、未知租户（包括 `ABC01`）、错误被叫进入 `unassigned_cdrs(status=pending)` 并写 `cdr_failed`，HTTP 200，不入扣费队列。重复推送不重复告警。
5. 将原始展示号码存入 `callee`，将重新计算并核验的号码存入 `billing_number`。有效的未归属号码也保存到该列，号码或投影错误时为 NULL。接通电话以 `billing_number` 按接通时刻选版本与最长前缀，保存费率和计价快照。接通时无费率也进入 pending 并告警；不能按 0 元收费。未接通话单的时长和费用为 0。`billing_unverified` 保存为 `cdrs.unverified`，照常计费；首次有效话单在同一入库事务写一条 `auth_timeout` 告警，重推不重复写。Worker 不可能在断网时立即收到超时信号，告警随话单到达。
6. CDR 插入与 `charge-cdr` 入队在同一事务内提交。队列失败时两者和 UUID 登记全部回滚，原文保留，返回 503 供 FreeSWITCH 重推。

成功响应均为 HTTP 200：

```json
{ "status": "queued", "rawId": "a865a8ae-f220-4f21-b54c-40cb3aab26a8" }
```

`status` 为 `queued`、`duplicate`、`unassigned` 或 `invalid`。只有数据库/队列保存失败时返回 503 `{"error":"话单保存失败，请重推"}`，不暴露数据库错误详情。失败告警尽力写入，数据库故障导致告警也无法保存时只记日志，仍返回同一 503 正文；坏话单不返回 400。HTTP 层仍限制正文大小（Fastify 默认 1 MiB）；文本列不能保存非法 UTF-8 字节或实际 NUL 字符。

## 扣费队列边界

`ChargeQueue.enqueue(tx, {tenantId, callUuid})` 只做数据库操作，使用 pg-boss `fromDrizzle(tx, sql)` 与话单共用事务。`chargeCdr(db, unknown)` 在任务边界校验形状，再读取已保存的计价快照，调用 `appendLedgerEntry`，幂等键为 `call:<UUID>`、`occurred_at=answered_at`。零费率或未接通不产生零元流水（数据库只接受负值通话扣费）。扣费备注为 `通话扣费 <UUID> <billing_number>`；历史 NULL 行回退到原 `callee`。余额缓存由流水触发器更新。

启动后消费真实 pg-boss 扣费任务；开启 `supervise` 与 `schedule`，使用固定版本补丁禁用额外 advisory 锁。DB 测试通过真实队列领取、重复执行处理器、模拟提交前崩溃与提交后未确认任务的重投，断言账本与余额。

Worker 启动时在独立维护事务调用一次 `ensureCdrPartitions`。CDR 写入路径不建分区；遇到 SQLSTATE 23514 `no partition of relation … found for row` 时记日志、独立写 `partition_failed`、返回 503。缺分区的写入回滚，不登记 UUID，原文（若收到月份分区存在）保留，等待维护后重推。原文分区也缺失时同样告警并返回 503。维护启动失败记录 `partition_failed` 并退出。

## 验证命令

```sh
pnpm test:db apps/worker/src/app.db.test.ts
pnpm --filter @fs-billing/worker perf:authorize
pnpm check
pnpm test:db
pnpm coverage
```

压测脚本使用应用角色创建专用租户和 500 条费率，启动本机 HTTP listener，连续顺序发送 1000 个授权请求并读完响应，计算 nearest-rank p95；p95 ≥ 50 ms 或任何响应不正确时非零退出。没有预热、不并发、不缓存。结束后停用压测租户，保留已生效费率供检查（数据库禁止删除历史费率）。重复运行使用新租户，不影响已有客户。

## 扣费与维护任务

入库使用 `answered_at` 选择整表费率版本与最长前缀，保存该时刻的费率快照。任务只带租户编号与通话 UUID，以快照费率和接通时长调用 `packages/rating` 计价；接通时无匹配费率就在入库事务里保存 pending 未归属话单、写 `cdr_failed` 告警，不入扣费队列。未接通或合法零费率不产生扣费流水。

扣费在一个 `withSystem` 事务里先拿租户锁，再写 `call:<UUID>` 幂等流水；`occurred_at = answered_at`。流水与缓存余额一起提交。提交前崩溃回滚全部变动，提交后未确认任务的重投读回同一流水，余额不再减少。pg-boss 开启过期任务监督，扣费任务最多重投 3 次；失败立即记日志，错误继续向队列抛出；持续失败由对账任务合并为每话单一条告警。

Worker 启动时执行一次分区维护，然后注册每日北京时间零点任务（`0 0 * * *`，`tz: Asia/Shanghai`）。`ensureCdrPartitions` 接收数据库连接池对应的 PoolDb，自成系统身份维护事务，准备当前与下个月的正式及原始话单分区。维护失败记日志与 `partition_failed` 告警并抛错；启动失败不监听 HTTP。入库路径缺分区返回 503、记录同类告警，等待维护恢复后由 FreeSWITCH 重推；写入事务不建分区。

`patches/pg-boss@12.37.1.patch` 为固定版本提供 `noAdvisoryLocks` 配置，并让 Drizzle adapter 保留调用方事务的提交权。运行时禁止队列额外 advisory 锁，关闭队列统计分区和索引 DDL；队列安装仍是 owner 部署操作。升级 pg-boss 时需重新核对该补丁与崩溃重投验收。

验收：`pnpm test:db apps/worker/src/app.db.test.ts` 覆盖 HTTP 401/403、原文/UUID 去重、费率切换无匹配、跨月归属、插入流水后的模拟崩溃、队列重启与重投、启动/每日分区维护、缺分区重推。`pnpm test apps/worker/src/config.test.ts` 覆盖启动配置边界。

## FreeSWITCH 配置

[拨号计划与 Lua](../freeswitch/README.md) 保留原始被叫用于 bridge，不改写 `destination_number`。Lua 在任何校验或提前返回前设置 `billing_dialed_number`，校验后设置独立 `billing_number`，在请求前校验及超时放行时保留规范化投影；Worker 从原始拨号重新计算，核验请求与 CDR 的投影。脚本使用 Lua-cURL 的毫秒超时，密钥从全局变量读取，不写进通道变量。

`mod_json_cdr` 原生只支持 `cred` 的 HTTP Basic 认证，不能配置 `X-Billing-Key`。示例在 FreeSWITCH 机器放一个仅回环监听的 nginx relay，添加共享密钥后向 Worker 内网地址转发；Worker 的 IP 白名单填写 FreeSWITCH 机器来源 IP。配置只推 A-leg、直传 JSON，并保留 archive 与失败 retry 原文。HTTP 重试耗尽后由独立脚本扫描 retry 重推，2xx 才移除失败副本。缺分区或其他保存故障的 503 原样传回，不能在代理上改为成功。

## 号码协议滚动部署

迁移 `0003_billing_number` 给 `cdrs` 与 `unassigned_cdrs` 增加可空 `billing_number` 及规范号码约束，不回填历史数据，不新增业务锁。旧 Worker 可继续写 NULL，新 Worker 接受旧请求和旧 retry 文件。规范化后的新话单号码必须持久化，不能只用于费率查询。先执行 [FreeSWITCH 接入的费率前缀检查](freeswitch.md)，缩短旧 Lua 更新窗口，切换前回放旧 retry 文件并确认处理完成。

部署顺序如下：

1. 执行 `pnpm db:migrate`。
2. 升级全部 Worker，验证旧协议授权和旧话单重推。
3. 成组更新各 FreeSWITCH 的 Lua 与拨号计划。执行 SIPp 验证国内手机、固话、国际 `+` 与 `00`，并比较上游原始 INVITE、CDR、费率与账本。

回滚先恢复 FreeSWITCH。待新协议通话结束、新协议 retry 文件成功重推、相关扣费任务完成，再降级 Worker。保留可空列；无需回填、重算或反向迁移。先降级 Worker 会把新协议的原始拨号当成旧国际号码，导致拒绝或错误费率。

## 扣费对账与连接池

新增部署迁移 `0002_worker_reliability`，再运行 `queue:migrate` 安装对账队列。现有扣费队列策略不变，存量任务不删除。

`reconcile-cdr-charges` 每分钟调度（`* * * * *`，Asia/Shanghai），查找 `charge > 0` 且没有同租户 `call:<UUID>` 通话扣费流水的话单。未接通、合法零费率无需流水，不进入对账。以接收时间为宽限期，重试耗尽、任务丢失或被清理都能重新发现。

| 配置                               | 默认值 | 有效范围                                         |
| ---------------------------------- | ------ | ------------------------------------------------ |
| `WORKER_RECONCILE_MIN_AGE_MINUTES` | 5      | 整数 1–10080 分钟；接收/上次补投后至少等待此时长 |
| `WORKER_RECONCILE_ALERT_ATTEMPTS`  | 3      | 整数 1–1000；已补投这么多轮仍无流水时告警        |
| `WORKER_DB_POOL_MAX`               | 10     | 整数 1–100；HTTP、扣费、对账业务连接             |
| `WORKER_QUEUE_POOL_MAX`            | 2      | 整数 1–20；pg-boss 元数据与调度连接              |
| `WORKER_DB_CONNECTION_TIMEOUT_MS`  | 5000   | 整数 1–60000；两个池的连接获取超时               |

每个候选沿用已有租户锁，拿锁后重新检查流水、宽限期和未终结任务（包括升级前没有 singletonKey 的任务）。补投使用稳定 `singletonKey=callUuid` 和由 UUID/轮次生成的确定性任务 ID；真正的去重由任务主键、同一事务内更新的 `reconcile_attempts/reconciled_at` 及原有租户锁保证，标准队列的 singletonKey 本身不保证唯一。重复/并发对账不增加任务或次数。计费仍使用账本唯一键，不重复扣费。

次数保存在话单，不随 pg-boss 清理历史任务而丢失。达到告警阈值后仍继续补投；`reconcile_alerted` 与 `system_alerts(kind=cdr_failed)` 同事务提交，一通话只告警一次。无需人工发现队列的 failed 状态；管理员可按告警中的 UUID 查账并处理。任务处理失败保留异常和日志，不吞错。数据库/Worker 不可用时需恢复服务，对账才会继续；邮件通知属于阶段 9。

启动并发挂起的根因是 pg-boss `send()` 在使用传入事务插入任务之前，冷缓存的 `getQueueCache()` 会通过默认 adapter 另借连接。同一个默认 10 连接池被入库事务占满时，持连接的请求等待队列元数据查询，后者又等待这些请求归还连接。增加池大小或仅预热不能消除此依赖。现在 pg-boss 默认 adapter 使用独立应用角色池；任务 INSERT 仍使用入库事务的连接，保留话单/任务原子提交。两个池都设置有限 `connectionTimeoutMillis`，部署时按实例数为 PostgreSQL 预留两池总连接预算。连接获取失败会返回服务错误，CDR 保存失败按 503 重推；不存在无限等连接的默认配置。
