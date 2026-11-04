# 运维手册

本手册面向在生产服务器 B（Debian 13）上执行部署与排障的人。命令中的
`<B_IP>`、`<A_IP>`、`<B_PRIVATE_IP>`、`<DOMAIN>` 都是占位符，执行时替换为实际值；
仓库、文档和截图里不写真实地址与密钥。

当前版本只含「部署」「回滚」「日志与隐私」「证书」四章。备份与恢复、监测与告警、
迁移演练、大表加索引、密钥轮换等章节由后续 PR 增补；上线前以上线检查清单收口
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
