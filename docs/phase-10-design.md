# 阶段 10 设计：部署与上线

## 范围与依据

本文档写于 2026-10-30，只是设计：没有实现代码、没有迁移、没有 `ops/` 目录、没有连接任何服务器，也不表示阶段 10 已验收。范围取自 [plan.md 阶段 10](plan.md#阶段-10部署与上线)（`docs/plan.md:354-381`）：服务器原生部署、防火墙、每日备份与恢复脚本、SIPp 压测与故障演练、上线检查清单与运维手册，共 14 条验收标准。业务与架构依据 [design.md §3、§4.4、§14](design.md)（`docs/design.md:77-93`、`:424`），FreeSWITCH 侧见 [freeswitch.md](freeswitch.md) 与 [freeswitch/README.md](../freeswitch/README.md)，Worker 契约见 [worker-api.md](worker-api.md)。结构和写法沿用 [phase-9-design.md](phase-9-design.md)。

**用户 2026-10-30 已确定的输入**（设计阶段提出的 11 个待定问题也已全部回答，见[已决定](#已决定)）：

- **服务器 B：** 一台全新的 Debian 13 生产服务器（地址待用户提供）。原生部署，不用 Docker；API、Worker 用 systemd；nginx 托管 Web 静态文件并代理 `/api`；PostgreSQL 用 Debian 官方 `postgresql-17`。现有测试服务器（10.0.0.60）的做法只作现状参考，生产是否沿用见[沿用还是改](#测试服务器的做法沿用还是改)。
- **域名：** 暂无。先用自签证书；运维手册写好 certbot（HTTP-01、nginx 插件、自动续期）步骤，域名到位后执行。
- **备份：** 暂时只存本机 `/root/backups`（`pg_dump -Fc` 加 `/var/lib/fs-billing/archive`，每日，保留 30 天），异地目标以后再加（用户决定 9：带条件上线，只接入试用客户，首个付费客户之前必须有异地备份）。**这与 design.md 的备份要求（存放在另一台机器或对象存储，`design.md:424`）有已知差距**，见[备份与恢复](#3-备份与恢复验收-3)。脚本设计成以后加异地目标只需配置。
- **服务器 A（FreeSWITCH 测试机）：** 暂无。SIPp 压测（50 并发、每秒 10 通、30 分钟）与故障演练（压测中重启 API 和 Web、停 Worker 1 分钟）的场景与脚本现在准备，机器到位后执行。

**阶段 10 的验收分三类**（逐条归类见[验收标准对应交付与证据](#验收标准对应交付与证据)）：

| 类别                       | 条数 | 含义                                                                                            |
| -------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| 现在就能做完               | 4    | 只需要仓库、GitHub 和开发机：大分区索引手册、0004 guard 验证、迁移与锁时长演练、CI 不得静默跳过 |
| 现在写好，服务器到位后执行 | 8    | 脚本与手册先写并做静态检查，在服务器 B、服务器 A 或 SIPp 主机上实跑                             |
| 必须等外部条件             | 2    | 实呼（要 A、真实上游线路与终端）、NTP 偏差告警演示（要 A）                                      |

另有若干条**不在 14 条验收里、但分散在前面各阶段文档里写明「随阶段 10」的带入项**（导出在 nginx 后重测、归档目录进备份与磁盘告警、`queue:migrate` 重跑、外部存活监测（用户决定暂不做）、SMTP 部署配置等），逐项收在[带入项](#带入项)。

## 现状核对

### 仓库里已经有什么

| 事实                                                                                                                                                                                                                                                                                                    | 出处                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 仓库没有 `deploy/`、`ops/`、systemd 单元、nginx 配置、nftables 规则、备份或恢复脚本、运维手册。部署只在测试服务器上以人工加备忘录的形式存在                                                                                                                                                             | 仓库根目录；测试服务器做法见用户记忆 `test-server-deploy`                                                               |
| Node 要求 `>=24.22.1 <25`，`engine-strict=true`，pnpm 10.34.7。Debian 13 官方源里的 Node 不是 24                                                                                                                                                                                                        | `package.json`、`.node-version`、`.npmrc`                                                                               |
| API 与 Worker 的 `start` 脚本直接运行 TS 源码（`node --import tsx` / `tsx`），`tsx` 是 devDependency；各包 `exports` 指向 `./src/index.ts`，所以 `tsc` 的 `dist` 不能脱离源码单独运行。`development.md` 写着「生产打包在阶段 10 完成」                                                                  | `apps/api/package.json`、`apps/worker/package.json`、`packages/db/package.json`、`docs/development.md:101`              |
| 迁移是 `packages/db/migrations/0000`–`0024`，由 drizzle migrator 在**事务内**逐个执行，每个文件开头 `SET LOCAL lock_timeout = '5s'`；`pnpm db:migrate` 随后设置应用角色密码并建当月与下月分区。`queue:migrate` 另外安装 pg-boss 并建队列，**新增队列后必须重跑**                                        | `packages/db/src/migrate.ts`、`packages/db/src/bin/migrate.ts`、`docs/worker-api.md:5-12`、`docs/phase-7-design.md:240` |
| `0010` 是普通 `CREATE INDEX cdrs_tenant_started_at`，注释写明只适用于上线前的空库，上线后必须用 `CREATE INDEX CONCURRENTLY` 的运维手册                                                                                                                                                                  | `packages/db/migrations/0010_cdrs_tenant_started_at.sql:1-6`                                                            |
| `0004` 开头有 guard：存量 `cdrs` / `unassigned_cdrs` 有不合法的 `billing_number` 就 `RAISE EXCEPTION`，其后是 `SET NOT NULL`、加约束、`VALIDATE`，整个迁移在一个事务里                                                                                                                                  | `packages/db/migrations/0004_billing_number_not_null.sql`                                                               |
| `cdrs` 与 `raw_cdrs` 按北京月分区，分区只在维护路径创建；`ensure_month_partition` 带 `lock_timeout = '2s'`                                                                                                                                                                                              | `packages/db/migrations/0000_init.sql:534`、`0019_raw_cdr_archives.sql`                                                 |
| 触及 `cdrs` 的迁移：`0002`（加列带默认值）、`0003`（加列、约束、`VALIDATE`）、`0004`（`SET NOT NULL`、`VALIDATE`）、`0010`（建索引）、`0016`（加列、约束、`VALIDATE`）。首次上线时这些都在**空表**上跑，几乎瞬间；它们的价值是作为演练方法的现成样本                                                    | `packages/db/migrations/*.sql`                                                                                          |
| Worker 在 `WORKER_HOST` 上监听，只接受回环或 RFC1918 IPv4；`/authorize`、`/cdr` 要求来源 IP 在 `WORKER_ALLOWED_IPS` 且带 `X-Billing-Key`，**`/health` 在这个守卫之外，谁连得上谁就能访问**                                                                                                              | `apps/worker/src/config.ts`、`apps/worker/src/app.ts:47-60`                                                             |
| FreeSWITCH 侧：授权走 Lua，话单经服务器 A 上的 nginx relay（`127.0.0.1:3002/cdr`）加密钥后转发给 Worker；失败落盘 `/var/lib/freeswitch/cdr/retry/`，由 `replay-cdr.sh` 每分钟补推；归档副本留在 `archive/`                                                                                              | `freeswitch/README.md`、`freeswitch/nginx/billing-cdr.conf`、`freeswitch/scripts/replay-cdr.sh`                         |
| 仓库里已有 SIPp 场景（放行后客户挂机、定时挂断、拒绝）和一个模拟上游的 `carrier.xml`，以及 Docker 版 FreeSWITCH 联调脚本 `run-integration.sh`（两次 15/15 PASS）                                                                                                                                        | `freeswitch/test/sipp/*.xml`、`freeswitch/test/run-integration.sh`、`docs/evidence/reject-billing-mismatch/README.md`   |
| `freeswitch.yml` 的 `e2e` 作业在镜像拉不到时只打 `::notice::` 然后把后续步骤全部跳过，作业仍是绿色；`image` 作业在 `SIGNALWIRE_TOKEN` 为空时同样跳过                                                                                                                                                    | `.github/workflows/freeswitch.yml:44、80-108`                                                                           |
| `system_alerts.kind` 由 CHECK 约束限定，现有 7 种（`auth_timeout`、`cdr_failed`、`email_failed`、`partition_failed`、`statement_mismatch`、`audit_failed`、`raw_archive_failed`），没有时钟或存活相关的种类；新增种类需要迁移和后台页面的标签                                                           | `packages/db/migrations/0018_cdr_operations.sql:205-209`、`docs/phase-9-design.md`（告警模型）                          |
| 日志约定：Worker/API 日志只写标准输出，号码类字段已掩码；14 天保留、仅 root 与运维组可读、不转发，被明确记为阶段 10 的**部署项**                                                                                                                                                                        | `docs/development.md:61-69`、`docs/plan.md:350`                                                                         |
| 备份相关约定：每日、保留 30 天、另一台机器或对象存储、每季度演练（`design.md`）；归档目录是原始 JSON 丢弃后的**唯一副本**，必须进备份并设磁盘告警；归档文件是 gzip 成员首尾相接的 JSON Lines，`raw:restore-month` 可整月恢复                                                                            | `docs/design.md:424`、`docs/phase-8-design.md:350、677、668`                                                            |
| 测试服务器：源码拷贝在 `/opt/fs-billing`，`node --import tsx src/main.ts`，`EnvironmentFile=/etc/fs-billing.env` 加 `--env-file=/opt/fs-billing/.env`（两个文件键相同，**含 owner `DATABASE_URL`**），nginx + 自签证书，Worker 监听 `127.0.0.1:3001`，`RAW_CDR_ARCHIVE_DIR=/var/lib/fs-billing/archive` | 用户记忆 `test-server-deploy`（未在本步复核服务器）                                                                     |

### 本步发现的缺口

这些不在 plan 的 14 条里，但不处理就上不了线，分别落在后面的 PR 中。

| #   | 缺口                                                                                                                                                                                                                                                               | 后果                                                                                                                                 | 处理                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| G1  | API 的 Fastify 是 `trustProxy: false`（`apps/api/src/app.ts:101`），登录/改密码限流按 `request.ip`（每 IP 每分钟 30 次，共享一个 store）。API 放在 nginx 后面时，所有请求的来源都是 `127.0.0.1`                                                                    | 全站的登录共用一个 30 次/分钟的桶：几个人同时登录就互相锁；攻击者一个 IP 就能让所有人登不上。API 日志的 `remoteAddress` 也永远是回环 | PR 2：只信任回环代理（`trustProxy: '127.0.0.1'`），nginx 用 `$remote_addr` **覆盖** `X-Forwarded-For`；补一个伪造头不能换桶的测试 |
| G2  | `pnpm db:seed` 没有生产保护（`packages/db/src/bin/seed.ts` 直接用 owner 连接写演示租户、充值和告警）。`auth:seed` 只拒绝 `production` 的 `NODE_ENV`，而 owner 命令行并不一定设了它                                                                                 | 在生产库误跑一次就多出演示租户和余额，账本是只增不改的，清不掉                                                                       | PR 2：拒绝非空库或要求显式开关；运维手册不出现 `db:seed`                                                                          |
| G3  | 没有创建**第一个管理员**的路径。管理员只能由已有管理员在后台创建；`auth:bootstrap` 要求资料已存在；种子里的管理员是演示账号                                                                                                                                        | 全新生产库无法登录                                                                                                                   | PR 2：owner 脚本 `admin:create`（建 `auth.user` 与 `admins`，生成临时密码、首登强制改密、写操作日志），不经 API 暴露              |
| G4  | 测试服务器的服务进程环境里有 owner `DATABASE_URL`                                                                                                                                                                                                                  | API/Worker 被攻破即拿到 owner（可绕过 RLS、改账本触发器）。这与「网站被攻破也无法……」的隔离思路相反                                  | 生产拆成两个环境文件，见下表；PR 1                                                                                                |
| G5  | nginx 默认访问日志记录完整请求行，含查询串：话单搜索的 `callee`、导出参数里是客户号码。阶段 9 只给 Worker/API 的日志做了掩码；nginx `access.log`/`error.log`（错误日志含完整请求行）在 `/var/log/nginx`，Debian 默认 logrotate 保留 14 份，权限 `640 www-data:adm` | 号码以明文留在 nginx 日志，保留期与「14 天」约定可能不一致                                                                           | **用户接受的已知风险（决定 6）：保持 Debian 默认，不改保留期，不去查询串。** 记入上线检查清单与手册「日志与隐私」                 |
| G6  | Debian 的 `postgresql-17` 日志在 `/var/log/postgresql/`，logrotate 默认保留 10 周；开启慢查询日志时，绑定参数（含号码）会写进日志                                                                                                                                  | 同上：号码明文、保留期长于 14 天                                                                                                     | **用户接受的已知风险（决定 6）：保持 Debian 默认。** 不开启慢查询日志，则参数不会进日志；该选项是否开启在手册中注明               |
| G7  | `MaxRetentionSec=14day` 只删除「最新条目已超过 14 天」的整个 journal 文件，而活动文件默认一个月才轮换（`MaxFileSec` 默认 1 个月），所以单靠 `MaxRetentionSec`，日志实际可能留到约 6 周                                                                             | plan 写的配置达不到「保留 14 天」                                                                                                    | PR 1：加 `MaxFileSec=1day`；验收 14 的核对步骤包含检查最老条目                                                                    |
| G8  | `docs/development.md:101` 说「生产打包在阶段 10 完成」，但 workspace 包以 TS 源码导出，不能 `tsc` 后直接 `node dist`                                                                                                                                               | 文档与实际做法不一致                                                                                                                 | 建议生产沿用 `tsx` 运行源码（见下表），PR 9 更正这句话                                                                            |
| G9  | Worker `/health` 不鉴权，Worker 端口的唯一保护是防火墙（加应用层白名单只覆盖两个业务接口）                                                                                                                                                                         | 防火墙规则写错就直接暴露 Worker                                                                                                      | 验收 2 同时从外部验证 `/health` 与 `/authorize`；规则里不留「默认放行」                                                           |
| G10 | 授权码与共享密钥、`BETTER_AUTH_SECRET` 之类的秘密没有轮换或备份约定                                                                                                                                                                                                | 备份里不含 `/etc/fs-billing*`，换服务器要重新生成；密钥泄露无处理步骤                                                                | 运维手册写轮换步骤；配置备份见[备份与恢复](#3-备份与恢复验收-3)                                                                   |

### 测试服务器的做法：沿用还是改

| 项          | 测试服务器                                   | 生产建议                                                                                                                                                                                          | 理由                                                                                                                     |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 代码形态    | 源码拷贝，`tsx` 运行                         | **沿用**。在服务器上 `pnpm install --frozen-lockfile`，Web 在服务器上 `vite build`；暂不引入打包                                                                                                  | workspace 包以 TS 导出，打包要改构建链；测试服务器已按这个跑过 9 个阶段；风险在启动略慢和 `devDependencies` 留在服务器上 |
| 目录布局    | `/opt/fs-billing` 整个替换，留 `.previous-*` | **改**为 `/opt/fs-billing/releases/<sha>` 加 `current` 符号链接，保留最近 3 个                                                                                                                    | 回滚 = 改链接加重启；部署中途失败不留下半个目录；`DEPLOYED_COMMIT` 随目录                                                |
| 运行用户    | `fs-billing`                                 | **沿用**，`nologin`，`/var/lib/fs-billing` 属主，模式 0700；单元加 `NoNewPrivileges`、`ProtectSystem=strict`、`ReadWritePaths=/var/lib/fs-billing`、`PrivateTmp`、`ProtectHome`                   | 低成本收紧                                                                                                               |
| 环境文件    | 两份同键文件，含 owner URL                   | **改**：`/etc/fs-billing/app.env`（服务用，无 owner URL，`root:fs-billing 640`）与 `/etc/fs-billing/owner.env`（迁移、`queue:migrate`、`auth:bootstrap` 用，`root:root 600`，运维用包装脚本加载） | 消除 G4。键值保持纯 `KEY=value`，不含空格与引号，使 systemd 与 Node 的解析一致                                           |
| Node        | 测试服务器手工升级到 24.22.1                 | 官方 tarball（校验 SHA256）解到 `/opt/node-v24.22.1`，`/usr/local/bin` 放链接；版本取 `.node-version`；单元里写绝对路径                                                                           | Debian 13 源里没有 Node 24；不引入第三方 apt 源                                                                          |
| 证书        | 自签，`server_name` 为 IP                    | **沿用到域名到位**：自签证书带 IP 的 SAN；`BETTER_AUTH_URL=https://<IP>`（生产要求 HTTPS，`apps/api/src/config.ts` 校验）。域名到位后走 certbot，见[证书](#部署基础支撑验收-1214)                 | 用户已定                                                                                                                 |
| Worker 监听 | `127.0.0.1:3001`                             | **改**：监听 B 的内网 IPv4（服务器 A 要连），`WORKER_ALLOWED_IPS` 只放服务器 A 的内网 IP。B 没有内网地址时在 A 与 B 之间建 WireGuard，Worker 监听隧道地址（决定 1），Worker 不监听公网            | 测试服务器上 A 不存在，回环足够；生产 A 跨机                                                                             |
| PostgreSQL  | Debian 包，本机                              | **沿用**；`listen_addresses = 'localhost'`，`timezone = 'UTC'`（与 CI 的 compose 一致）                                                                                                           | 数据库不暴露                                                                                                             |
| 种子        | 曾播种                                       | **不播种**（G2）                                                                                                                                                                                  | 账本只增不改                                                                                                             |

## 交付物布局

仓库根新增 `ops/`，运维手册和检查清单放 `docs/`。能用 TypeScript 写的校验脚本放进已被 ESLint 与 `tsc` 覆盖的包（`packages/db/scripts/`、`apps/worker/scripts/`），不放进 `ops/`，避免新建一块没有类型检查的代码。

```
ops/
├── deploy/        bootstrap-server.sh  install-node.sh  deploy.sh  rollback.sh  stopwatch.sh
│   ├── systemd/   fs-billing-api.service  fs-billing-worker.service
│   ├── nginx/     fs-billing.conf
│   ├── postgres/  fs-billing.conf（conf.d 片段）
│   ├── sshd/      fs-billing.conf（sshd_config.d 片段：仅密钥登录）
│   └── env/       app.env.example  owner.env.example
├── firewall/      nftables-b.conf  nftables-a.conf  verify-ports.sh
├── journald/      fs-billing.conf
├── backup/        backup.sh  restore.sh  verify-restore.sh  snapshot-counts.sh  backup.conf.example
│   ├── systemd/   fs-billing-backup.{service,timer}  fs-billing-backup-verify.{service,timer}
│   └── offsite/   README.md（驱动约定）
├── monitor/       check-clock.sh  health-check.sh  notify.sh  fs-clock-heartbeat.sh（部署到 A）
│   └── systemd/   对应的 .service/.timer
├── migrate/       rehearse.sh  concurrent-index.sh
├── loadtest/      uac-load.xml  uas-carrier.xml  destinations.csv  run-load.sh  drill.sh  sample-resources.sh
└── checks/        billing-tenant.sh  require-fs-e2e.sh
docs/
├── ops-runbook.md          运维手册（重启、回滚、恢复、证书、告警查看、轮换）
├── go-live-checklist.md    上线检查清单
└── evidence/phase-10/      每条验收一个子目录
packages/db/scripts/        verify-load.ts（压测核对）  rehearse-timing.ts（若采用）
```

CI 新增 `ops-check` 作业（不需要服务器）：`shellcheck ops/**/*.sh`、`systemd-analyze verify`、`nft -c -f`、`nginx -t`（临时目录加载）、备份/恢复脚本对 compose 里的 PostgreSQL 做一次往返。

### 生产环境变量清单（只列名字，不写值）

取自 `apps/api/src/config.ts`、`apps/worker/src/config.ts`、`packages/db/src/client.ts` 与 `.env.example`。「必填」指缺失即启动失败。

**`/etc/fs-billing/app.env`（API 与 Worker 共用，服务进程读取）**

| 变量                                                                                                                                                                               | 进程   | 必填     | 说明                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                                                                                                                         | API    | 是       | 设为 `production`：会话 cookie 加 `Secure`，且 `BETTER_AUTH_URL` 必须是 `https`                                             |
| `APP_DATABASE_URL`                                                                                                                                                                 | 两者   | 是       | 用户必须是 `fs_billing_app`                                                                                                 |
| `AUTH_DATABASE_URL`                                                                                                                                                                | API    | 是       | 用户必须是 `fs_billing_auth`                                                                                                |
| `BETTER_AUTH_SECRET`                                                                                                                                                               | API    | 是       | 至少 32 字符                                                                                                                |
| `BETTER_AUTH_URL`                                                                                                                                                                  | API    | 是       | 站点的 HTTPS 地址                                                                                                           |
| `BETTER_AUTH_TRUSTED_ORIGINS`                                                                                                                                                      | API    | 否       | 逗号分隔的 Origin，缺省取 `BETTER_AUTH_URL` 的 origin；与 Web 实际访问地址一致                                              |
| `API_HOST`、`API_PORT`                                                                                                                                                             | API    | 否       | 默认 `127.0.0.1`、`3000`；保持回环，只让 nginx 访问                                                                         |
| `ADMIN_AMOUNT_MAX_INTEGER_DIGITS`、`ADMIN_RATE_SCHEDULE_HORIZON_MS`、`ADMIN_RATE_PREVIEW_TTL_MS`、`ADMIN_RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS`、`ADMIN_TEMPORARY_PASSWORD_TTL_MS` | API    | 否       | 业务参数，缺省值见 `packages/shared`；生产不改则不写                                                                        |
| `WORKER_HOST`、`WORKER_PORT`                                                                                                                                                       | Worker | 否       | 默认 `127.0.0.1`、`3001`；生产设为 B 的内网 IPv4（只接受回环或 RFC1918）                                                    |
| `WORKER_SHARED_KEY`                                                                                                                                                                | Worker | 是       | 至少 16 字符；与服务器 A 的 `billing_shared_key` 及 relay 配置一致                                                          |
| `WORKER_ALLOWED_IPS`                                                                                                                                                               | Worker | 是       | 逗号分隔，只放服务器 A 的来源 IP                                                                                            |
| `WORKER_DB_POOL_MAX`、`WORKER_QUEUE_POOL_MAX`、`WORKER_DB_CONNECTION_TIMEOUT_MS`                                                                                                   | Worker | 否       | 10、2、5000                                                                                                                 |
| `WORKER_RECONCILE_MIN_AGE_MINUTES`、`WORKER_RECONCILE_ALERT_ATTEMPTS`、`WORKER_RECONCILE_LOOKBACK_DAYS`、`WORKER_STATEMENT_CONCURRENCY`                                            | Worker | 否       | 5、3、30、2                                                                                                                 |
| `RAW_CDR_ARCHIVE_DIR`                                                                                                                                                              | Worker | 生产必设 | 不设则不归档、`raw_cdrs` 无限增长；绝对路径，`/var/lib/fs-billing/archive`                                                  |
| `RAW_CDR_ARCHIVE_AFTER_MONTHS`、`RAW_CDR_ARCHIVE_GRACE_DAYS`                                                                                                                       | Worker | 否       | 6、7                                                                                                                        |
| `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS`、`MAIL_FROM`                                                                                                     | Worker | 否       | 设了 `SMTP_HOST` 就要有 `MAIL_FROM`；QQ 邮箱 465 + `SMTP_SECURE=true`，`MAIL_FROM` 等于 `SMTP_USER`；`SMTP_PASS` 只放服务器 |
| `SMTP_TIMEOUT_MS`、`MAIL_RATE_PER_MINUTE`、`MAIL_MAX_ATTEMPTS`、`ALERT_QUIET_MINUTES`                                                                                              | Worker | 否       | 15000、20、6、10                                                                                                            |
| `APP_PUBLIC_URL`                                                                                                                                                                   | Worker | 否       | 邮件里链接的站点根，`https://…`；不设则邮件没有链接。API 只读 `SMTP_HOST` 与 `MAIL_FROM` 来显示「邮件发送未配置」           |

**不要在生产设置：** `AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX`、`FSB_ALLOW_TEST_OVERRIDES`（仅测试）、`SEED_AUTH_PASSWORD`（仅开发种子）、所有 `PERF_*`、`P4_IDOR_*`。

**`/etc/fs-billing/owner.env`（仅 root 与运维命令读取）：** `DATABASE_URL`（owner `fs_billing`，迁移、`queue:migrate`、`auth:bootstrap`、`auth:unlock`、备份用）、`APP_DATABASE_URL` 与 `AUTH_DATABASE_URL`（`db:migrate` 据此设置两个角色的登录密码，所以与服务用的必须一致）、`BETTER_AUTH_SECRET` 与 `BETTER_AUTH_URL`（`auth:bootstrap` 需要）。

**服务器 A 侧（不在 B 上）：** `billing_worker_url`、`billing_shared_key`（`vars.xml` 全局变量），relay 配置里的 Worker 地址与密钥。

## 各验收项的方案

下面按 plan 的顺序之外的**依赖顺序**写：先是其他项都依赖的部署基础，再是 14 条验收。每条列出：怎么做、交付什么、怎么证明、现在能做还是要等。

### 部署基础（支撑验收 1、2、14）

**服务器布局。**

| 项           | 约定                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| apt 包       | `postgresql-17`、`nginx`、`nftables`、`chrony`、`certbot`、`python3-certbot-nginx`、`curl`、`ca-certificates`、`jq`、`unzip`/`tar`、`build-essential`（原生依赖编译兜底）                                                                                                                                                                                                                                                               |
| 用户与目录   | `fs-billing`（nologin）；`/opt/fs-billing/releases/<sha>`、`current`；`/var/lib/fs-billing/archive`（0700）；`/etc/fs-billing/{app,owner}.env`；`/root/backups`（0700）                                                                                                                                                                                                                                                                 |
| 数据库角色   | owner `fs_billing`；`fs_billing_app`、`fs_billing_auth` 带登录；`fs_billing_identity`、`fs_billing_audit` 为 NOLOGIN，由迁移创建（`0005`、`0014`）。密码由 `db:migrate` 按 URL 设置，用 `openssl rand -hex 24` 生成并只写进两个 env 文件                                                                                                                                                                                                |
| systemd 单元 | `fs-billing-api`、`fs-billing-worker`：`User=fs-billing`、`Restart=always`、`RestartSec=3`、`StartLimitBurst` 放宽、`After=postgresql.service`、`EnvironmentFile=/etc/fs-billing/app.env`、`ExecStart=/usr/local/bin/node --import tsx src/main.ts`（Worker 现用 `tsx src/main.ts`，统一成同一写法需在 PR 1 验证）、`TimeoutStopSec=30`。Worker 退出码非零即重启                                                                        |
| nginx        | 80 跳转 443；443 静态托管 `current/apps/web/dist`，`try_files $uri /index.html`，`assets/` 长缓存、`index.html` 不缓存；`location /api/` 代理 `127.0.0.1:3000`，`X-Forwarded-For $remote_addr`（覆盖不追加）；`client_max_body_size 3m`（CSV 导入上限 2 MiB）；**导出相关路径** `proxy_buffering off`、`proxy_read_timeout 330s`（API 总时限约 300 秒）；安全响应头；日志格式与 logrotate 保持 Debian 默认（决定 6）                    |
| 证书         | 见下节                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 部署步骤     | 本机 `git ls-files` 打包（排除 `design/`、`.claude/`、`docs/evidence/`）→ `scp` → 服务器解到 `releases/<sha>` → `pnpm install --frozen-lockfile` → Web 构建 → **以 owner 身份** `db:migrate`、`queue:migrate` → 切 `current` → 重启两个服务 → 健康检查（`/api/health`、Worker `/health`）→ 写 `DEPLOYED_COMMIT`。**不运行任何 `*:seed`**。失败时 `rollback.sh` 切回上一个目录并重启（迁移不回滚，所以迁移要向后兼容一个版本，写进手册） |

**证书。**

- 现在：`bootstrap-server.sh` 生成自签证书（`openssl req -x509`，SAN 为 B 的 IP，有效期 1 年），nginx 引用 `/etc/ssl/fs-billing/`。浏览器会对所有访问者警告；用户决定（决定 4）此阶段客户也可以使用门户，所以证书指纹写进手册供客户核对，该事项登记在上线检查清单的「带条件上线」栏。
- 域名到位后（手册一章，逐条命令）：确认 A 记录指向 B、80/443 对公网开放 → `certbot --nginx -d <域名>`（HTTP-01，插件改 nginx）→ `systemctl list-timers` 确认 `certbot.timer` → `certbot renew --dry-run` → 续期钩子 `systemctl reload nginx`。随后改 `BETTER_AUTH_URL`、`BETTER_AUTH_TRUSTED_ORIGINS`、`APP_PUBLIC_URL`（均为 `https://<域名>`）并重启两个服务；**所有用户的会话因 cookie 域变化而失效，需要重新登录**。证书正常后再开 HSTS。
- 证据：续期的 `--dry-run` 输出与 `certbot certificates` 存 `docs/evidence/phase-10/certbot/`。这一块要等域名，不在 14 条里。

### 1. 从零部署（验收 1）

**怎么做。** 在服务器 B（全新 Debian 13）上，按 `docs/ops-runbook.md` 的「新服务器部署」一章逐步操作，直到：管理员能登录后台、`/api/health` 与 Worker `/health` 正常、一通 SIPp 或 `curl` 模拟的授权加话单推送入账。

**用时记录。** `ops/deploy/stopwatch.sh mark <步骤名>` 往 `/var/log/fs-billing-deploy-time.tsv` 追加「步骤、起止时间」。起点是「root 能 SSH 登录一台刚装好的 Debian 13」，终点是上面的冒烟通过。脚本跑的时间与人工等待/输入的时间分开记；每个偏离手册的地方记入 `deviations.md`，随后改手册。执行的人最好只看手册、不看本设计。

**交付：** `ops/deploy/*`、`docs/ops-runbook.md`「新服务器部署」、`docs/go-live-checklist.md`。
**证据：** `docs/evidence/phase-10/fresh-deploy/{timing.tsv,deviations.md,health.txt}`。
**现在能做吗：** 脚本与手册现在写，静态检查进 CI；**实跑要等服务器 B**（B 是全新机器，正适合做这次演练）。

### 2. 防火墙（验收 2）

**怎么做。** `ops/firewall/nftables-b.conf` 用 `table inet filter`，`input` 链默认丢弃：放行回环、`established,related`、必要的 ICMP/ICMPv6、`tcp dport {80,443}`（公网）、`tcp dport 22`（任意来源，但按来源地址限制新建连接速率，超出即丢弃，具体速率在 PR 1 选定；决定 5）、`ip saddr $FS_A_IP tcp dport 3001`（Worker）。PostgreSQL 不监听外部，不开。`output` 保持放行（SMTP 465、certbot、NTP、apt 需要出站）。变量 `FS_A_IP` 在文件顶部 `define`。SSH 只允许密钥登录（`ops/deploy/sshd/fs-billing.conf`：`PasswordAuthentication no`、`KbdInteractiveAuthentication no`、`PermitRootLogin prohibit-password`），与速率限制一起构成对任意来源开放 22 端口的防护。`nftables-a.conf`（服务器 A）按 [freeswitch.md §5](freeswitch.md#5-网络与安全) 只开 SIP 5060/5061、RTP 范围、SSH，出站只允许到 B 的 Worker 端口。`nft -c -f` 进 CI。

**应用层纵深。** Worker 自己的 `WORKER_ALLOWED_IPS` 白名单已存在，但 `/health` 不鉴权（G9），所以**防火墙是唯一的屏障**，验收要同时验 `/health` 和 `/authorize`。

**验证脚本。** `verify-ports.sh <B 地址>`：从外部主机对 3001、5432、3000 各做带超时的 `curl`/`nc`，期望超时或拒绝；从服务器 A 对 3001 做 `curl /health` 与带密钥的授权探测，期望 200。

**交付：** `ops/firewall/*`。
**证据：** `docs/evidence/phase-10/firewall/{nft-ruleset.txt,external-probe.txt,from-fs-a.txt}`。
**现在能做吗：** 规则与脚本现在写；外部探测要等 B；**从 A 访问成功要等 A**。过渡办法：把另一台内网机器的 IP 临时加入 `FS_A_IP` 做一次，证据里标注「用替身，A 到位后复验」，这条验收在 A 复验之前**不勾选**。

### 3. 备份与恢复（验收 3）

**范围和已知差距。** design.md 要求「备份存放在另一台机器或对象存储」，用户暂时只存本机（`/root/backups`），所以：

- **同一台机器上的备份防不了整机丢失**（磁盘损坏、被入侵、误删整个系统）。它能防的是误删数据、坏迁移、应用层事故。
- 这是一条**已知差距**，写进 plan 阶段 10 的验收注释和上线检查清单的「带条件上线」栏，不能当作已满足。用户决定（决定 9）：带条件上线，只接入试用客户，**首个付费客户之前必须有异地备份**；过渡期每周手工把最近一套备份（库、globals、归档目录、配置包）拉到用户自己的机器，拉取步骤与校验和核对写进手册「备份」章。
- 脚本把「异地」做成可插拔：`backup.conf` 里 `OFFSITE_COMMAND=` 为空则跳过；以后配成 `rsync`、`rclone copyto` 等命令即可，脚本对每个产物调用一次并记录结果，失败使整次备份退出非零。不需要改脚本。

**备份内容与顺序。** 先库、后归档目录：

1. 数据库：`pg_dump -Fc fs_billing`（整库，含 `pgboss` schema 与 `auth` schema）→ `fs_billing-<UTC 时间>.dump`；先写 `.partial`，`pg_restore --list` 通过再改名。
2. 角色：`pg_dumpall --globals-only` → `globals-<时间>.sql`（含密码哈希，权限 600）。`pg_dump -Fc` 不含角色，而 RLS 策略、授权、`SECURITY DEFINER` 函数的属主（`fs_billing_identity`）依赖这些角色，没有它恢复到新机器会失败。
3. 归档目录：`/var/lib/fs-billing/archive` 打 tar。**放在库之后**：库里的清单引用的文件在打库时都已存在，且归档文件只增不删，所以晚拍的目录是早拍的库的超集；反过来则可能出现清单有而文件没有。
4. 配置：`/etc/fs-billing/*`、nginx 站点配置、证书私钥打成一个 600 的 tar（含秘密，**异地时必须加密**，加密要求写进 `offsite/README.md`）。

每个产物写 `sha256`；最后写 `LATEST.json`（时间、大小、校验和、`pg_restore --list` 的条目数）。**磁盘不足先失败**：剩余空间小于上次库备份的 2 倍就退出非零。**保留策略**按文件名里的时间戳（不信 mtime）删除 30 天前的整套备份，且无论如何至少保留最近 3 套，避免时钟错误一次删光。

**时间。** `fs-billing-backup.timer`，每天北京时间 05:00（避开零点分区维护、02:00 账单、03:00 核对、04:00 归档）。失败由 `OnFailure=` 触发 `notify.sh` 发邮件；另外 `health-check.sh` 检查 `LATEST.json` 超过 26 小时未更新也告警。

**恢复脚本。** `restore.sh`：

- `--verify`：恢复到临时库 `fs_billing_verify`，跑 `snapshot-counts.sh` 与账本不变量检查后删除临时库，**不碰生产库**。每周由 `fs-billing-backup-verify.timer` 自动执行一次并告警失败，这把 design.md 的「每季度恢复演练」变成持续证明；季度演练仍要人工做一次完整的删库恢复。
- `--restore`：交互确认，必须带 `--i-know-this-drops-the-database`。步骤：停 API 与 Worker → 把现库改名为 `fs_billing_pre_restore_<时间>`（不是删除）→ 导入 globals（已存在的角色跳过）→ `pg_restore --create` 或 `createdb -O fs_billing` 后 `pg_restore` → 重设两个登录角色的密码（`db:migrate` 会做，且是幂等的）→ `queue:migrate` → 启动服务 → 健康检查。归档目录从 tar 解回。
- **恢复后的缺口：** 备份时刻到事故时刻之间的话单不在库里。服务器 A 的 `/var/lib/freeswitch/cdr/archive/` 保留了推送过的话单副本；把备份时刻之后的文件拷进 `retry/`，`replay-cdr.sh` 补推，Worker 按通话 UUID 去重，已存在的不会重复扣费。这一步写进手册，演练里用一次。RPO 因此是「24 小时，且在服务器 A 的副本还在时可补回」（用户决定 10：每日一次，RPO 24 小时；服务器 A 的 `cdr/archive` 保留期写进手册）。

**「余额和话单数量与删除前一致」怎么证明。** `snapshot-counts.sh` 输出（owner 身份，读全库）：

- 每个租户的 `tenant_balances.balance`，以及 `SUM(ledger_entries.amount)` 与之是否相等；
- `cdrs`、`ledger_entries`、`raw_cdrs`、`unassigned_cdrs`、`call_uuids`、`system_alerts`、`email_outbox` 的行数，按分区月份分别给出；
- `raw_cdr_archives` 各状态的行数，以及归档目录文件数与总字节；
- 整份输出的 `sha256`。

演练顺序：**停 Worker 与 API（让数据静止）→ `backup.sh` → `snapshot-counts.sh > before.txt` → 删库 → `restore.sh --restore` → `snapshot-counts.sh > after.txt` → `diff before.txt after.txt` 必须为空**。再启动服务，确认 Worker 启动后没有新增异常告警。

**交付：** `ops/backup/*`、手册「备份」「恢复」「恢复演练」三章。
**证据：** `docs/evidence/phase-10/backup-restore/{backup-run.txt,before.txt,after.txt,diff.txt,restore-run.txt,weekly-verify.txt}`，不含备份文件本身，不含密码。
**现在能做吗：** 脚本与 CI 往返测试现在做；**演练可以先在测试服务器 10.0.0.60 上做**（它有 PostgreSQL 17、归档目录和历史数据），但那是删库操作，**执行前需要用户明确同意**；正式证据在服务器 B 上重做一次。

### 4. SIPp 压测（验收 4）

**要证明的四件事：** 授权超时率为 0；所有话单入库；扣费总额等于话单逐条计算的合计；过程中服务器资源有余量。

**怎么理解「50 路并发、每秒 10 通」。** 稳态并发 = 到达率 × 平均通话时长，所以 50 并发加 10 通/秒意味着平均通话约 5 秒。主压测据此设计：`uac-load.xml` 中每通呼叫保持 `<pause distribution="uniform" min="2000" max="8000"/>`（均值 5 秒），`-r 10 -rp 1000 -l 50 -m 18000`，约 30 分钟共 18,000 通。它压的是**授权 + 话单推送 + 扣费**这条热路径，而不是长通话。另做一次补充：50 路各保持 3 分钟，验证并发持有与定时挂断。用户决定（决定 8）两种都做。

**拓扑。** SIPp 在独立主机（不装在服务器 A 上，`freeswitch.md` §1）；服务器 A 的上游网关指向装了 `uas-carrier.xml` 的 SIPp 模拟上游，**不产生真实运营商流量和费用**。测试租户：一个专用编码，充值足够多（18,000 通按 1 分钟计、费率 0.3 元/分钟约 5,400 元，给 100,000），透支额度默认，`limit` 并发上限 ≥ 60。费率表含国内（`86…`）、国际（`44…`、`1…`）三类前缀，拨号清单 `destinations.csv` 覆盖，使「逐条计算」不是同一个数乘 18,000。

**节奏（`run-load.sh`）：** 预检（健康、测试租户余额、磁盘）→ 1 分钟冒烟（2 cps）→ 10 分钟中压（5 cps）→ 正式 30 分钟 → 静置 10 分钟等补推与扣费队列清空 → 核对。全程 `sample-resources.sh` 每 5 秒记 CPU、内存、`pg_stat_activity` 连接数、pg-boss 积压、`journalctl` 错误数。

**核对（`packages/db/scripts/verify-load.ts`，只读）：**

| 检查                    | 方法                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 授权超时率为 0          | 窗口内该租户 `cdrs.unverified = true` 的行数为 0；`system_alerts` 无窗口内新开的 `auth_timeout`；SIPp 统计里没有 5xx/超时的失败呼叫；Worker 授权延迟分位数取自日志 |
| 所有话单入库            | SIPp 成功呼叫数 = 窗口内 `cdrs` 行数（含未接通为 0 的）；`unassigned_cdrs` 与 `raw_cdrs` 的对应计数；A 上 `retry/` 目录为空；`call_uuids` 无重复                   |
| 扣费总额 = 逐条计算合计 | 用 `packages/rating` 的计价函数（decimal.js）对每条话单的快照费率与 `billsec` 重算，求和，与窗口内该租户 `call_charge` 流水之和及余额变化三者比较，必须逐位相等    |
| 资源                    | 峰值 CPU、内存、连接数写进报告；不设通过线，但作为后续容量判断依据                                                                                                 |

**交付：** `ops/loadtest/*`、`verify-load.ts`。
**证据：** `docs/evidence/phase-10/loadtest/{sipp-stats.csv,verify-load.txt,resources.csv,summary.md}`。
**现在能做吗：** 场景与脚本现在写，并用仓库已有的 Docker FreeSWITCH 联调环境做**低速冒烟**（验证脚本本身，不作为验收证据）；**正式 30 分钟要等服务器 A 与 SIPp 主机**。压测会在生产库里留下约 18,000 条话单和流水，且账本只增不改，所以**压测在上线前于 B 上完成，随后重置生产库**（停服务 → 删库 → 重建 → 迁移 → 建第一个管理员），写进上线检查清单。用户已同意（决定 11），重置步骤先演练一次再用。

### 5. 压测中重启 API 和 Web（验收 5）

**怎么做。** 正式压测第 8 分钟，`drill.sh restart-front`：`systemctl restart fs-billing-api`，间隔 10 秒后 `systemctl restart nginx`（Web 即 nginx 静态文件）。期间同时有一个浏览器脚本或 `curl` 循环访问 `/api/health`，记录不可用窗口。

**预期与判据。** 呼叫路径（FreeSWITCH → Worker）不经过 API 或 nginx：SIPp 失败数为 0、窗口内无 `unverified` 话单、话单数不少、`systemd` 日志里 Worker 无重启。后台页面在窗口内短暂不可用属于正常，不算失败。

**交付：** `ops/loadtest/drill.sh` 的 `restart-front` 子命令。
**证据：** `docs/evidence/phase-10/drill-restart-front/`（时间线 `timeline.tsv`：每步的起止时间、SIPp 同时间段统计、`curl` 不可用窗口、journal 摘录）。
**现在能做吗：** 脚本现在写；**执行要等 A 与 SIPp 主机**，且与验收 4 在同一次 30 分钟压测里完成。

### 6. 压测中停 Worker 1 分钟（验收 6）

**怎么做。** 第 15 分钟 `drill.sh stop-worker`：`systemctl stop fs-billing-worker`，60 秒后 `start`。同时在停机后第 5 秒起一通 **120 秒的探针呼叫**，用 `fs_cli -x "uuid_getvar <uuid> execute_on_answer"` 读到 `sched_hangup +1800 ALLOTTED_TIMEOUT`（证明放行时长是 1800 秒；README 说明放行后的挂断就设在这个变量上）。

**预期。** 停机的 60 秒内约 600 通呼叫的授权连不上 Worker，Lua 放行 1800 秒并设 `billing_unverified=true`，通话本身仍按 2–8 秒结束；它们的话单推送失败，落入 `retry/`，Worker 恢复后 `replay-cdr.sh` 在一分钟内补推；Worker 把这些话单计入 `cdrs`（`unverified = true`，照常计费），并累加 `auth_timeout` 告警（**随话单到达才记录**，`affected_calls` 约等于停机期间的呼叫数）。

**判据：**

| 项                   | 判据                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 放行时长             | 探针呼叫的 `execute_on_answer` 为 1800 秒                                                                            |
| 话单全部入库、不重复 | 窗口内 `cdrs` 行数 = SIPp 成功呼叫数；`call_uuids` 无重复；`retry/` 清空；`replay-cdr.sh` 重复推送得 `duplicate`     |
| 扣费不受影响         | 与验收 4 同一套核对，未经验证的话单也扣费一致                                                                        |
| 告警                 | `system_alerts` 有该时间段的 `auth_timeout`，`notify=true`，邮件发件箱有开始通知，恢复后有恢复通知；后台告警页能看到 |

**交付：** `drill.sh` 的 `stop-worker`；`verify-load.ts` 增加「未经验证话单」小节。
**证据：** `docs/evidence/phase-10/drill-stop-worker/`（含探针呼叫的变量输出、告警行、发件箱行，不含授权码）。
**现在能做吗：** 同上，**等 A 与 SIPp 主机**。Docker 联调环境已验证过「超时放行与补推」的单通场景（[联调证据](evidence/reject-billing-mismatch/README.md)），规模版要在真实环境做。

### 7. 实呼核对（验收 7）

**怎么做。** 用测试租户（小额余额，例如刚好够 2 分钟）从真实 SIP 终端经服务器 A 呼出到用户自己的手机，共两通：(a) 对方接听约 70 秒后挂断，应得 2 计费分钟；(b) 让余额只够 1 分钟，到时被 `sched_hangup` 自动挂断（`ALLOTTED_TIMEOUT`），应在约 60 秒挂断。

**核对内容：**

- 授权：Worker 日志里的放行与 `maxSeconds`（号码已掩码）；
- 真实 CDR JSON：**主叫号码字段的位置**——`variables.caller_id_number` 还是首个 `callflow[].caller_profile.caller_id_number`——与入库的 `cdrs.caller` 一致（plan 点名要核对，`worker-api.md` 说优先取 `variables`、缺失才取 `callflow`）；被叫 `billing_dialed_number` 与 `cdrs.callee`、`billing_number`；
- 扣费流水：金额 = 计费分钟 × 费率，备注为 `通话扣费 <UUID> <billing_number>`，余额变化与门户显示一致；
- 保存 `raw_cdrs.body` 的原文。

**证据脱敏：** 号码一律按 `maskNumber` 规则（前 4 后 2）后存档，主叫也掩码；截图只截测试租户；不含共享密钥。实呼用用户自己的两个号码、一条低价真实线路（决定 7）。

**交付：** `docs/ops-runbook.md`「实呼验收」章（步骤与 SQL）。
**证据：** `docs/evidence/phase-10/real-call/`。
**现在能做吗：** **必须等服务器 A、上游线路与真实终端**。

### 8. NTP 时钟监测与偏差告警（验收 8）

**为什么重要。** 取消未来费率版本只允许 `effective_from > 数据库 now() + 余量`（默认 60 秒，`design.md` §6.3），计费归属取 FreeSWITCH 送来的接通时刻；两台机器的时钟差会让跨午夜、跨月的话单归属和取消余量出错。监测对象是**两台机器之间的偏差**，其次是各自相对 NTP 的偏差。

**基础（两台机器都做，无代码）：** 装 `chrony`（比 `systemd-timesyncd` 多了可查询的 `chronyc tracking`），至少 3 个时间源；机房屏蔽公网 NTP 时用机房提供的源，需要用户提供。

**告警接入方案（用户决定 3：接入系统告警）：** 利用现有系统告警，邮件通道、告警页面、红点、概览计数全部复用。

1. 服务器 A 上 `fs-clock-heartbeat.sh` 由 systemd timer 每 30 秒运行：记下本机时间 `t1`，`POST` 到 Worker 新增的 `/clock`（沿用 `X-Billing-Key` 与 IP 白名单），请求体带 `sentAt`、往返时间估计与 `chronyc tracking` 的偏移和同步状态。
2. Worker 用**数据库时钟**（`clock_timestamp()`，取消余量用的就是它）算 `skew = 收到时间 − sentAt − RTT/2`。`|skew|` 超过告警阈值时 `raiseAlert('clock_skew', 'fs-vs-db', …)`，回到阈值内且持续一个静默窗口后 `recoverAlert`。
3. 心跳超过 5 分钟没到则开 `fs_heartbeat` 告警（服务器 A 失联或 Worker 不可达的一侧信号）。这条也是**阶段 9 风险里「Worker/数据库整体宕机无法告警」的部分缓解**：只覆盖「A 在、B 的 Worker 不可达」，不覆盖 B 整机宕机（见[存活监测](#存活监测)）。
4. 服务器 B 自身相对 NTP 的偏差由 `check-clock.sh`（timer，每分钟）读取 `chronyc tracking`，超阈值写 journal 并经 `notify.sh` 发邮件（不依赖应用，数据库或 Worker 挂了也能发）。

**代码范围（PR 4）：** 迁移新增 `system_alerts.kind` 的两个值（下一个迁移号）与 `/clock` 路由、`packages/shared` 的告警种类枚举、后台告警页与概览的标签、对应 DB 测试与越权用例；告警设置里的接收邮箱沿用。心跳不落新表。

**阈值（决定 3）：** 警告 1 秒、严重 5 秒；它们远小于 60 秒取消余量，又大于正常 NTP 抖动。

**演示办法。** 在 A 上停 `chronyd`，`date -s` 拨快 10 秒，等一个心跳周期，展示：告警页出现 `clock_skew`、发件箱有开始邮件；恢复 `chronyd`、`chronyc makestep`，展示恢复邮件。

**交付：** `ops/monitor/{check-clock.sh,fs-clock-heartbeat.sh}`、chrony 配置、Worker `/clock` 与迁移（PR 4）。
**证据：** `docs/evidence/phase-10/ntp/`（`chronyc tracking` 输出两台、演示的告警截图与邮件头）。
**现在能做吗：** Worker 与迁移、B 侧脚本现在做；**心跳与演示要等 A**。

### 9. `billing_tenant` 核对（验收 9）

**怎么做。** 上线前对服务器 A 上实际配置的 `billing_tenant` 与数据库租户编码做不区分大小写的一一核对。

1. A 上 `ops/checks/billing-tenant.sh --extract`：扫 `/etc/freeswitch/directory/`、ACL 与拨号计划，提取所有 `billing_tenant` 的取值（去重、转大写），输出清单文件，注明每个值出自哪个文件。
2. B 上 `ops/checks/billing-tenant.sh --compare <清单>`：读 `SELECT code FROM tenants`，输出四类：**两边一致**；**只在 FreeSWITCH**（这些呼叫会进未归属话单，必须处理）；**只在数据库**（信息：该租户暂无接入）；**仅大小写不同**（授权与入库都转大写，能对上，但提示统一）。两边都在转大写之后检查重复。有「只在 FreeSWITCH」项时退出非零。
3. 同时运行 [freeswitch.md §3.3](freeswitch.md#33-号码格式) 的国内前缀 SQL（必须带 `86`），结果存档。

**交付：** `ops/checks/billing-tenant.sh`、手册一章。
**证据：** `docs/evidence/phase-10/billing-tenant/{fs-tags.txt,compare.txt,prefix-check.txt}`。租户编码是客户标识，证据里可以保留编码（决定 7）。
**现在能做吗：** 脚本现在写，用 Docker 联调环境的配置（`freeswitch/test/conf`）做自测；**真实核对要等 A**（现网即服务器 A 或用户的 FreeSWITCH）。

### 10. 有历史数据的库上演练迁移、测锁时长（验收 10）

**问题。** `lock_timeout = '5s'` 只限制**等锁**的时间，不限制持锁或扫描时间。持锁时长由迁移里的语句决定，例如 `SET NOT NULL`（要全表扫描，除非有已验证的 CHECK）、`CREATE INDEX`（阻塞写）、`ADD COLUMN … DEFAULT`（PG11+ 只改目录）、建触发器（`SHARE ROW EXCLUSIVE`）、`VALIDATE CONSTRAINT`（不阻塞写）。因为迁移在一个事务里，**所有锁一直持有到提交**，所以一个迁移的持锁时长就是整个文件的耗时。

**怎么演练。** `ops/migrate/rehearse.sh <源备份> <目标迁移号>`：

1. 把一份真实规模的库恢复到临时库 `fs_billing_rehearse`。可用的数据来源：(a) 测试服务器的备份；(b) 仓库已有的性能原型库方案（`packages/db/scripts/setup-portal-perf-isolated.ts`，约 300 万话单、14 个月分区）；(c) 上线后用生产备份。
2. 在该库上开 `log_lock_waits = on`、`log_min_duration_statement = 0`（仅在临时库所在实例上设，演练完恢复），**同时**运行一个探针会话：每 50 毫秒对 `cdrs` 做一次写入探测（插入后回滚，或读一行）并记录延迟，模拟业务流量被阻塞的时长。
3. 逐个应用待执行迁移，记录每个文件的墙钟耗时、`pg_locks` 采样里该事务持有的最强锁及其持续时间、探针的最大延迟与受阻时长。
4. 汇总为「锁持有时长表」和「部署窗口 = 迁移总耗时 + 服务重启 + 健康检查」，写成 `summary.md`。

**对已有迁移的诚实预期。** 首次上线时 `0000`–`0024` 在空库上执行，耗时是秒级；对「有历史数据」的演练主要价值是：(1) 证明方法有效，把已有的 `0002/0003/0004/0010/0016`（触及 `cdrs`）当作样本在 300 万行库上量出来；(2) 为**上线后第一个新迁移**建立门禁：之后每个触及大表的迁移都必须附带演练结果，才能部署。后一条写入上线检查清单。

**交付：** `ops/migrate/rehearse.sh`、手册一章、检查清单里的「迁移门禁」。
**证据：** `docs/evidence/phase-10/migration-rehearsal/{summary.md,lock-timeline.txt,probe-latency.txt}`。
**现在能做吗：** **能**。在开发机用性能原型库或测试服务器备份即可，不需要服务器 B；在 B 上上线后再重做一次作为实际基线。

### 11. 大分区表的 `CREATE INDEX CONCURRENTLY` 运维手册（验收 11）

**限制。** drizzle migrator 在事务内执行迁移，`CREATE INDEX CONCURRENTLY` 不能在事务里运行；分区表的父表也不支持直接 `CONCURRENTLY`。

**手册步骤（`docs/ops-runbook.md`「大表加索引」，由 `ops/migrate/concurrent-index.sh` 实现，脚本带 `--dry-run`）：**

1. 评估：分区列表、各分区大小、磁盘余量（索引约占表的 20–70%，见 [portal-cdrs.md](perf/portal-cdrs.md) 的候选索引估算）、`maintenance_work_mem`。
2. **父索引**：`CREATE INDEX name ON ONLY cdrs (...)`（元数据级，几乎瞬间，父索引此时为 invalid）。这一步放进**正常迁移**（事务内可以，因为不扫描数据）。
3. **逐分区**，迁移事务之外，每个分区一条：`CREATE INDEX CONCURRENTLY name_part ON cdrs_2026_10 (...)`；失败会留下 invalid 索引，脚本先 `DROP INDEX CONCURRENTLY` 清理再重试；每个分区之间检查 `pg_stat_activity` 里的长事务（会让 CONCURRENTLY 无限等）。
4. **挂接**：`ALTER INDEX name ATTACH PARTITION name_part`，全部挂接后父索引自动变 valid。
5. **验证**：`pg_index.indisvalid` 全为真；`EXPLAIN` 走新索引；`pg_stat_user_indexes` 有扫描。
6. **回退**：`DROP INDEX CONCURRENTLY` 各分区索引，再删父索引。
7. **迁移文件怎么写**：drizzle 的迁移文件里只放第 2 步（`ON ONLY`），第 3–4 步写成运维步骤，并在迁移文件头注释里指向手册；这样新库（开发、CI、空库）仍能直接得到完整索引（`IF NOT EXISTS` 并由新分区创建时自动继承）。需要的话在手册里给出一个 `0010` 的实例（把它当成「如果上线后才加」的示范）。
8. 新建分区自动继承父索引，不需要额外处理。

**交付：** 手册章节、`ops/migrate/concurrent-index.sh`、`0010` 迁移头注释保持不变（已指向本手册）。
**证据：** `docs/evidence/phase-10/concurrent-index/`：在带分区与数据的开发库上完整走一遍（含一次故意失败后重试）的输出。
**现在能做吗：** **能**，不需要服务器。

### 12. 在有历史数据的库上验证 `0004` guard（验收 12）

**两种场景，各在一个临时库里做：**

- **合法数据升级成功。** 迁移到 `0003`，用性能原型的规模灌入合法的 `cdrs`（`billing_number` 全部符合 `^[1-9][0-9]{5,14}$`）和合法的 `unassigned_cdrs`，应用 `0004`：成功；`cdrs.billing_number` 为 `NOT NULL`；约束已 `VALIDATE`；记录耗时与持锁时长（`SET NOT NULL` 要扫表）。
- **非法数据拒绝且原子失败。** 另一个临时库：迁移到 `0003`，分别构造 (a) `cdrs.billing_number IS NULL`，(b) `cdrs.billing_number` 格式不合法，(c) `unassigned_cdrs` 的 `billing_number` 与 `reason` 不对应。每种单独应用 `0004`：抛出 `reset the dev database before 0004: legacy billing_number rows present`；失败后核对**迁移原子**：`cdrs.billing_number` 仍可空、旧约束名还在、新约束不存在、迁移记录表没有 `0004` 行。

**说明。** 这是历史迁移的一次性验证。首次生产上线在空库上直接执行，guard 不会触发；验证是为了证明 plan 要求的保护有效，并为日后「从旧版本升级的现有库」保留可重复的脚本。

**交付：** `ops/migrate/rehearse.sh` 的 `--scenario guard-0004`，或 `packages/db/scripts/guard-0004.ts`（需要构造数据，用 TypeScript 更合适）。
**证据：** `docs/evidence/phase-10/guard-0004/{valid-upgrade.txt,invalid-null.txt,invalid-format.txt,invalid-unassigned.txt,atomicity.txt}`。
**现在能做吗：** **能**，同验收 10。

### 13. CI 不得静默跳过 FreeSWITCH e2e（验收 13）

**现状。** `freeswitch.yml` 的 `e2e` 在镜像拉不到时输出 `::notice::` 并跳过全部步骤，作业为绿色；`image` 作业在没有令牌时同样跳过（见[现状核对](#仓库里已经有什么)）。绿色不等于联调通过。

**方案：**

1. **状态产物。** `e2e` 作业无论是否执行，最后一步写 `fs-e2e-status.json`（`status: passed | skipped | failed`、提交 SHA、事件、镜像 hash、`results.tsv` 的通过/总数）并上传为产物 `freeswitch-integration-status`；`$GITHUB_STEP_SUMMARY` 显示同样的内容。跳过时作业摘要明确写 **SKIPPED**。
2. **定时、手动、main 推送不许跳过。** 当 `github.event_name` 是 `schedule`、`workflow_dispatch` 或 main 上的 `push` 时，镜像不可用即 `exit 1`（作业红）。每日定时因此会在镜像缺失时变红，而不是静悄悄绿。拉取请求仍允许跳过（外部贡献者没有令牌；改动了 `freeswitch/install|docker` 的 PR 其新 hash 的镜像本来就只能在合并后构建），但状态为 `skipped`。
3. **上线门禁。** `ops/checks/require-fs-e2e.sh <发布提交 SHA>`：用 `gh run list --workflow freeswitch.yml --commit <SHA>` 找该提交上最近成功的运行，下载 `freeswitch-integration-status`，要求 `status == passed` 且通过数 = 总数（现为 15）；否则退出非零。`go-live-checklist.md` 把它列为上线前必过项。
4. **保存证据。** 对发布提交手动 `workflow_dispatch` 一次，把产物里的 `results.tsv`、`containers.log` 与状态文件存入 `docs/evidence/phase-10/fs-e2e/`。

**交付：** `.github/workflows/freeswitch.yml` 修改、`ops/checks/require-fs-e2e.sh`。
**证据：** `docs/evidence/phase-10/fs-e2e/`，以及一次**故意把镜像 hash 改错**的运行（定时/手动事件下作业为红）的链接或截图。
**现在能做吗：** **能**，只需仓库与 GitHub；前提是 `SIGNALWIRE_TOKEN` 仍有效、镜像已构建（需要用户确认，见[风险](#风险)）。

### 14. journald 保留 14 天与访问权限（验收 14）

**配置 `ops/journald/fs-billing.conf`（装到 `/etc/systemd/journald.conf.d/`）：**

```
[Journal]
Storage=persistent
MaxRetentionSec=14day
MaxFileSec=1day
SystemMaxUse=2G
ForwardToSyslog=no
ForwardToKMsg=no
ForwardToConsole=no
ForwardToWall=no
```

- `MaxFileSec=1day` 让文件按天轮换，`MaxRetentionSec` 才能精确到约 14 天（G7）。
- `SystemMaxUse` 是磁盘保护，取值依数据量调整，写进磁盘告警阈值。
- 不装 `rsyslog`、不装任何日志外发代理；核对 `systemctl list-unit-files | grep -Ei 'rsyslog|promtail|vector|fluent'` 为空。

**访问权限：** `/var/log/journal` 为 `2750 root:systemd-journal`；运维账号加入 `systemd-journal`；`fs-billing` 服务用户**不加入**该组。nginx 与 PostgreSQL 的文件日志保持 Debian 默认，不在本验收范围（G5、G6，决定 6）。

**核对步骤（手册与验收共用）：**

| 检查           | 命令（期望）                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 配置生效       | `systemd-analyze cat-config systemd/journald.conf` 含上面各项；`journalctl --disk-usage`                                             |
| 权限           | `stat -c '%a %U:%G' /var/log/journal`；`getent group systemd-journal` 只有运维账号；`sudo -u fs-billing journalctl -n1` 提示权限不足 |
| 不外发         | 上面的 `list-unit-files` 为空；`ss -tnp` 无日志外发连接；`journald.conf` 无 `Forward*` 为真                                          |
| 保留期         | 部署 14 天以上后：`journalctl --since '15 days ago' --no-pager \| head -1` 的最早条目不早于约 14 天前（`MaxFileSec` 使误差在一天内） |
| 日志无明文号码 | 抽样 `journalctl -u fs-billing-worker --since today \| grep -E '[0-9]{8,}'`，仅允许 UUID 与掩码形式                                  |

**交付：** `ops/journald/fs-billing.conf`、手册「日志与隐私」章（含 nginx、PostgreSQL 日志的已知风险说明）。
**证据：** `docs/evidence/phase-10/journald/`（上表各命令的输出）。保留期那一行需要部署满 14 天后补；其余在部署当天取得。
**现在能做吗：** 配置现在写；**实机核对等服务器 B**；「满 14 天」这一行是唯一一个会让验收在时间上晚于部署的项，勾选时间要相应放后，或用 `journalctl --vacuum-time` 的手工演示加配置证明先勾，余下一行补。

## 带入项

不在 14 条验收里，但前面阶段文档已明确「随阶段 10」。

### 存活监测

阶段 9 的风险写明：告警邮件是事后的，Worker 或数据库整体不可用时没有进程能告警。方案本来分两层，用户决定（决定 2）第二层暂不做：

| 层级   | 做法                                                                                                                                                                                                                                                                   | 覆盖                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| B 本机 | `health-check.sh` 的 systemd timer（每分钟）：Worker `/health`、API `/api/health`、PostgreSQL `pg_isready`、`LATEST.json` 新鲜度、磁盘（`/`、`/var/lib/fs-billing`、`/root/backups`）、证书剩余天数、journal 用量；失败经 `notify.sh` 发邮件，同一问题 30 分钟内不重复 | 服务级故障；Worker 或库宕了但机器还在                  |
| B 之外 | 对公网 `https://<地址>/api/health` 的外部探测：**暂不做**（决定 2）                                                                                                                                                                                                    | 不覆盖：B 整机宕机、网络不通、nginx 挂了。记为已知差距 |

邮件走现有 QQ SMTP 的凭据（`notify.sh` 从 `app.env` 读取，用 `curl --ssl-reqd smtps://`），不依赖 Worker。「B 之外」那一层的缺失登记在上线检查清单的「带条件上线」栏；以后补做时仍可用本节提到的两种办法（第三方探测或用户自己机器上的定时 `curl`）。

### 其他带入项

| 来源                                   | 内容                                                                                                                              | 本阶段怎么落实                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 阶段 6（`phase-6-design.md:662、674`） | 10 万条以上导出在 nginx 后重测请求内 RSS 增量与峰值，确认代理缓冲没有改变内存行为                                                 | nginx 配置里导出路径 `proxy_buffering off`；用 `apps/api/scripts/portal-export-perf.ts` 经 nginx 重测，存 `evidence/phase-10/export-behind-nginx/`；**等 B**                         |
| 阶段 7、8（`phase-8-design.md:668`）   | `queue:migrate` 每次部署后重跑；归档目录进备份、设磁盘告警；归档目录仅 Worker 用户可读写；`DETACH` 的锁等待在有历史数据的库上演练 | `deploy.sh` 固定在迁移后跑 `queue:migrate`；备份见验收 3；`health-check.sh` 的磁盘项；目录模式 0700；`DETACH` 并入验收 10 的演练                                                     |
| 阶段 9（`phase-9-design.md:648`）      | `app.env` 增加 `SMTP_*`、`MAIL_FROM`、`APP_PUBLIC_URL`；出站 465 放行；授权码轮换；迁移 0020–0024 的演练；多实例结论              | 环境清单与防火墙已含；轮换步骤写进手册（改 `app.env` → 重启 Worker → `mail:test` → `mail:requeue`）；迁移纳入验收 10；**生产只部署一个 Worker 实例**，多实例已有测试但不在本阶段扩展 |
| 阶段 2（`phase-2-db.md:392`）          | 生产应用角色密码由 `db:migrate` 按 `APP_DATABASE_URL` 设置，部署方式在阶段 10 确定                                                | 见部署基础：两个 env 文件、`openssl rand` 生成                                                                                                                                       |
| 本阶段发现                             | G1–G3 的代码改动                                                                                                                  | PR 2                                                                                                                                                                                 |

## 验收标准对应交付与证据

| #   | 验收标准（缩写）                         | 主要交付                                             | 证据目录（`docs/evidence/phase-10/`） | 现在能做？                                                 |
| --- | ---------------------------------------- | ---------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| 1   | 在 B 上从零部署，用时记录                | `ops/deploy/*`、`ops-runbook.md`                     | `fresh-deploy/`                       | 写脚本和手册可以；**实跑等 B**                             |
| 2   | 公网访问 Worker 端口被拒，A 可以访问     | `ops/firewall/*`                                     | `firewall/`                           | 写规则可以；外部探测**等 B**；A 访问**等 A**               |
| 3   | 删库后用备份恢复，余额与话单数一致       | `ops/backup/*`                                       | `backup-restore/`                     | 脚本可以；演练可先在测试服务器（需用户同意），**正式在 B** |
| 4   | SIPp 50 并发、10 cps、30 分钟            | `ops/loadtest/*`、`verify-load.ts`                   | `loadtest/`                           | 脚本可以；**实跑等 A 与 SIPp 主机**                        |
| 5   | 压测中重启 API 与 Web                    | `drill.sh restart-front`                             | `drill-restart-front/`                | 同 4                                                       |
| 6   | 压测中停 Worker 1 分钟                   | `drill.sh stop-worker`                               | `drill-stop-worker/`                  | 同 4                                                       |
| 7   | 实呼：授权、到时挂断、话单、主叫字段位置 | 手册「实呼验收」                                     | `real-call/`                          | **等 A、上游线路、真实终端**                               |
| 8   | NTP 监测上线，偏差告警可演示             | Worker `/clock` 与迁移、`ops/monitor/*`、chrony 配置 | `ntp/`                                | Worker 与 B 侧可以；**演示等 A**                           |
| 9   | `billing_tenant` 与租户编码一一对应      | `ops/checks/billing-tenant.sh`                       | `billing-tenant/`                     | 脚本可以；**真实核对等 A**                                 |
| 10  | 有历史数据的库上演练迁移，测锁时长       | `ops/migrate/rehearse.sh`                            | `migration-rehearsal/`                | **能**（开发机用原型库）                                   |
| 11  | `CREATE INDEX CONCURRENTLY` 运维手册     | 手册章节、`concurrent-index.sh`                      | `concurrent-index/`                   | **能**                                                     |
| 12  | `0004` guard 验证                        | `guard-0004` 脚本                                    | `guard-0004/`                         | **能**                                                     |
| 13  | CI 不得静默跳过 FreeSWITCH e2e           | `freeswitch.yml`、`require-fs-e2e.sh`                | `fs-e2e/`                             | **能**（确认令牌与镜像）                                   |
| 14  | journald 14 天、访问权限                 | `ops/journald/*`                                     | `journald/`                           | 配置可以；**核对等 B**，保留期一行要等 14 天               |

汇总：**现在就能验收**的是 10、11、12、13；脚本现在写、服务器到位后执行的是 1、2、3、4、5、6、9、14；必须等外部条件才能完成的是 7、8（含 A 才能演示的部分）。

## 上线检查清单与运维手册大纲

**`docs/go-live-checklist.md`**（逐项勾选，每项一句话加命令或链接）：

- 前置：`require-fs-e2e.sh <SHA>` 通过；plan 阶段 10 的 14 条均勾选或有登记的豁免；CI 绿。
- 机器：Debian 13 已更新；`chrony` 同步；nftables 已启用并通过 `verify-ports.sh`；SSH 仅密钥且 22 端口已有速率限制；journald 配置核对；磁盘余量。
- 服务：两个 env 文件权限与内容（无多余键，无测试键）；API/Worker 在 systemd 下 `enabled`；健康检查；`queue:migrate` 已执行；`RAW_CDR_ARCHIVE_DIR` 已设并可写；SMTP `mail:test` 成功；告警接收邮箱已设。
- 数据：**生产库已重置**（压测数据已清）；第一个管理员已创建并改密；第一个客户租户的编码与服务器 A 的 `billing_tenant` 核对；费率表前缀均带 `86`（国内）。
- 备份：`backup.sh` 手动跑通；`LATEST.json`；恢复演练已做；**带条件上线栏**（共同登记，逐项给出解除条件）：①异地备份缺失（只接入试用客户，首个付费客户之前必须有异地备份；过渡期每周手工拉取一份）；②证书为自签而客户已可使用门户（登记域名到位计划）；③没有 B 整机宕机的外部探测；④nginx 与 PostgreSQL 日志保持 Debian 默认（已知风险）。
- 监测：`health-check.sh` timer 启用；时钟偏差告警演示；外部探测暂不做，见「带条件上线」栏。
- 回滚：`rollback.sh` 演练过一次；迁移门禁（大表迁移需附演练结果）。
- FreeSWITCH（A）：共享密钥一致；并发上限；Worker 超时放行路径验证；`replay-cdr.sh` 定时器启用；A 的 NTP。

**`docs/ops-runbook.md`**：新服务器部署；日常部署与回滚；重启与停止顺序（Worker 停止期间的 FreeSWITCH 行为）；查看告警（后台页、`journalctl` 命令、发件箱状态、`mail:requeue`）；备份、恢复、恢复演练、恢复后补推；证书与域名切换；密钥轮换（`WORKER_SHARED_KEY` 要同时改 A 的 `vars.xml` 与 relay；`BETTER_AUTH_SECRET` 轮换使会话失效；SMTP 授权码；数据库角色密码）；大表加索引；迁移演练；时钟告警处理；磁盘告警处理；日志与隐私；创建管理员、解锁账号（`auth:unlock`）；停用租户后切断通话的 `uuid_kill`（链到阶段 5 设计）；常见故障表（症状 → 检查 → 处理）。

## PR 拆分

| PR  | 内容                                                                                                                                                                                                                                                                                               | 依赖       | 需要服务器？                  | 验收与证据                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| 0   | 本 PR：设计文档                                                                                                                                                                                                                                                                                    | 无         | 否                            | prettier；用户已评审并作出 11 条决定（见[已决定](#已决定)）                                 |
| 1   | 部署骨架：`ops/deploy/*`、systemd 单元、nginx（日志保持默认）、PostgreSQL 配置片段、`sshd` 仅密钥片段、env 示例、journald 配置、`nftables-b/a.conf`（22 端口按来源限速；B 无内网地址时附 WireGuard 配置模板）与 `verify-ports.sh`、手册「部署」「回滚」「日志」「证书」章骨架、CI `ops-check` 作业 | 0          | 否（静态检查）                | `shellcheck`、`systemd-analyze verify`、`nft -c`、`nginx -t`；验收 2、14 的交付物           |
| 2   | 代码加固：API `trustProxy` 仅信回环及测试（G1）；`db:seed` 生产保护（G2）；`admin:create` 首个管理员脚本与操作日志（G3）；更正 `development.md` 里「生产打包」的话（G8）                                                                                                                           | 0          | 否                            | `pnpm check`、`pnpm test:db`、`pnpm test:idor`；新增伪造 `X-Forwarded-For` 不换限流桶的测试 |
| 3   | 备份与恢复：`ops/backup/*`、systemd 定时器、`snapshot-counts.sh`、CI 往返测试、手册章（含每周手工拉取的过渡步骤）；可插拔异地驱动约定                                                                                                                                                              | 1          | 否（演练另算）                | CI 往返；验收 3 的交付物                                                                    |
| 4   | 监测与时钟：迁移（两个新告警种类）、Worker `/clock`、告警页与概览标签、`ops/monitor/*`、chrony 配置、`notify.sh`、`health-check.sh`                                                                                                                                                                | 1、2       | 否（演示另算）                | DB 测试与越权用例；验收 8 的交付物                                                          |
| 5   | 迁移工具：`rehearse.sh`、`concurrent-index.sh`、guard-0004 场景、手册章；在开发机原型库上跑出验收 10、11、12 的证据                                                                                                                                                                                | 0          | 否（开发机即可）              | **证据可入库**：`migration-rehearsal/`、`concurrent-index/`、`guard-0004/`                  |
| 6   | 压测与演练资产：SIPp 场景、`run-load.sh`、`drill.sh`、`sample-resources.sh`、`verify-load.ts`，在 Docker FreeSWITCH 联调环境做低速冒烟                                                                                                                                                             | 0          | 否（冒烟用本机 Docker）       | 冒烟记录（标明不是验收证据）；验收 4–6 的交付物                                             |
| 7   | CI 门禁：`freeswitch.yml` 状态产物与定时/手动不得跳过、`require-fs-e2e.sh`；对发布提交触发一次并存证据                                                                                                                                                                                             | 0          | 否                            | 验收 13 的证据                                                                              |
| 8   | 上线核对工具与检查清单：`billing-tenant.sh`、`go-live-checklist.md`、手册补全                                                                                                                                                                                                                      | 1、3、4、5 | 否                            | 用 `freeswitch/test/conf` 自测                                                              |
| 9a  | 在服务器 B 上落地：从零部署（用时）、防火墙、备份恢复演练、journald、导出重测、证书（自签）                                                                                                                                                                                                        | 1、2、3、8 | **B**                         | 验收 1、2（外部侧）、3、14；证据入库                                                        |
| 9b  | 服务器 A 到位后：A 侧部署、`billing_tenant` 核对、NTP 演示、SIPp 压测与两项演练、实呼                                                                                                                                                                                                              | 9a、4、6   | **B、A、SIPp 主机、上游线路** | 验收 2（A 侧）、4–9                                                                         |
| 9c  | 收尾：plan 阶段 10 逐项勾选并附证据，登记差距（异地备份、自签证书、外部探测、日志默认），README 与阶段表更新                                                                                                                                                                                       | 9a、9b     | 否                            | plan 阶段 10 全部勾选或有登记的豁免                                                         |

**并行关系：** PR 1、2、5、6、7 彼此独立，可并行；PR 3、4 依赖 PR 1；PR 8 最后收口；PR 9a 在 B 提供后立即可做，不必等 A；PR 9b 等 A。迁移编号按合并顺序分配（PR 4 是唯一带迁移的）。每个 PR 合并前跑 `pnpm check`，涉及数据库的跑 `pnpm test:db`，PR 2、4 加 `pnpm test:idor`。

## 风险

- **单机备份。** 在异地目标到位前，整机丢失意味着数据库、归档目录（原始 JSON 丢弃后的唯一副本）、备份全部丢失。恢复后还要靠服务器 A 的话单副本补推，而 A 的副本不保证长期保留。用户决定（决定 9）带条件上线：只接入试用客户，首个付费客户之前必须有异地备份。
- **备份含个人信息。** 备份里有完整号码与客户资料，保留 30 天，而管理员在后台删除话单只作用于现库；备份文件权限 600、目录 700，异地时必须加密。
- **自签证书。** 用户决定（决定 4）自签证书阶段客户也可以使用门户。浏览器证书警告会让客户习惯性点过去，且域名到位后切换会让所有会话失效；这两点登记在上线检查清单的「带条件上线」栏，证书指纹写进手册供客户核对。
- **压测污染生产库。** 账本只增不改，压测数据清不掉，所以必须在上线前于 B 上完成并重置库；重置库的步骤要先演练。若压测在上线之后才做，只能在另一套库上做。
- **`tsx` 运行源码。** 启动慢于编译产物，服务器上留着 devDependencies，依赖安装需要外网。风险可接受，替代方案（打包）需要改构建链，不在本阶段。
- **`trustProxy` 与 nginx 配置必须成对。** 只改代码不改 nginx，或反过来，都会让限流失效或可被伪造头绕过；PR 2 的测试与 PR 1 的 nginx 配置要一起验。
- **Worker `/health` 不鉴权。** 防火墙是唯一屏障，规则改动后必须重跑 `verify-ports.sh`。
- **时钟监测依赖往返时间估计。** 心跳的 RTT/2 修正在不对称网络里有误差，同机房内网可忽略；阈值（1 秒/5 秒，决定 3）设在 1 秒以上正是为了吸收它。心跳本身会增加每 30 秒一次的 Worker 请求，量级可忽略。
- **压测解释不同。** 若用户期望的是 50 路长通话，30 分钟共 18,000 通的主压测不是同一回事（用户决定 8：两种都做，已覆盖）。
- **GitHub 令牌与镜像。** 验收 13 依赖 `SIGNALWIRE_TOKEN` 有效并且当前 hash 的镜像已构建；任一不满足，门禁会红，需要用户处理令牌。
- **「保留 14 天」只能事后证明。** 验收 14 的最后一行要部署满 14 天，在时间上晚于其他项。
- **没有高可用。** 单机、单 Worker、单库：B 重启或故障期间 FreeSWITCH 走 1800 秒放行并标记未验证，靠补推恢复。这是设计的既定取舍（`design.md` §4.2），不在本阶段改变。

## 需要用户提供的信息

这些是**输入**而不是决定，缺了就卡住对应工作。

| 信息                                                            | 用于                                                  | 阻塞                |
| --------------------------------------------------------------- | ----------------------------------------------------- | ------------------- |
| 服务器 B 的 SSH 地址与登录方式                                  | PR 9a                                                 | 所有服务器工作      |
| B 的公网 IP；是否有内网 IPv4 及其地址；服务器 A 的公网与内网 IP | `WORKER_HOST`、`WORKER_ALLOWED_IPS`、防火墙、证书 SAN | 验收 2、Worker 部署 |
| 首位管理员的姓名与登录邮箱                                      | `admin:create`                                        | 上线                |
| 系统告警接收邮箱（后台「告警设置」）与运维账号的邮箱            | `notify.sh`、告警邮件                                 | 验收 8              |
| 机房可用的 NTP 源（若公网 NTP 被屏蔽）                          | chrony                                                | 验收 8              |
| 服务器 A、SIPp 主机、上游线路的就绪时间                         | PR 9b                                                 | 验收 4–9            |

## 已决定

用户于 2026-10-30 对原待定问题作出以下 11 条决定，正文各处已按此改写。

| #   | 问题                                     | 决定（2026-10-30）                                                                               | 影响                                                                                                    |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | 服务器 A 到 B 的 Worker 通路             | 有内网用内网，没有就在 A 与 B 之间建 WireGuard；Worker 不监听公网                                | `WORKER_HOST` 取内网或隧道地址；防火墙只放行 A；需要用户提供 B 是否有内网地址                           |
| 2   | B 整机宕机的外部探测                     | 暂不做，记为已知差距                                                                             | 只做 B 本机检查；写入上线检查清单「带条件上线」栏；见[存活监测](#存活监测)                              |
| 3   | 时钟偏差告警                             | 接入系统告警，警告 1 秒、严重 5 秒                                                               | PR 4：新迁移加两个告警种类、Worker `/clock`、告警页标签；B 自身偏差仍由脚本邮件                         |
| 4   | 自签证书阶段客户门户给谁用               | 客户也可以使用，不限于管理员                                                                     | 证书警告与会话失效风险登记在「带条件上线」栏；手册记录证书指纹                                          |
| 5   | SSH 来源                                 | 允许任意来源，仅密钥登录加 nftables 速率限制                                                     | `nftables-b.conf` 对 22 端口按来源限速；新增 `sshd` 仅密钥片段；不再需要来源 IP 输入                    |
| 6   | nginx、PostgreSQL 文件日志策略           | 保持 Debian 默认，不改保留期，不去查询串                                                         | G5、G6 改为用户接受的已知风险；PR 1 不含对应配置；验收 14 只管 journald，仍按 14 天加 `MaxFileSec=1day` |
| 7   | 实呼与核对证据                           | 号码按 `maskNumber` 掩码；用用户自己的两个号码、一条低价真实线路；租户编码可留在证据里           | 见验收 7、9 的证据说明                                                                                  |
| 8   | 「50 路并发、每秒 10 通、30 分钟」的含义 | 两种都做：约 5 秒短通话约 18,000 通，加 50 路各保持 3 分钟                                       | 见验收 4                                                                                                |
| 9   | 异地备份缺失期间上线                     | 带条件上线，只接入试用客户，首个付费客户之前必须有异地备份；过渡期每周手工拉一份到用户自己的机器 | 登记在「带条件上线」栏；手册写拉取步骤                                                                  |
| 10  | 备份频率与 RPO                           | 每日一次，RPO 24 小时                                                                            | 靠服务器 A 的话单副本补推；其保留期写进手册                                                             |
| 11  | 压测后是否重置生产库                     | 同意；重置步骤先演练                                                                             | 压测在上线前于 B 上进行，随后重置；重置步骤列入上线检查清单                                             |

## 本步验证

2026-10-30 在本机读取了仓库和用户的部署备忘录，**没有运行 `pnpm check`，没有运行任何测试，没有连接数据库或任何服务器，没有执行任何脚本**，也没有写入 `ops/` 目录或证据目录。

- **读取并核对的事实：** `docs/plan.md`（阶段 10、第 2 节）、`docs/design.md`、`docs/development.md`、`docs/freeswitch.md`、`docs/worker-api.md`、`docs/phase-9-design.md` 及阶段 5–8 中指向阶段 10 的段落；根与各包的 `package.json`；`.env.example`；`apps/api/src/{config,app,main}.ts`、`apps/worker/src/{config,main,app}.ts`、`packages/db/src/{client,migrate}.ts` 与 `bin/*`；迁移 `0004`、`0010`、`0019`、`0024` 的内容以及 `0002`–`0023` 中触及大表的语句（用 `grep` 列出）；`freeswitch/README.md`、`freeswitch/nginx/billing-cdr.conf`、`freeswitch/test/sipp/`、`.github/workflows/{ci,freeswitch}.yml`、`compose.yaml`。
- **来自记忆而非本步复核的内容：** 测试服务器的现状（`/opt/fs-billing`、env 文件、nginx、归档目录路径）和用户 2026-10-30 的回答；没有登录 10.0.0.60。
- **来自通用知识、实现时需要在 Debian 13 上核实的内容：** Debian 13 源里 Node 的版本、`postgresql-17` 的日志与 logrotate 默认值（G6）、nginx 默认日志格式与 logrotate 默认值（G5）、`journald` 的 `MaxFileSec`/`MaxRetentionSec` 语义（G7）、`nft`/`chrony`/`certbot` 的具体命令与单元名、SIPp 的 `pause distribution`、`-l/-r/-m` 参数组合、PostgreSQL 对分区表 `CREATE INDEX ON ONLY` 与 `ATTACH PARTITION` 的行为。
- **刻意没有做的判断：** 备份时刻（05:00）、保留份数下限（3 套）、`SystemMaxUse`（2G）等数值是设计起点，没有依据实测；告警阈值 1 秒/5 秒是用户决定（决定 3）；`/clock` 的路径名与告警种类名是占位，PR 4 实现时再定。
- **G1 的推断：** 「所有请求来源都是 `127.0.0.1`」是由 `trustProxy: false` 与 nginx 反向代理推出的，没有在测试服务器上复现；PR 2 先用测试复现再修。
