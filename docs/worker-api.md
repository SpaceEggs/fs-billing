# Worker 接口（阶段 3：a、b、c）

Worker 独立于 Web/API，默认监听 `127.0.0.1:3001`。生产环境设置内网 IPv4 地址。运行时只使用 `APP_DATABASE_URL`（`fs_billing_app`）；业务与队列写入经 `withSystem`，写入前调用 `lockTenants`，不新增业务锁。金额由阶段 1 的 decimal.js 计价函数计算，不舍入。

## 启动与配置

```sh
pnpm db:migrate
pnpm --filter @fs-billing/worker queue:migrate
pnpm --filter @fs-billing/worker start
```

`queue:migrate` 是部署操作，使用 `DATABASE_URL` 的 owner 安装 pg-boss schema、建 `charge-cdr` 队列并授权。可重复执行；运行时关闭自动迁移与建 schema。当前固定 pg-boss 12.37.1，升级版本时需要单独迁移队列 schema。

| 环境变量             | 要求                                               |
| -------------------- | -------------------------------------------------- |
| `APP_DATABASE_URL`   | PostgreSQL URL，用户必须为 `fs_billing_app`        |
| `WORKER_HOST`        | 默认 `127.0.0.1`，仅接受回环或 RFC1918 IPv4        |
| `WORKER_PORT`        | 默认 `3001`，整数 1–65535                          |
| `WORKER_SHARED_KEY`  | 至少 16 字符                                       |
| `WORKER_ALLOWED_IPS` | 逗号分隔的非空 IP 列表，例如 `127.0.0.1,10.0.0.10` |

`POST /authorize` 与 `POST /cdr` 必须带 `X-Billing-Key`，缺失或错误返回 401，来源 IP 不在白名单返回 403。使用连接的实际 IP，不信任代理头。`GET /health` 返回 `{"status":"ok","service":"worker"}`，不检查数据库。

## POST /authorize

`Content-Type: application/json`：

```json
{
  "tenant": "ABC001",
  "callee": "447700900123",
  "uuid": "7f1c2a9e-0d3b-4c5e-8a6f-1b2c3d4e5f60"
}
```

`tenant` 是非空字母数字编码，精确匹配（不补零、不改大小写）。`uuid` 必须为 UUID；授权不登记 UUID、不冻结余额、不产生扣费。`callee` 必须为非空 ASCII 数字且不能以 `00` 开头；拨号计划事先去掉 `+` 或 `00`。

放行返回 HTTP 200：

```json
{ "allowed": true, "maxSeconds": 14400 }
```

`maxSeconds` 是整数，按实时余额加透支额度、当前生效版本的最长前缀费率计算，单通最多 14400 秒。每次从 DB 加载，不缓存余额或费率。

业务拒绝返回 HTTP 200：

```json
{ "allowed": false, "reason": "余额不足", "sipCode": 402 }
```

| reason       | 建议 SIP code | HTTP |
| ------------ | ------------- | ---- |
| 号码格式错误 | 400           | 400  |
| 租户不存在   | 404           | 200  |
| 租户已停用   | 403           | 200  |
| 无费率       | 404           | 200  |
| 余额不足     | 402           | 200  |

号码字段缺失或类型错误同样返回 `号码格式错误`。其他无效请求（例如 UUID 错误）返回 HTTP 400 `{"error":"授权请求格式错误"}`。数据库不可用时返回服务错误；FreeSWITCH 的超时放行策略由后续拨号计划实现。

## POST /cdr

正文是直接的 mod_json_cdr JSON 文本，可使用 `application/json` 或 `text/plain`。不接受 `cdr=<urlencoded JSON>` 包装；FreeSWITCH 的直传配置在后续单元提供。真实字段布局见 [sample-cdr.json](../freeswitch/examples/sample-cdr.json)。`times` 位于 `callflow[]` 中，单位为微秒；业务解析以 `variables` 中的秒数为准。

| variables 字段                            | 解析与不变量                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `uuid`                                    | UUID，规范成小写；去重的唯一键                                                                                            |
| `billing_tenant`                          | 精确的租户编码，缺失按空标签处理                                                                                          |
| `start_epoch` / `end_epoch`               | 正整数 epoch 秒，支持数字字符串或整数                                                                                     |
| `answer_epoch`                            | 默认 0，0 表示未接通；接通时必须在开始与结束之间                                                                          |
| `billsec` / `duration`                    | 非负整数秒（最大 2147483647），支持数字字符串；duration 等于结束减开始，billsec 不超过接通后秒数；未接通 billsec 必须为 0 |
| `billing_unverified`                      | 布尔值或字符串 `true` / `false`，缺失为 false                                                                             |
| `caller_id_number` / `destination_number` | 主叫/被叫字符串；被叫格式单独校验，错误也保存为未归属话单                                                                 |
| `hangup_cause`                            | 挂断原因，缺失为空字符串                                                                                                  |

其他 mod_json_cdr 字段不参与业务解析，原文全部保留。输入形状和输出类型由 `packages/shared/src/worker.ts` 的 Zod schema 派生。

处理顺序：

1. 将收到的 UTF-8 文本原样写入 `raw_cdrs.body`，在独立系统事务里提交。每次推送一行，包括重复和损坏正文。保留空白、字段顺序与重复键；`payload` 是数据库生成的规范副本。先保存后解析，原文行的 `tenant_id`、`call_uuid` 保持 NULL；响应 `rawId` 可定位原文，UUID 可从 payload 查询。
2. JSON 或结构无效时返回 200 `invalid`，写 `cdr_failed` 告警。缺 UUID 或错误时间无法构造正式/未归属话单，保留原文供人工排查。
3. 解析成功后检查 `call_uuids`。已登记即返回 `duplicate`，不会将重推变成未归属话单的认领。入口设置事务级 `app.cdr_ingest=true`，登记触发器也禁止认领，因此并发插入同样只允许一条；只将 `23505` 且约束为 `call_uuids_pkey` 的冲突识别为重复，不使用话单 `ON CONFLICT DO NOTHING`。
4. 缺标签、未知租户（包括 `ABC01`）、错误被叫进入 `unassigned_cdrs(status=pending)` 并写 `cdr_failed`，HTTP 200，不入扣费队列。重复推送不重复告警。
5. 接通电话按接通时刻选版本与最长前缀，保存费率和计价快照。接通时无费率也进入 pending 并告警；不能按 0 元收费。未接通话单的时长和费用为 0。`billing_unverified` 保存为 `cdrs.unverified`，照常计费。
6. CDR 插入与 `charge-cdr` 入队在同一事务内提交。队列失败时两者和 UUID 登记全部回滚，原文保留，返回 503 供 FreeSWITCH 重推。

成功响应均为 HTTP 200：

```json
{ "status": "queued", "rawId": "a865a8ae-f220-4f21-b54c-40cb3aab26a8" }
```

`status` 为 `queued`、`duplicate`、`unassigned` 或 `invalid`。只有数据库/队列保存失败时返回 503 `{"error":"话单保存失败，请重推"}`；坏话单不返回 400。HTTP 层仍限制正文大小（Fastify 默认 1 MiB）；文本列不能保存非法 UTF-8 字节或实际 NUL 字符。

## 扣费队列边界与后续单元

`ChargeQueue.enqueue(tx, {tenantId, callUuid})` 只做数据库操作，使用 pg-boss `fromDrizzle(tx, sql)` 与话单共用事务。`chargeCdr(db, unknown)` 在任务边界校验形状，再读取已保存的计价快照，调用 `appendLedgerEntry`，幂等键为 `call:<UUID>`、`occurred_at=answered_at`。零费率或未接通不产生零元流水（数据库只接受负值通话扣费）。余额缓存由流水触发器更新。

当前提供最小处理器并在启动后消费扣费任务。DB 测试从真实 pg-boss 队列 fetch，重复运行同一 handler，断言账本和余额。完整的崩溃恢复、失败任务维护和每日分区调度属于后续单元。当前关闭 pg-boss `supervise`、`schedule`，避免应用角色触发它的建队列/维护 advisory 锁；不放开阶段 2 对 advisory 锁的限制。

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
