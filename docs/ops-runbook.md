# 运维手册

本手册面向在生产服务器 B（Debian 13）上执行部署与排障的人。命令中的
`<B_IP>`、`<A_IP>`、`<B_PRIVATE_IP>`、`<DOMAIN>` 都是占位符，执行时替换为实际值；
仓库、文档和截图里不写真实地址与密钥。

当前版本含「部署」「回滚」「迁移演练」「压测与演练」「大表加索引」「备份」「恢复」「恢复演练」「日志与隐私」「监测与告警」「证书」十一章。
密钥轮换等章节由后续 PR 增补；上线前以上线检查清单收口
（`docs/go-live-checklist.md` 在后续 PR 建立）。

## 部署

### 新服务器部署（服务器 B）

从一台刚装好的 Debian 13 开始。整个过程只使用 root 的 SSH 会话；服务器上不装
Docker，API 与 Worker 由 systemd 管理，nginx 托管 Web 静态文件并代理 `/api`，
PostgreSQL 用 Debian 官方 `postgresql-17`。

#### 0. 前置

- 服务器 B 的公网 IPv4，以及可选的 B 内网 IPv4。
- 服务器 A 的地址。A 未到位时可以先填一个占位地址，或临时用一台内网替身机器的
  地址做过渡验证；A 到位后按下面「防火墙」改 `FS_A_IP` 与 `WORKER_ALLOWED_IPS`
  并复验，复验前验收 2 不勾选，替身证据要注明「用替身，A 到位后复验」。
- 本机能 `ssh root@<B_IP>`，并且 root 已配置公钥。`bootstrap-server.sh` 会关闭密码
  登录；没有非空 `authorized_keys` 时脚本会拒绝继续（除非显式加 `--skip-ssh-check`）。
- 服务器能访问 Debian 源、nodejs.org 与 npm registry。

#### 1. 复制仓库并引导

在工作站仓库根执行：

```sh
git ls-files -z -- . \
  ':(exclude)design/**' \
  ':(exclude).claude/**' \
  ':(exclude)docs/evidence/**' |
  COPYFILE_DISABLE=1 tar --null -T - -czf /tmp/fs-billing-bootstrap.tar.gz
scp /tmp/fs-billing-bootstrap.tar.gz root@<B_IP>:/root/
ssh root@<B_IP> 'mkdir -p /root/fs-billing-bootstrap &&
  tar -xzf /root/fs-billing-bootstrap.tar.gz -C /root/fs-billing-bootstrap'
```

解包后先记录计时起点，再运行引导脚本：

```sh
ssh root@<B_IP> '/root/fs-billing-bootstrap/ops/deploy/stopwatch.sh mark "起点：root 可 SSH 登录"'
```

按 B 是否有内网地址选择 Worker 监听地址：有内网用内网 IPv4；没有内网时先留
`127.0.0.1`，建好 WireGuard 后再改成隧道地址（见「Worker 跨机通路」）。

```sh
ssh root@<B_IP> '/root/fs-billing-bootstrap/ops/deploy/bootstrap-server.sh \
  --public-ip <B_IP> \
  --fs-a-ip <A_IP> \
  --worker-host <B_PRIVATE_IP>'
```

脚本会安装系统包、创建 `fs-billing` 用户与 `/var/lib/fs-billing`、安装 Node
（版本取 `.node-version`，校验 `SHASUMS256.txt`）、生成自签证书、安装 systemd /
nginx / PostgreSQL / sshd / journald / nftables 配置，创建数据库 owner 角色与
`fs_billing` 数据库，并生成 `/etc/fs-billing/{app,owner}.env`。已存在的 env 文件
与证书不会被覆盖，可以重复执行；重跑会重启 nginx、PostgreSQL 与 sshd，避免在
业务高峰执行。

自签证书的 SAN 是 `--public-ip`，有效期 1 年；`BETTER_AUTH_URL` 也设为
`https://<B_IP>`。

#### 2. 核对环境文件

```sh
ssh root@<B_IP> 'stat -c "%a %U:%G %n" /etc/fs-billing/app.env /etc/fs-billing/owner.env /var/lib/fs-billing /var/log/journal'
```

期望 `app.env` 为 `640 root:fs-billing`，`owner.env` 为 `600 root:root`，
`/var/lib/fs-billing` 为 `700 fs-billing:fs-billing`，`/var/log/journal` 为
`2750 root:systemd-journal`。

- `app.env` 只放服务进程需要的键，**不得有 owner `DATABASE_URL`**。
- `owner.env` 只放迁移、`queue:migrate`、`auth:bootstrap`、`auth:unlock` 与备份需要的键。
- 两个文件中 `APP_DATABASE_URL`、`AUTH_DATABASE_URL`、`BETTER_AUTH_SECRET`、
  `BETTER_AUTH_URL` 必须一致，因为 `db:migrate` 按 URL 设置应用角色密码。
- 键值必须是纯 `KEY=value`，不含空格、引号和行内注释。检查：

```sh
ssh root@<B_IP> 'grep -nE "^[A-Z0-9_]+=.*[[:space:]]" /etc/fs-billing/app.env /etc/fs-billing/owner.env || true'
```

只应有注释行包含空格；键值行出现空格就要修正（也不要用引号）。

生产环境不得出现 `AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX`、`FSB_ALLOW_TEST_OVERRIDES`、
`SEED_AUTH_PASSWORD`、`PERF_*`、`P4_IDOR_*`。

生产变量清单、必填项与默认值见
[阶段 10 设计：生产环境变量清单](phase-10-design.md#生产环境变量清单只列名字不写值)。

#### 3. 首次发布

在工作站仓库根执行：

```sh
ops/deploy/deploy.sh root@<B_IP>
```

脚本依次做：本机 `git ls-files` 打包（排除 `design/`、`.claude/`、`docs/evidence/`）
→ `scp` → 服务器解到 `/opt/fs-billing/releases/<sha>` → `pnpm install --frozen-lockfile`
→ Web 构建 → 以 owner 身份 `pnpm db:migrate` 与 `pnpm --filter @fs-billing/worker queue:migrate`
→ 原子切换 `current` → 重启 `fs-billing-api`、`fs-billing-worker` → 健康检查 →
写 `DEPLOYED_COMMIT` → 只保留最近 3 个 release。**不运行任何 `*:seed`。**

首次发布前 `current` 不存在，API/Worker 已 `enable` 但未启动；`deploy.sh` 切换后
才会启动。发布失败时 `current` 保持旧链接（首次则仍不存在），修好后重跑；已经
切换但健康检查失败时，按「回滚」切回上一个 release。

#### 4. 冒烟核对

```sh
ssh root@<B_IP> 'curl --noproxy "*" -fsS http://127.0.0.1:3000/api/health'
ssh root@<B_IP> 'curl --noproxy "*" -fsS http://<WORKER_HOST>:3001/health'
ssh root@<B_IP> 'systemctl --no-pager --full status fs-billing-api fs-billing-worker'
curl -k -fsS https://<B_IP>/api/health
curl -k -I https://<B_IP>/
```

两个 `/health` 均返回 `{"status":"ok",...}`；Web 首页返回 200。自签证书会让
`curl`/浏览器告警，`-k` 只用于验收命令；浏览器里的证书指纹核对见「证书」。

首个管理员的创建命令由后续的代码加固步骤提供；上线前按上线检查清单执行，
创建后再验证后台登录。

#### 5. 防火墙

从**不是 B 本机**的外部主机：

```sh
ops/firewall/verify-ports.sh external <B_IP>
```

期望 3001、5432、3000 全部拒绝或超时。`nftables-b.conf` 的默认策略是丢弃，
只开放 80/443、按来源限速的 22、ICMP/ICMPv6，以及 `FS_A_IP` 到 3001。PostgreSQL
只监听 localhost，API 只监听回环，所以 5432 与 3000 不依赖 nftables 也不能从外部到达。

从服务器 A：

```sh
WORKER_SHARED_KEY='<与 app.env 一致>' ops/firewall/verify-ports.sh from-a <B_WORKER_IP>
```

期望 `/health` 与带密钥的 `/authorize` 都返回 200。`/authorize` 用不存在的探测租户，
不会写入数据；200 只证明来源 IP、密钥与路由都通。

在 A 上应用 A 侧规则：

```sh
# 先把源文件里的 FS_B_IP 与 RTP 范围改成实际值，再拷到 A 上安装
install -m 0644 ops/firewall/nftables-a.conf /etc/nftables.conf
nft -c -f /etc/nftables.conf && systemctl restart nftables
```

`nftables-a.conf` 默认丢弃入站，只开 SIP 5060/5061、RTP 范围与限速 SSH；出站放行
DNS、NTP、apt/证书、上游 SIP/RTP 和 B 的 3001。改规则后必须重跑 `verify-ports.sh`。

#### 6. Worker 跨机通路

优先用 B 的内网 IPv4：`WORKER_HOST` 设为内网地址，`WORKER_ALLOWED_IPS` 只放 A 的
内网地址。

B 没有内网地址时，在 A 与 B 之间建 WireGuard，Worker 监听隧道地址，仍然不监听公网：

1. 两台机器都 `apt-get install -y wireguard-tools`，按
   [wireguard-b.conf.example](../ops/firewall/wireguard-b.conf.example) 与
   [wireguard-a.conf.example](../ops/firewall/wireguard-a.conf.example) 生成密钥与
   `/etc/wireguard/wg0.conf`（0600 root:root），`systemctl enable --now wg-quick@wg0`。
2. 在 B 的 `/etc/nftables.conf` 取消 `iifname "wg0" tcp dport 3001` 与
   `udp dport 51820` 两行注释（后者只允许 A 公网地址），`nft -c -f` 后
   `systemctl restart nftables`。
3. 在 A 的 `/etc/nftables.conf` 取消到 `10.66.0.1:3001` 与 B 公网 UDP 51820 的
   注释，同样校验后重启。
4. 把 B 的 `app.env` 改成 `WORKER_HOST=10.66.0.1`、`WORKER_ALLOWED_IPS=10.66.0.2`，
   重启 Worker；A 的 `billing_worker_url` 与 relay 改到 `10.66.0.1:3001`。
5. 从 A 重跑 `verify-ports.sh from-a 10.66.0.1`。

#### 7. 用时记录与偏离

从「root 能 SSH 登录」开始，在每个手册步骤前后记录：

```sh
/root/fs-billing-bootstrap/ops/deploy/stopwatch.sh mark "起点：root 可 SSH 登录"
/root/fs-billing-bootstrap/ops/deploy/stopwatch.sh mark "1. 引导完成"
# 工作站执行发布：FS_BILLING_STOPWATCH=1 ops/deploy/deploy.sh root@<B_IP>
/opt/fs-billing/current/ops/deploy/stopwatch.sh mark "冒烟通过"
```

`mark` 的区间是人工等待与输入（默认 `--kind manual`），`run` 只记录被包裹命令的
脚本耗时（`kind=script`），两者写在 `/var/log/fs-billing-deploy-time.tsv`。在工作站用
`FS_BILLING_STOPWATCH=1` 发布时，`deploy.sh` 会在服务器上把依赖安装、Web 构建与
两个迁移各记一行，与人工步骤分开；不打开时这些阶段不单独记时。

```sh
FS_BILLING_STOPWATCH=1 ops/deploy/deploy.sh root@<B_IP>
```

`deploy.sh` 自己的健康检查等待不单独记时。

每个偏离手册的地方写进 `docs/evidence/phase-10/fresh-deploy/deviations.md`
（执行时把证据放在同一目录），事后改手册。证据按
[阶段 10 设计](phase-10-design.md#1-从零部署验收-1) 放在
`docs/evidence/phase-10/fresh-deploy/`。

### 日常部署

```sh
ops/deploy/deploy.sh root@<B_IP>
```

发布当前 `HEAD` 的提交；工作区必须干净，未提交或未跟踪的改动会让脚本拒绝发布。
发布前确认 CI 绿、迁移向后兼容一个版本。
`pnpm install --frozen-lockfile` 需要服务器能访问 npm registry。

### 端口验证

规则或 A 地址变更后重跑：「防火墙」一节的 external 与 from-a 两条命令。验收 2
必须在 A 到位后用 A 复验，替身机器的结果只作过渡证据。

## 回滚

回滚 = 把 `current` 符号链接切回上一个 release，再重启两个服务。**数据库迁移不回滚**，
所以旧代码必须与新 schema 兼容至少一个版本；不兼容时不要回滚，先停服务并联系开发。

```sh
# 在服务器 B 上
/opt/fs-billing/current/ops/deploy/rollback.sh --list
/opt/fs-billing/current/ops/deploy/rollback.sh            # 切回最近一个已成功发布的 release
/opt/fs-billing/current/ops/deploy/rollback.sh <sha>      # 切回指定 release
```

`current` 失效、`current/ops/deploy/rollback.sh` 跑不了时，直接用任一 release 里的
同一脚本：

```sh
/opt/fs-billing/releases/<sha>/ops/deploy/rollback.sh <target-sha>
```

脚本只切链接、重启并检查两个 `/health`，不碰数据库，也不删 release。回滚后：

- 确认 `readlink -f /opt/fs-billing/current` 指向目标。
- 两个服务健康；FreeSWITCH 侧授权与话单推送恢复正常。
- 记录回滚原因、时间与涉及提交；如果迁移已应用，评估是否需要向前修复而不是再次回滚。
- `deploy.sh` 只保留最近 3 个 release；回滚目标必须在这 3 个之内。

日常发布失败时先看 `deploy.sh` 的输出：在切换 `current` 之前失败，旧版本继续服务，
修好后重跑即可；切换之后健康检查失败，按本节回滚。

## 迁移演练

### 什么时候做

- 上线前，用原型库或测试服务器备份把 `0002/0003/0004/0010/0016` 这些触及 `cdrs`
  的迁移量一遍。
- 上线后，**每个触及大表的新迁移**在部署前都要附一次演练结果（迁移门禁，见上线
  检查清单）。迁移在事务里执行，锁一直持有到整批提交；只有该文件是唯一待执行
  迁移时，一个文件的墙钟耗时才是它的持锁时长。`lock_timeout` 只能限制等锁，
  限制不了持锁与扫描。

### 准备数据

三条路，按可用性选一条：

1. **真实规模备份**：`pg_dump -Fc` 的测试服务器或生产备份。不要在生产库上演练。
2. **原型库**：`prototype:<基线迁移号>`，脚本先在临时库里静默迁到该号，再灌
   合成话单（默认 300 万条、14 个月分区）。号码是合成的，不含真实用户数据。
3. **同实例克隆**：`db:<库名>`，用 `CREATE DATABASE ... TEMPLATE` 复制一份已有
   的演练库；源库必须没有活动连接。

演练只碰临时库（默认 `fs_billing_rehearse`），脚本拒绝把 `fs_billing` 当源库或
目标库。连接参数全部取标准 `PG*` 环境变量：

```sh
export PGHOST='<演练实例地址>'
export PGPORT='<演练实例端口>'
export PGUSER='<owner 角色>'
# PGPASSWORD 从环境或受限文件读取，不写进命令行与仓库
ops/migrate/rehearse.sh --out /tmp/rehearse \
  --machine-label '服务器 B（演练实例）' db:fsb_rehearse_source 0024
```

第一次只灌原型数据：

```sh
ops/migrate/rehearse.sh --cdrs 3000000 --keep --out /tmp/rehearse-0003 \
  --machine-label '开发机' prototype:0001 0003
```

这次会把 `0002`（加列）与 `0003`（加 `billing_number`、`VALIDATE`）量出来。到
`0003` 后把 `billing_number` 回填成合法值，再以这个库为源继续跑 `0004` 及之后：

```sh
psql -d fs_billing_rehearse -c \
  "update cdrs set billing_number = callee where billing_number is null;"
psql -d fs_billing_rehearse -c 'vacuum (analyze) cdrs;'
# 先用 --keep 保留上一轮的库，再复制一份作为 0003 基线
createdb -T fs_billing_rehearse fsb_rehearse_0003
ops/migrate/rehearse.sh --out /tmp/rehearse-0024 \
  --machine-label '服务器 B（演练实例）' db:fsb_rehearse_0003 0024
```

`prototype:0001 0003` 之后临时库默认会被删；需要继续用就加 `--keep`。

### 演练期间实例上的设置

只在**一次性演练实例**上开日志，不在这台机器以外的生产库上改：

```sql
ALTER SYSTEM SET log_lock_waits = on;
ALTER SYSTEM SET log_min_duration_statement = 0;
SELECT pg_reload_conf();
-- 演练结束后恢复：
ALTER SYSTEM RESET log_lock_waits;
ALTER SYSTEM RESET log_min_duration_statement;
SELECT pg_reload_conf();
```

`log_min_duration_statement = 0` 会记录所有语句；如果实例里有真实号码，这会写进
日志。生产库不要这样设置（见「日志与隐私」）。

### 脚本做了什么

1. 把数据来源恢复/克隆到临时库 `fs_billing_rehearse`。
2. 建一个会话，每 50ms 对 `cdrs` 做一次写入探测（插入后主动回滚）；迁移持锁时
   探测延迟上升，这就是业务写入被阻塞的时长。
3. 默认逐文件在独立事务里应用待执行迁移，记录每个文件的墙钟耗时；加 `--batch`
   时与真实 migrator 一致，把本轮所有待执行迁移放在一个事务里。两种模式都每
   100ms 采样迁移事务在 `pg_locks` 里持有的关系锁。
4. 默认模式汇总为 `summary.md`（每文件墙钟、最强锁与持锁跨度）、
   `lock-timeline.txt`、`probe-latency.txt`；`--batch` 只汇总整批的总墙钟、
   最强锁及其跨度、探针最大与受阻时间，另两个文件照常写。

`summary.md` 里的「部署窗口」= 迁移总耗时 + 服务重启与健康检查估算。锁一直持有
到提交，所以「持锁跨度」约等于该文件的墙钟耗时；采样间隔是 100ms，短锁可能只被
采到一次或不出现。

**注意：** drizzle migrator 把本轮所有待执行迁移放在同一个事务里。一次部署如果
有多条待执行迁移，锁会一直持到最后一个文件提交，实际时长是整批的墙钟；只有该文件
是唯一待执行迁移时，一个迁移的持锁时长才等于该文件的耗时。默认模式按文件分别计时，
`summary.md` 的「迁移总耗时」和部署窗口已按总和计算，但每文件数字仍会低估阻塞；
部署前用 `--batch` 再量一次。

一次部署有多条待执行迁移时，用 `--batch` 做演练。部署期间如果与线上流量死锁，
整批迁移会回滚，旧代码继续运行，重试是安全的；触及 `cdrs` 或 `tenants` 的迁移应
安排在业务低峰发布。

### 怎么看结果

- 探针最大延迟持续接近某个迁移的墙钟耗时：说明该迁移阻塞了写入。
- `AccessExclusiveLock` 出现在 `SET NOT NULL`、`ADD COLUMN`、`ADD CONSTRAINT`
  这类语句上；`CREATE INDEX`（非 CONCURRENTLY）持 `ShareLock`，会挡写但不挡读。
- 墙钟耗时接近 `lock_timeout`（5 秒）时，先确认是等锁还是确实在扫表；等锁说明
  部署窗口有并发事务，扫表说明需要改成 `CONCURRENTLY` 或分批回填。
- 把结果附在发布说明或 `docs/evidence/phase-10/migration-rehearsal/`，作为迁移
  门禁的证据。上线后在服务器 B 上用生产备份重做一次，作为真实基线。

失败时脚本保留临时库并打印最后 40 行 `psql` 输出；检查完用
`dropdb --force fs_billing_rehearse` 清理。不要把这个库接到应用上。

## 压测与演练

验收 4–6 的脚本在 [ops/loadtest](../ops/loadtest)：SIPp 同时扮演客户（UAC）与**模拟上游**
（UAS），FreeSWITCH 的上游网关指向 UAS，所以压测不产生任何真实运营商流量与费用。
号码清单 `destinations.csv` 全是合成号码，覆盖国内 `86`、国际 `44` 与 `1` 三类前缀；
不要把它换成真实客户号码。

**压测数据清不掉。** 账本只增不改，30 分钟正式压测会在生产库留下约 18,000 条话单和
对应流水，事后不能删除。因此压测必须**在上线前、服务器 B 上**完成，完成后**重置生产库**
（停服务 → 删库 → 重建 → 迁移 → 建第一个管理员）。重置步骤要**先在另一套库上演练一次**，
再用于生产库；重置后的库才是上线检查清单里「生产库已重置」的状态。若压测只能安排在上线
之后，就换一套独立的库做，不能污染生产账本。

### 拓扑与前置

- SIPp 单独一台主机（不装在服务器 A 上），能访问 A 的 SIP 端口；A 的上游网关指向 SIPp
  主机上 `uas-carrier.xml` 监听的地址与端口。
- 测试租户一个专用编码（建议 `LOADTEST`，不含下划线），余额足够、`limit` 并发上限 ≥ 60；
  费率表至少含 `86`、`44`、`1` 三个前缀且国内前缀带 `86`。
- SIPp 主机有仓库 checkout（`verify-load.ts` 从这里运行）和 `psql`；`DATABASE_URL` 只放
  环境或 `--env-file`，不写进命令行。
- `sample-resources.sh` 在服务器 B 上运行；`drill.sh` 在 B 与 A 上运行，均以 root。

脚本默认只指向回环地址。真实环境显式传地址（下文的 `<A_SIP_IP>`、`<SIPP_IP>` 是占位符）：

```sh
export DATABASE_URL='postgresql://<只读或 owner 用户>@<B_DB_HOST>:5432/fs_billing'
export API_HEALTH_URL='https://<B_IP>/api/health'
export WORKER_HEALTH_URL='http://<B_PRIVATE_IP>:3001/health'
```

### 跑正式压测

在 SIPp 主机、仓库根执行。`--fs` 是服务器 A 的 SIP 地址，`--uas` 是本机给 A 回呼的地址：

```sh
ops/loadtest/run-load.sh \
  --out /tmp/loadtest-$(date -u +%Y%m%dT%H%M%SZ) \
  --tenant LOADTEST \
  --fs <A_SIP_IP>:5060 \
  --uas <SIPP_IP>:5090 \
  --uac-ip <SIPP_IP>
```

`retry/` 在服务器 A 上，SIPp 主机通常看不到；压测结束、补推完成后，在 A（或挂载了该目录的机器）上补跑一次
`verify-load.ts --retry-dir /var/lib/freeswitch/cdr/retry`，见下面「核对输出」。

脚本顺序执行：预检（两个健康检查、租户余额、磁盘余量）→ 1 分钟冒烟 2 cps → 10 分钟
中压 5 cps → 30 分钟正式 10 cps（`-l 50 -m 18000`）→ 静置（最多 10 分钟，等补推与扣费
队列清空）→ `verify-load.ts`。每个阶段都写 `-trace_stat`，最后汇总进核对。

扣费队列现在每个 Worker 每秒只消费约 0.5 个任务（charge Worker 的 pg-boss 用默认值：
一次只取一个任务、每 2 秒轮询一次）。因此 18,000 通呼叫的积压在这条链路修好之前
不可能被 `run-load.sh` 的 10 分钟静置清空；静置到点只会打印 warn，随后 `verify-load.ts`
按未扣费判定失败。

速率、时长、并发都能覆盖；例如只跑冒烟验证环境：

```sh
ops/loadtest/run-load.sh --out /tmp/load-smoke --tenant LOADTEST \
  --fs <A_SIP_IP>:5060 --uas <SIPP_IP>:5090 --uac-ip <SIPP_IP> \
  --skip-medium --skip-full --smoke-rate 2 --smoke-seconds 60
```

**补充模式（决定 8）：50 路各保持 3 分钟。** 在 `run-load.sh` 的另一次运行里：

```sh
ops/loadtest/run-load.sh --mode long --out /tmp/loadtest-long \
  --tenant LOADTEST --fs <A_SIP_IP>:5060 --uas <SIPP_IP>:5090 --uac-ip <SIPP_IP>
```

它从 `uac-load.xml` 生成一个只把 pause 换成 180000ms 的临时场景，`-l 50 -m 50` 同时起呼。

### 资源采样

在服务器 B 上另开一个会话，从压测开始前跑到静置结束：

```sh
ops/loadtest/sample-resources.sh --out /tmp/load-resources.csv --interval 5
```

CSV 每 5 秒一行：CPU、1 分钟负载、内存、`pg_stat_activity` 连接数、pg-boss 积压、
journal 错误行数。峰值写进证据的 `summary.md`；设计不设通过线，它用于后续容量判断。

### 核对输出

`run-load.sh` 把核对写到 `<out>/verify-load.txt`，同时以退出码表示结果。手工重跑：

```sh
pnpm --filter @fs-billing/db exec tsx --env-file-if-exists=../../.env \
  scripts/verify-load.ts --tenant LOADTEST \
  --since 2026-11-04T02:00:00Z --until 2026-11-04T02:30:00Z \
  --sipp-log /tmp/loadtest/full.log
```

补推完成后在服务器 A 上补查 `retry/`（SIPp 统计已经在上一轮核对过，这里用 `--skip-sipp`）：

```sh
pnpm --filter @fs-billing/db exec tsx --env-file-if-exists=../../.env \
  scripts/verify-load.ts --tenant LOADTEST \
  --since 2026-11-04T02:00:00Z --until 2026-11-04T02:30:00Z \
  --skip-sipp --retry-dir /var/lib/freeswitch/cdr/retry
```

`--skip-sipp` 只跳过 SIPp 成功数这一项，其余检查照常执行；不要把它用在正式证据的主核对上。

它逐条用 `packages/rating` 的 `priceCall` 重算（每条话单的快照费率与 `billsec`，
60/60、decimal.js、不舍入），要求「重算合计 = `call_charge` 流水合计 = 余额变化」
逐位相等；未接通与 0 元话单不得有流水。任何不相等、SIPp 成功数与话单数不一致、
`raw_cdrs` 缺原文、`call_uuids` 重复、`retry/` 非空、窗口内出现 `auth_timeout` 都会
退出非零。「未经验证话单」小节单独列出 `unverified` 的条数与金额，验收 6 也用它。

`--max-unverified` 只在演练里放宽（例如停 Worker 的 60 秒），正式压测保持默认 0；
`--expect-auth-timeout` 用于验收 6，要求窗口内确有 `auth_timeout` 告警。

### 压测中重启 API 与 Web（验收 5）

正式压测第 8 分钟，在服务器 B：

```sh
ops/loadtest/drill.sh restart-front --out /tmp/drill-restart-front \
  --sipp-stats /tmp/loadtest/full-stats.csv
```

它 `systemctl restart fs-billing-api`，10 秒后 `systemctl restart nginx`，同时每秒
`curl` 一次 `https://127.0.0.1/api/health`（自签证书默认加 `-k`）。输出
`timeline.tsv`（每步起止）、`curl.tsv`、`unavailable-window.txt`、`journal.txt`、
`sipp-window.csv`。后台页面短暂不可用不算失败；判据仍是呼叫路径不受影响：SIPp 失败数
为 0、窗口内无 `unverified`、话单数不少、Worker 无重启，全部由 `verify-load.ts` 核对。

### 压测中停 Worker 1 分钟（验收 6）

正式压测第 15 分钟，在服务器 A：

```sh
ops/loadtest/drill.sh stop-worker --out /tmp/drill-stop-worker \
  --sipp-stats /tmp/loadtest/full-stats.csv
```

脚本先确认 `fs_cli` 可连、Worker 是 active，然后停 `fs-billing-worker`；第 5 秒用
`loopback/<合成号码>/billing` 起一通 120 秒探针（走计费拨号计划，不绕过授权），
接通后读 `uuid_getvar <uuid> execute_on_answer`，期望
`sched_hangup +1800 ALLOTTED_TIMEOUT`；停机满 60 秒后启动 Worker，探针到 120 秒再挂断。
在 B 上运行时，用 `FS_CLI_SSH=<user@A>` 让 `fs_cli` 经 ssh 在 A 上执行（脚本跑
`ssh -- "$FS_CLI_SSH" fs_cli -x "<命令>"`，认证用密钥，命令里没有任何密码）；A 的
防火墙（`ops/firewall/nftables-a.conf`）不对外开放 event socket，所以不能从 B 直连。
不设置 `FS_CLI_SSH` 时脚本直接跑本机 `fs_cli`（操作员就在 A 上时）。时间线、探针变量、
journal 与 SIPp 时段统计都写到 `--out`。退出时无论成败都会把 Worker 拉起来。

停机的 60 秒内约 600 通呼叫的授权连不上 Worker，Lua 按 1800 秒放行并标记未验证；
话单落入 A 的 `retry/`，Worker 恢复后由 `replay-cdr.sh` 补推。补推完成后用
`verify-load.ts --since <压测开始> --until <压测结束> --max-unverified <上限>` 核对：
话单不重不漏、未验证话单照常扣费、`auth_timeout` 告警有开始与恢复通知。
上限按停机时长与到达率估算，写进证据说明，不能为了「通过」随意放大。

### 证据

按 [阶段 10 设计](phase-10-design.md#4-sipp-压测验收-4) 放：

- `docs/evidence/phase-10/loadtest/`：`sipp-stats.csv`、`verify-load.txt`、
  `resources.csv`、`summary.md`。
- `docs/evidence/phase-10/drill-restart-front/`：`timeline.tsv`、`curl.tsv`、
  `unavailable-window.txt`、`journal.txt`、`sipp-window.csv`。
- `docs/evidence/phase-10/drill-stop-worker/`：`timeline.tsv`、
  `probe-execute_on_answer.txt`、`journal.txt`、告警与发件箱查询输出。

证据里不含共享密钥、连接串与真实号码；合成号码可以保留。开发机上的 Docker 低速冒烟
只证明脚本可用，**不是验收证据**，文件名与 `summary.md` 里要写明。

### 压测后重置生产库

顺序（在 B 上，先演练再用于生产）：

1. 停 `fs-billing-api` 与 `fs-billing-worker`，确认没有连接。
2. 做一次 `backup.sh`（万一还要查压测数据）。
3. `dropdb --force fs_billing`（或 `DROP DATABASE ... WITH (FORCE)`），`createdb -O fs_billing fs_billing`。
4. 以 owner 身份 `pnpm db:migrate` 与 `pnpm --filter @fs-billing/worker queue:migrate`。
5. 按上线检查清单建第一个管理员；**不要**跑 `db:seed`。
6. `verify-load.ts` 不应再用于重置后的库；用 `snapshot-counts.sh` 确认话单与流水为 0，
   再启动两个服务。

重置步骤先在测试库演练一次，记录耗时与偏离；正式重置的证据（命令、时间、重置后的行数）
与压测证据放在一起。

## 大表加索引

### 限制

- drizzle migrator 在事务内执行迁移，`CREATE INDEX CONCURRENTLY` 不能在事务里跑。
- 分区表的父表不支持直接 `CREATE INDEX CONCURRENTLY`。
- 所以：父索引用 `CREATE INDEX ... ON ONLY`（只改元数据，可以放在迁移事务里），
  每个分区在事务外并发建索引，最后 `ATTACH PARTITION` 挂到父索引。

### 步骤

以 `0010` 的 `cdrs (tenant_id, started_at)` 为例。

1. **评估**。看分区列表、各分区大小、磁盘余量（索引约占表的 20%–70%）、
   `maintenance_work_mem`，并确认没有长时间运行的事务（`CONCURRENTLY` 会等它们）。

   ```sh
   ops/migrate/concurrent-index.sh --database fs_billing --production \
     --table cdrs --index cdrs_tenant_started_at \
     --columns 'tenant_id, started_at' --dry-run
   ```

   先在演练库上不加 `--production` 试跑；生产库 `fs_billing` 必须显式加
   `--production`，否则脚本拒绝。

2. **父索引**。放进正常迁移（事务内可以，因为不扫数据）：

   ```sql
   CREATE INDEX cdrs_tenant_started_at ON ONLY cdrs (tenant_id, started_at);
   ```

3. **逐分区**。在迁移事务之外，每个分区一条：

   ```sql
   CREATE INDEX CONCURRENTLY cdrs_tenant_started_at_cdrs_2026_10
     ON cdrs_2026_10 (tenant_id, started_at);
   ```

   失败会留下 `indisvalid = false` 的索引；先 `DROP INDEX CONCURRENTLY` 清理再
   重试。脚本在每次失败后自动做这一步。每个分区之间检查
   `pg_stat_activity` 里的长事务。

4. **挂接**：

   ```sql
   ALTER INDEX cdrs_tenant_started_at
     ATTACH PARTITION cdrs_tenant_started_at_cdrs_2026_10;
   ```

   全部分区挂接后父索引自动变为 valid。

5. **验证**：`pg_index.indisvalid` 全为真；`EXPLAIN` 走新索引；
   `pg_stat_user_indexes` 有扫描。

6. **回退**：

   ```sh
   ops/migrate/concurrent-index.sh --database fs_billing --production \
     --table cdrs --index cdrs_tenant_started_at \
     --columns 'tenant_id, started_at' --rollback
   ```

   PostgreSQL 没有 `ALTER INDEX ... DETACH PARTITION`，已挂接的分区索引依赖父索引。
   所以先 `DROP INDEX` 父索引（会一并删除已挂接的分区索引），再对未挂接的残留
   分区索引逐个 `DROP INDEX CONCURRENTLY`。

   **父索引的 `DROP INDEX` 不能 `CONCURRENTLY`**，会拿表与各分区的
   `ACCESS EXCLUSIVE`，短暂阻塞读写，还可能排在长事务后面。脚本给它加
   `lock_timeout = '5s'`，拿不到锁就失败而不是一直等；回退安排在业务低峰执行。

7. **迁移文件怎么写**：drizzle 迁移文件里只放第 2 步（`ON ONLY`），第 3–4 步
   写成运维步骤，并在迁移文件头注释里指向本章。新库（开发、CI、空库）仍能直接
   得到完整索引；新建分区会自动继承父索引，不需要额外处理。

### 演练失败

`concurrent-index.sh --inject-failure <分区名>` 是演练钩子：先故意建一个同名
唯一索引 `((1))`（必然重复），留下 invalid 索引，然后走「检测 invalid →
`DROP INDEX CONCURRENTLY` → 重试」的正常路径。只在演练库使用，不要写进部署流程。
在 `fs_billing` 上一律拒绝，即使加了 `--production`。

`0010` 的迁移头注释已经指向本手册；不要把它改成 CONCURRENTLY，也不要手工在生产
上执行 `CREATE INDEX`（非并发）去替代本流程。

## 备份

### 现状与已知差距

备份暂时只写本机 `/root/backups`（阶段 10 决定 9）：能防误删数据、坏迁移、应用层事故，
**防不了整机丢失**（磁盘损坏、被入侵、误删整个系统）。因此阶段 10 带条件上线：只接入
试用客户，**首个付费客户之前必须有异地备份**。过渡期每周手工拉一份到运维自己的机器，
步骤见下面「每周手工拉取（过渡）」。

备份范围（[阶段 10 设计：备份与恢复](phase-10-design.md#3-备份与恢复验收-3)）：

| 产物                     | 内容                                                          | 说明                                                         |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------ |
| `fs_billing-<时间>.dump` | `pg_dump -Fc` 整库（含 `auth`、`pgboss` 与所有分区）          | 先写 `.partial`，`pg_restore --list` 通过才改名              |
| `globals-<时间>.sql`     | `pg_dumpall --globals-only`，含角色与密码哈希                 | 没有它，恢复到新机器会因 RLS、`SECURITY DEFINER` 属主失败    |
| `archive-<时间>.tar.gz`  | `/var/lib/fs-billing/archive`（原始话单归档）                 | 原始 JSON 丢弃后的**唯一副本**；在库之后拍，保证清单不缺文件 |
| `config-<时间>.tar.gz`   | `/etc/fs-billing`、`/etc/nginx/conf.d`、`/etc/ssl/fs-billing` | 含 nginx 站点与**证书私钥**，异地时必须加密                  |
| `SHA256SUMS-<时间>`      | 以上四个产物的 sha256                                         | `verify-restore.sh` 先校验它                                 |
| `LATEST.json`            | 时间、大小、校验和、`pg_restore --list` 条目数、归档文件统计  | 体检脚本用它判断备份是否新鲜                                 |

目录 700、文件 600。备份里有完整号码与客户资料；不要把它们拷到共享目录、聊天工具或
未加密的磁盘。

### 安装与配置

```sh
install -m 0600 /opt/fs-billing/current/ops/backup/backup.conf.example /etc/fs-billing/backup.conf
$EDITOR /etc/fs-billing/backup.conf
```

配置只写路径（`BACKUP_DIR`、`ARCHIVE_DIR`、`CONFIG_PATHS`、保留天数等）；数据库连接串
从 `/etc/fs-billing/owner.env` 的 `DATABASE_URL` 读取，密码不写进 `backup.conf`。
`BACKUP_DIR` 默认 `/root/backups`，改它时同步改
`ops/backup/systemd/fs-billing-backup.service` 的 `ReadWritePaths`。

安装并启用定时器：

```sh
install -m 0644 /opt/fs-billing/current/ops/backup/systemd/fs-billing-backup.service \
  /opt/fs-billing/current/ops/backup/systemd/fs-billing-backup.timer \
  /opt/fs-billing/current/ops/backup/systemd/fs-billing-backup-verify.service \
  /opt/fs-billing/current/ops/backup/systemd/fs-billing-backup-verify.timer \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fs-billing-backup.timer fs-billing-backup-verify.timer
systemctl list-timers 'fs-billing-*'
```

`fs-billing-backup.timer` 每天北京时间 05:00 运行（避开 00:00 分区维护、02:00 账单、
03:00 核对、04:00 归档）；`fs-billing-backup-verify.timer` 每周日 06:00 做一次恢复演练。
两个 timer 都是 `Persistent=true`，关机错过后开机补跑。失败由
`OnFailure=fs-billing-notify@%n.service` 调用 `notify.sh` 发邮件，配置见「监测与告警」。

### 手动跑一次并核对

```sh
systemctl start fs-billing-backup.service
journalctl -u fs-billing-backup.service -n 50 --no-pager
stat -c '%a %U:%G %n' /root/backups /root/backups/*
jq . /root/backups/LATEST.json
df -h /root/backups /var/lib/fs-billing
```

期望 `LATEST.json` 的 `createdAt` 是刚才，`dump.tocEntries` 大于 0，四个产物的
`bytes` / `sha256` 都有值；目录 700、文件 600。磁盘不足时脚本在开始前就失败，不会写出
半套备份。保留策略按文件名里的 UTC 时间戳删除 30 天前的整套备份，且至少保留最近 3 套。

失败时按顺序查：`owner.env` 是否有 `DATABASE_URL`、PostgreSQL 是否在跑、归档目录是否存在
（不存在脚本会直接失败，不会悄悄跳过）、磁盘余量、异地驱动命令（见
[offsite/README.md](../ops/backup/offsite/README.md)）。

### 异地备份（未启用）

`backup.conf` 的 `OFFSITE_COMMAND` 为空时只存本机。异地目标以后按
[offsite/README.md](../ops/backup/offsite/README.md) 的驱动约定接入：脚本对每个产物调用
一次「命令 + 产物路径」，失败使整次备份退出非零；异地副本必须加密。现在不要为了「先跑通」
随便填一个目标，也不要把真实地址写进仓库。

### 每周手工拉取（过渡）

异地目标到位前，每周由运维从自己的机器拉最近一套备份。下面的 `<B_IP>`、`<本地目录>` 都是
占位符；本地目录放在加密磁盘上，只有运维本人可读。

```sh
# 1. 在工作站看最新一套的时间戳（文件名里的 UTC 时间）
ssh root@<B_IP> 'ls -1t /root/backups/fs_billing-*.dump | head -n 1'

# 2. 拉取整套（库、globals、归档、配置、校验和、LATEST.json）
#    先确认最近的备份已完成：LATEST.json 已更新，且没有 *.partial
ssh root@<B_IP> 'ls -1t /root/backups/fs_billing-*.dump | head -n 1; ls /root/backups/*.partial 2>/dev/null || true'
rsync -a --partial --protect-args \
  root@<B_IP>:/root/backups/ <本地目录>/fs-billing-backups/

# 3. 校验拉下来的产物
cd <本地目录>/fs-billing-backups
sha256sum --check SHA256SUMS-<时间戳>

# 4. 至少保留最近 4 周（4 套），旧的按需删除；不要反过来删服务器上的
ls -1t fs_billing-*.dump | tail -n +5
```

手工拉取同样只解决「机器没了」，不解决「本地磁盘坏了」：本地也至少保留两份不同介质。
每周拉完在运维记录里写日期、时间戳、`sha256sum --check` 的结果与文件大小；拉取失败的
那一周要在下周补齐，并检查服务器上的 `LATEST.json` 是否仍在更新。

## 恢复

恢复会覆盖目标库，先看清楚再执行。默认目标**不是**生产库；生产库必须写出库名并带
`--i-know-this-drops-the-database`。先做一次只读校验：

```sh
ls -1t /root/backups/fs_billing-*.dump | head -n 1
/opt/fs-billing/current/ops/backup/restore.sh --verify
```

`--verify` 把最新备份恢复到临时库 `fs_billing_verify`，用 `snapshot-counts.sh` 核对余额、
流水合计与各表/各分区的行数，检查账本不变量，然后删除临时库。它不碰生产库，可以在服务
运行时做；磁盘上需要能放下第二份库。

完整恢复（示例把生产库 `fs_billing` 恢复到某个时间点）：

```sh
/opt/fs-billing/current/ops/backup/restore.sh --restore \
  --target-db fs_billing \
  --i-know-this-drops-the-database \
  --dump /root/backups/fs_billing-<时间戳>.dump
```

脚本按顺序做：

1. 交互确认（标准输入是终端时要求再输入一次库名）。
2. 停 `fs-billing-api` 与 `fs-billing-worker`；停不下来就中止，不会在服务还连着库时改名。
3. 把现库改名为 `fs_billing_pre_restore_<UTC 时间>`：**改名，不删除**。恢复失败或发现
   备份不对时可以改回来。
4. 导入 `globals-<时间>.sql`（已存在的角色跳过）。
5. `createdb -O fs_billing` 后 `pg_restore --exit-on-error --single-transaction`。
6. 在 `/opt/fs-billing/current` 里以 owner 身份跑 `pnpm db:migrate` 与
   `pnpm --filter @fs-billing/worker queue:migrate`：重设两个登录角色的密码、补建当月
   与下月分区、安装 pg-boss 队列（幂等）。
7. 把 `archive-<时间>.tar.gz` 解回 `/var/lib/fs-billing/archive`。
8. 启动两个服务并做 `/api/health` 与 Worker `/health` 检查。

恢复成功后：

```sh
systemctl status fs-billing-api fs-billing-worker
/opt/fs-billing/current/ops/backup/snapshot-counts.sh | head -n 20
ls -l /var/lib/fs-billing/archive
```

临时查库用 `snapshot-counts.sh` 或应用自己的只读脚本；不要把 owner 连接串写在
`psql` 的命令行上（会出现在进程列表里）。

确认数据无误后再手工删除 `fs_billing_pre_restore_<时间>`（删除前先做一次新的
`backup.sh`）。恢复失败时旧库仍在，脚本不会启动服务；按输出的提示修好后重跑，或把旧库
改名回来。

证书与配置不从 `restore.sh` 自动解包；需要时手工恢复（含秘密，仅 root）：

```sh
tar -xzf /root/backups/config-<时间戳>.tar.gz -C /
systemctl restart nginx fs-billing-api fs-billing-worker
```

### 恢复后补推

备份时刻到事故时刻之间的话单不在库里。服务器 A 的 `/var/lib/freeswitch/cdr/archive/`
保留了推送过的话单副本：把备份时刻之后的文件拷进 A 的 `retry/`，`replay-cdr.sh` 每分钟
补推；Worker 按通话 UUID 去重，已存在的话单不会重复扣费。RPO 因此是「24 小时，且在 A 的
副本还在时可补回」（决定 10）。A 上副本的保留期见 FreeSWITCH 侧配置，不要把它当永久备份。

## 恢复演练

### 每周自动演练

`fs-billing-backup-verify.timer` 每周日 06:00 调用 `verify-restore.sh`：先按
`SHA256SUMS-<时间>` 校验最近一套的四个产物，再走 `restore.sh --verify` 的完整恢复与
快照核对，最后删除临时库。查看结果：

```sh
systemctl list-timers fs-billing-backup-verify.timer
systemctl status fs-billing-backup-verify.service
journalctl -u fs-billing-backup-verify.service --since '8 days ago' --no-pager
ls -l /root/backups/LATEST.json
```

失败会在 `systemctl status` 里显示非零退出码，同时由 `fs-billing-notify@.service` 发邮件。
每周自动演练
只证明「备份能恢复、数量与余额对得上、归档包能完整读出」；它**不**把归档目录解回，
也不覆盖服务器 A 的补推，不替代下面的人工演练。

### 每季度完整演练

阶段 10 的设计要求每季度做一次完整的删库恢复；正式证据在服务器 B 上取得（测试服务器上的
演练要先得到用户同意）。演练会产生停机，放在维护窗口：

1. 停 Worker 与 API，让数据静止：`systemctl stop fs-billing-worker fs-billing-api`。
2. `/opt/fs-billing/current/ops/backup/backup.sh`，记下时间戳。
3. `/opt/fs-billing/current/ops/backup/snapshot-counts.sh > before.txt`。
4. `/opt/fs-billing/current/ops/backup/restore.sh --restore --target-db fs_billing \
--i-know-this-drops-the-database --dump /root/backups/fs_billing-<时间戳>.dump`；
   脚本把原库改名为 `fs_billing_pre_restore_<时间>`，效果等同「删库后恢复」，但可回退。
5. `snapshot-counts.sh > after.txt`。
6. `diff before.txt after.txt` 必须为空；再用一次「恢复后补推」把演练窗口内的话单补回。
7. 启动两个服务，`curl` 两个 `/health`；确认 Worker 起来后没有新增异常告警。
8. 观察一两天后删除 `fs_billing_pre_restore_<时间>`。

证据存 `docs/evidence/phase-10/backup-restore/`：`backup-run.txt`、`before.txt`、
`after.txt`、`diff.txt`、`restore-run.txt`、`weekly-verify.txt`。**不放备份文件本身，
不放密码**；快照里有租户编码与余额，按内部资料对待。

## 日志与隐私

### 配置与生效

journald 配置在 [ops/journald/fs-billing.conf](../ops/journald/fs-billing.conf)，安装到
`/etc/systemd/journald.conf.d/fs-billing.conf`。`bootstrap-server.sh` 会装好并重启
`systemd-journald`。关键项：

| 项                | 值         | 作用                                                 |
| ----------------- | ---------- | ---------------------------------------------------- |
| `Storage`         | persistent | 日志落盘到 `/var/log/journal`，重启后保留            |
| `MaxRetentionSec` | 14day      | 删除最老条目已超过 14 天的 journal 文件              |
| `MaxFileSec`      | 1day       | 按天轮换，`MaxRetentionSec` 才能精确到约 14 天（G7） |
| `SystemMaxUse`    | 2G         | 磁盘保护；按数据量调整，并纳入磁盘告警               |
| `ForwardTo*`      | no         | 不转发 syslog、kmsg、console、wall                   |

核对：

```sh
systemd-analyze cat-config systemd/journald.conf
journalctl --disk-usage
stat -c '%a %U:%G' /var/log/journal
getent group systemd-journal
runuser -u fs-billing -- journalctl -n1   # 期望权限不足
systemctl list-unit-files | grep -Ei 'rsyslog|promtail|vector|fluent'   # 期望为空
ss -tnp | grep -Ei 'rsyslog|promtail|vector|fluent' || true            # 期望无日志外发连接
```

`/var/log/journal` 应为 `2750 root:systemd-journal`；运维账号加入
`systemd-journal` 组，`fs-billing` 服务用户不加入。部署满 14 天后补一次：

```sh
journalctl --since '15 days ago' --no-pager | head -1
```

最早条目不应早于约 14 天前（按天轮换允许一天误差）。抽样检查日志里没有明文号码：

```sh
journalctl -u fs-billing-worker --since today | grep -E '[0-9]{8,}'
```

只允许 UUID 与掩码形式；完整规则见
[开发环境：Worker 日志与脱敏](development.md#worker-日志与脱敏阶段-9)。

### 常用命令

```sh
journalctl -u fs-billing-api -u fs-billing-worker --since '1 hour ago'
journalctl -u fs-billing-worker -f
journalctl -u fs-billing-api --since today --no-pager | tail -n 200
journalctl --vacuum-time=14d          # 手工清理（先确认保留要求）
```

systemd 单元的标准输出与标准错误都进 journal；不要另外配置文件日志。

### 已知风险：nginx 与 PostgreSQL 文件日志

按阶段 10 决定 6，nginx 与 PostgreSQL 的文件日志保持 Debian 默认，不纳入本手册的
14 天保留：

- nginx 默认访问日志记录完整请求行，包括查询串；话单搜索的 `callee`、导出参数里
  是客户号码。`/var/log/nginx/access.log`、`error.log` 由 Debian 的 logrotate 默认保留
  14 份，权限 `640 www-data:adm`。不要通过日志排查号码，改用数据库与后台。
- PostgreSQL 日志在 `/var/log/postgresql/`，logrotate 默认保留 10 周。**不要开启会
  记录绑定参数的慢查询日志**；开启与否记入上线检查清单的「带条件上线」栏。

这两项是用户接受的已知风险，改动前先评审。

## 监测与告警

### 组成

| 位置 | 单元 / 文件                          | 做什么                                                                                                            |
| ---- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| B    | `fs-billing-health-check.timer`      | 每分钟检查 Worker `/health`、API `/api/health`、PostgreSQL、`LATEST.json` 新鲜度、磁盘、证书、journal；失败发邮件 |
| B    | `fs-billing-check-clock.timer`       | 每分钟读 `chronyc tracking` 的 System time；偏差 ≥1 秒警告、≥5 秒严重（决定 3），未同步也告警                     |
| B    | `fs-billing-notify@.service`         | 模板单元；备份等单元失败时由 `OnFailure=` 调用 `notify.sh`，附带 `systemctl status` 与最近 40 行 journal          |
| A    | `fs-billing-clock-heartbeat.timer`   | 每 30 秒 POST 到 B 的 Worker `/clock`，带 `sentAt`、上一轮 RTT、A 的 chrony 偏移与同步状态                        |
| 两台 | `/etc/chrony/conf.d/fs-billing.conf` | 至少 3 个时间源；公网 NTP 被屏蔽时换成机房提供的源（用户提供）                                                    |

Worker 的 `/clock` 用数据库时钟 `clock_timestamp()` 算 `skew = 收到时间 − sentAt − RTT/2`，
正数表示 A 比数据库慢。偏差 ≥1 秒开 `clock_skew` 告警（警告），≥5 秒另开一条
`clock_skew_critical`（严重），各发一封开始通知；回到阈值内并持续 `ALERT_QUIET_MINUTES`
（默认 10 分钟）后，由后续心跳分别恢复：严重在偏差回到 5 秒内满窗口后恢复，警告在回到
1 秒内满窗口后恢复。
心跳超过 5 分钟没到时开 `fs_heartbeat`，下一次心跳到达时恢复。心跳不落新表；Worker
重启不会误报，也不会丢掉已开告警的恢复。三种告警都进后台「系统告警」页、概览计数与
邮件通道，收件邮箱沿用后台「告警设置」。

服务器 A 到位前，Worker 每次启动约 5 分钟后会开 `fs_heartbeat` 并保持未恢复（只发一封
开始通知，后续合并）；这是 A 尚未安装时的预期现象，A 的第一次心跳到达后自动恢复。
`clock_skew` 与 `clock_skew_critical` 是两条独立告警：从警告升级到严重会新开严重告警并发
一封开始通知，警告仍按 1 秒阈值判断；偏差回落到 3 秒时，严重告警在静默窗口后单独恢复，
警告保持未恢复直到回到 1 秒内满一个窗口。

### 安装

B 上（代码已经发布到 `/opt/fs-billing/current` 之后）：

```sh
install -m 0644 /opt/fs-billing/current/ops/monitor/systemd/fs-billing-notify@.service \
  /opt/fs-billing/current/ops/monitor/systemd/fs-billing-health-check.service \
  /opt/fs-billing/current/ops/monitor/systemd/fs-billing-health-check.timer \
  /opt/fs-billing/current/ops/monitor/systemd/fs-billing-check-clock.service \
  /opt/fs-billing/current/ops/monitor/systemd/fs-billing-check-clock.timer \
  /etc/systemd/system/
install -m 0600 /opt/fs-billing/current/ops/monitor/monitor.env.example /etc/fs-billing/monitor.env
$EDITOR /etc/fs-billing/monitor.env       # 至少填 NOTIFY_TO
systemctl daemon-reload
systemctl enable --now fs-billing-health-check.timer fs-billing-check-clock.timer
systemctl list-timers 'fs-billing-*'
```

`monitor.env` 里 `NOTIFY_TO` 是脚本侧的运维收件人。它不能从后台「告警设置」读：数据库或
Worker 整体宕机时正是最需要发信的时候，脚本只能读本机文件。可以填同一个邮箱，多个用逗号
分隔。`SMTP_*` 与 `MAIL_FROM` 仍从 `/etc/fs-billing/app.env` 读取，`SMTP_PASS` 只放在那里。
`notify.sh` 用 `curl` 的 SMTPS 支持发信（Debian 包 `curl`，已在
`bootstrap-server.sh` 的安装列表里），不需要 `sendmail` 或额外邮件包。

先手动发一封确认通道：

```sh
/opt/fs-billing/current/ops/monitor/notify.sh \
  --subject '【FS-Billing】通知测试' \
  --body '这是一封运维通知测试。'
```

A 是 FreeSWITCH 机器，没有 `/opt/fs-billing/current`；脚本、单元与示例从工作站仓库拷过去。
在工作站仓库根执行：

```sh
scp ops/monitor/fs-clock-heartbeat.sh \
  ops/monitor/heartbeat.env.example \
  ops/monitor/systemd/fs-billing-clock-heartbeat.service \
  ops/monitor/systemd/fs-billing-clock-heartbeat.timer \
  root@<A_IP>:/tmp/
```

再在 A 上安装：

```sh
install -d -m 0755 /usr/local/lib/fs-billing
install -m 0755 /tmp/fs-clock-heartbeat.sh /usr/local/lib/fs-billing/fs-clock-heartbeat.sh
install -d -m 0700 /etc/fs-billing
install -m 0600 /tmp/heartbeat.env.example /etc/fs-billing/heartbeat.env
$EDITOR /etc/fs-billing/heartbeat.env     # WORKER_SHARED_KEY 与 B 的 app.env 一致
install -m 0644 /tmp/fs-billing-clock-heartbeat.service \
  /tmp/fs-billing-clock-heartbeat.timer \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fs-billing-clock-heartbeat.timer
```

A 的 `curl` 已由 `freeswitch/install/install.sh` 安装；还需要 `jq` 与 `chrony`：

```sh
apt-get install -y jq chrony
```

两台都安装 chrony 片段后重启 chrony。B 上：

```sh
install -d -m 0755 /etc/chrony/conf.d
install -m 0644 /opt/fs-billing/current/ops/monitor/chrony/fs-billing.conf \
  /etc/chrony/conf.d/fs-billing.conf
systemctl restart chrony
chronyc tracking
```

A 上同样没有 `/opt/fs-billing/current`，先从工作站把文件拷过去：

```sh
# 工作站仓库根
scp ops/monitor/chrony/fs-billing.conf root@<A_IP>:/tmp/
```

再在 A 上安装并重启：

```sh
# A
install -d -m 0755 /etc/chrony/conf.d
install -m 0644 /tmp/fs-billing.conf /etc/chrony/conf.d/fs-billing.conf
systemctl restart chrony
chronyc tracking
```

默认源是 Debian 的公网 NTP 池；机房屏蔽公网 NTP 时，把文件里的 `pool` 行换成机房提供的
至少 3 个源（地址由用户提供，不写进仓库）。`chronyc tracking` 的 `Leap status` 应为
`Normal`。

### 每次体检看什么

`health-check.sh` 的检查项与阈值都能在 `monitor.env` 覆盖：

| 检查         | 失败条件                                                                       |
| ------------ | ------------------------------------------------------------------------------ |
| Worker / API | `curl` 失败或响应不是 `{"status":"ok",...}`                                    |
| PostgreSQL   | `pg_isready -q` 非零                                                           |
| 备份新鲜度   | `/root/backups/LATEST.json` 不存在或超过 26 小时未更新                         |
| 磁盘         | `/`、`/var/lib/fs-billing`、`/root/backups` 使用率 ≥90%（`DISK_WARN_PERCENT`） |
| 证书         | `/etc/ssl/fs-billing/fullchain.pem` 剩余少于 30 天（`CERT_WARN_DAYS`）         |
| journal      | `/var/log/journal` 占用 ≥2G 的 90%（`JOURNAL_WARN_BYTES`）                     |

同一问题 30 分钟内只发一封邮件（`MONITOR_DEDUPE_SECONDS`），状态文件在
`/var/lib/fs-billing/monitor`。检查失败时脚本以非零退出，`systemctl status` 与
`journalctl` 都能看到；恢复后状态文件自动清除。

### 查看与演示

```sh
systemctl list-timers 'fs-billing-*'
journalctl -u fs-billing-health-check -u fs-billing-check-clock --since today --no-pager
journalctl -u fs-billing-clock-heartbeat --since today --no-pager   # 在 A 上
```

后台「系统告警」页按类型筛选 `时钟偏差（警告）`（`clock_skew`）、`时钟偏差（严重）`
（`clock_skew_critical`）与 `时钟心跳中断`（`fs_heartbeat`）；概览的「系统告警」计数与导航
红点复用同一套查询。邮件开始、汇总、恢复通知由 Worker 的 `notify-tick` 发出，发件箱状态见
告警详情。

验收 8 的偏差演示要在服务器 A 上做（需要 A 到位）：

```sh
# A：停 chrony，把本机拨快 10 秒，等一个心跳周期（30 秒）
systemctl stop chrony
date -s '+10 seconds'
journalctl -u fs-billing-clock-heartbeat -n 20 --no-pager

# B：告警页出现 clock_skew（警告）与 clock_skew_critical（严重），两封开始通知应发出
# A：恢复并强制校时
systemctl start chrony
chronyc makestep
```

恢复后，回到阈值内满一个静默窗口，下一次心跳分别把 `clock_skew` 与 `clock_skew_critical`
置为已恢复，并发出恢复邮件。
截图与两台的 `chronyc tracking` 输出存 `docs/evidence/phase-10/ntp/`；**不要在演示中把
真实地址或密钥写进证据**。

### 常见故障

| 症状                                              | 检查                                                                                         | 处理                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 收不到任何运维邮件                                | `notify.sh --subject 测试`；`app.env` 的 `SMTP_*`、`MAIL_FROM`、`monitor.env` 的 `NOTIFY_TO` | 补全配置；QQ 邮箱的 `MAIL_FROM` 必须等于 `SMTP_USER`；查 `journalctl -u fs-billing-notify@...` |
| A 的心跳在 B 上不到                               | A 的 `heartbeat.env`、B 的 `WORKER_ALLOWED_IPS`、防火墙 3001、`WORKER_SHARED_KEY`            | 修通后等下一次 `/clock`，`fs_heartbeat` 自动恢复                                               |
| 告警页一直有 `clock_skew` / `clock_skew_critical` | 两台 `chronyc tracking` 的 System time；A 是否刚做过 `date -s`                               | `chronyc makestep`；偏差回到阈值内满静默窗口后自动恢复                                         |
| `check-clock.sh` 报 chrony 未同步                 | `chronyc sources -v`、NTP 源是否可达                                                         | 修 NTP 源后 `systemctl restart chrony`；未同步期间告警保持                                     |
| 体检每分钟都失败但只收到一封邮件                  | 这是 30 分钟去重；`MONITOR_DEDUPE_SECONDS` 可调                                              | 先修问题；恢复后状态文件自动清除                                                               |

## 证书

### 当前：自签证书

`bootstrap-server.sh` 生成 `/etc/ssl/fs-billing/fullchain.pem` 与
`privkey.pem`，SAN 为 B 的公网 IP，有效期 1 年。nginx 在 443 使用它，80 跳转 443。

指纹写进交付信息，供客户在浏览器里核对：

```sh
openssl x509 -in /etc/ssl/fs-billing/fullchain.pem -noout -fingerprint -sha256
openssl x509 -in /etc/ssl/fs-billing/fullchain.pem -noout -subject -dates -ext subjectAltName
```

浏览器会对所有访问者显示证书警告；此阶段客户门户可以使用（决定 4），但警告与
域名切换导致会话失效都登记在上线检查清单的「带条件上线」栏。续期或重签后指纹会变，
要重新发给客户。

### 域名到位后：certbot

前置：域名 A 记录指向 `<B_IP>`；80/443 对公网开放；nginx 正常。

```sh
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d <DOMAIN>
systemctl list-timers certbot.timer
certbot renew --dry-run
```

`certbot --nginx` 用 HTTP-01 校验并改写 nginx 配置；确认 `certbot.timer` 已启用。
续期后需要 `systemctl reload nginx`，插件默认会处理；可在
`/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` 放一个 `systemctl reload nginx`
作为兜底。

证书生效后改 `app.env` 的三处地址并重启两个服务：

```sh
BETTER_AUTH_URL=https://<DOMAIN>
BETTER_AUTH_TRUSTED_ORIGINS=https://<DOMAIN>
APP_PUBLIC_URL=https://<DOMAIN>
systemctl restart fs-billing-api fs-billing-worker
```

**所有用户的会话因 cookie 域变化而失效，需要重新登录。** 确认证书正常后再开 HSTS；
自签阶段不要开，否则浏览器会被锁在错误证书上。

续期 `--dry-run` 输出与 `certbot certificates` 存
`docs/evidence/phase-10/certbot/`（需域名，暂不在验收范围）。
