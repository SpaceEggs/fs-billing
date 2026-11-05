# 上线检查清单

上线前逐项核对。全部勾选，或在「带条件上线」栏登记并写明解除条件后，才可以放行。
命令里的 `<B_IP>`、`<A_IP>`、`<SHA>`、`<邮箱>` 都是占位符，执行时替换为实际值；
仓库、文档与截图里不写真实地址、密钥和密码。操作细节与证据位置见
[运维手册](ops-runbook.md)，验收口径见[阶段 10 设计](phase-10-design.md)。

## 前置

- [ ] `ops/checks/require-fs-e2e.sh <实际发布提交的 40 位 SHA>` 通过（`status=passed` 且 15/15，不接受 `a83d190` 的旧运行，见[验收 13 证据](evidence/phase-10/fs-e2e/README.md)）。
- [ ] [plan 阶段 10](plan.md#阶段-10部署与上线) 的 14 条验收已逐项勾选，或在「带条件上线」栏登记了豁免与解除条件。
- [ ] 实际发布提交上的 CI 全绿，本地或 CI 的 `pnpm check` 通过。
- [ ] 实际部署的就是受检提交：`cat /opt/fs-billing/current/DEPLOYED_COMMIT` 等于 `<发布 SHA>`（发布目录由 `git ls-files` 打包，没有 `.git`，不能用 `git rev-parse`）。

## 机器

- [ ] Debian 13 已更新并重启过（`apt-get update && apt-get full-upgrade`，`uname -r` 与 `systemctl --failed` 正常）。
- [ ] 两台服务器的 `chronyc tracking` 都是 `Leap status: Normal`，B 的 `System time` 偏差小于 1 秒（见[监测与告警](ops-runbook.md#监测与告警)）。
- [ ] nftables 已加载，外部主机执行 `ops/firewall/verify-ports.sh external <B_IP>` 时 3001、5432、3000 全部拒绝或超时。
- [ ] 从服务器 A 执行 `WORKER_SHARED_KEY='<与 app.env 一致>' ops/firewall/verify-ports.sh from-a <B_WORKER_IP>`，`/health` 与带密钥的 `/authorize` 都返回 200（见[端口验证](ops-runbook.md#端口验证)）。
- [ ] SSH 仅密钥登录且 22 端口按来源限速（`sshd -T | grep -E 'passwordauthentication|permitrootlogin'`，规则见 `ops/firewall/nftables-b.conf`）。
- [ ] journald 配置已生效：`systemd-analyze cat-config systemd/journald.conf` 含 `MaxRetentionSec=14day` 与 `MaxFileSec=1day`，`/var/log/journal` 为 `2750 root:systemd-journal`。
- [ ] 磁盘余量足够（`df -h / /var/lib/fs-billing /root/backups`），三个挂载点都在 `health-check.sh` 的 90% 告警线以下。
- [ ] 没有开启 PostgreSQL 慢查询日志（`SHOW log_min_duration_statement` 为 `-1`），避免绑定参数把号码写进 `/var/log/postgresql`，见[已知风险](ops-runbook.md#已知风险nginx-与-postgresql-文件日志)。

## 服务

- [ ] `/etc/fs-billing/app.env` 为 `640 root:fs-billing`、`owner.env` 为 `600 root:root`，`app.env` 没有 owner `DATABASE_URL`（见[核对环境文件](ops-runbook.md#2-核对环境文件)）。
- [ ] 两份 env 没有测试键：`grep -nE '^(AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX|FSB_ALLOW_TEST_OVERRIDES|SEED_AUTH_PASSWORD|PERF_|P4_IDOR_)' /etc/fs-billing/*.env` 没有输出。
- [ ] `systemctl is-enabled fs-billing-api fs-billing-worker` 都是 `enabled`，`systemctl status` 都是 `active (running)`。
- [ ] 两个健康检查都返回 `{"status":"ok",...}`：`curl --noproxy "*" -fsS http://127.0.0.1:3000/api/health` 与 `curl --noproxy "*" -fsS http://<WORKER_HOST>:3001/health`。
- [ ] 迁移之后已重跑 `pnpm --filter @fs-billing/worker queue:migrate`（`deploy.sh` 会自动跑；手工发布不要漏）。
- [ ] `RAW_CDR_ARCHIVE_DIR=/var/lib/fs-billing/archive` 已设置且可写：`runuser -u fs-billing -- test -w /var/lib/fs-billing/archive`。
- [ ] `pnpm --filter @fs-billing/worker mail:test -- --to <运维邮箱>` 成功，后台「告警设置」的系统告警接收邮箱也已填好（与 `monitor.env` 的 `NOTIFY_TO` 是两处配置，见[监测与告警](ops-runbook.md#监测与告警)）。
- [ ] `app.env` 已配置 `SETTINGS_ENCRYPTION_KEY`（`openssl rand -base64 32`）并在离线介质保存一份；丢失后需要到页面重填 SMTP 密码（见[邮箱设置](ops-runbook.md#邮箱设置)）。
- [ ] 后台「系统告警 → 邮箱设置」已保存，并在页面与 `notify.sh` 各发过一封测试邮件、确认真的收到（页面与监测脚本是两处配置，见[邮箱设置](ops-runbook.md#邮箱设置)）。

## 数据

- [ ] 生产库已重置：压测数据已清，停服务后按[压测后重置生产库](ops-runbook.md#压测后重置生产库)的步骤重建并迁移，`snapshot-counts.sh` 显示话单与流水为 0。
- [ ] 第一个管理员已创建并完成首次改密：`set -a; . /etc/fs-billing/owner.env; set +a; pnpm --filter @fs-billing/api admin:create --email <邮箱> --name <姓名>`（**参数前不加 `--`**），临时密码只交给本人。
- [ ] 没有跑 `db:seed`（账本只增不改，演示租户与余额清不掉）。
- [ ] 第一个客户租户的编码与服务器 A 的 `billing_tenant` 一致：A 上提取、B 上比对，没有「只在 FreeSWITCH」项（命令与判读见[上线核对](ops-runbook.md#上线核对)）。
- [ ] 国内费率前缀都带 `86`：上一条生成的 `prefix-check.txt` 为空，或列出的国际前缀已逐条核对（SQL 见 [freeswitch.md §3.3](freeswitch.md#33-号码格式)）。

## 备份

- [ ] `/opt/fs-billing/current/ops/backup/backup.sh` 手动跑通，`journalctl -u fs-billing-backup.service -n 50` 无错误，`jq . /root/backups/LATEST.json` 的 `createdAt` 是刚才、`dump.tocEntries` 大于 0（见[手动跑一次并核对](ops-runbook.md#手动跑一次并核对)）。
- [ ] 备份目录 700、文件 600，四个产物与 `SHA256SUMS` 都在，`LATEST.json` 里的 `sha256` 有值。
- [ ] 恢复演练已做：`/opt/fs-billing/current/ops/backup/restore.sh --verify` 通过，或按[每季度完整演练](ops-runbook.md#每季度完整演练)做过一次 `before.txt` / `after.txt` 比对且 `diff` 为空。
- [ ] 异地备份的现状已登记：当前只有本机 `/root/backups`，按「带条件上线」第 ① 项处理（首个付费客户之前必须有异地备份）。
- [ ] 配置备份包含 `/etc/fs-billing`、nginx 与证书私钥；备份落到仓库或共享目录之前已确认加密与访问权限。

## 监测

- [ ] `systemctl list-timers 'fs-billing-*'` 能看到 `fs-billing-health-check.timer`、`fs-billing-check-clock.timer`、`fs-billing-backup.timer`、`fs-billing-backup-verify.timer`，且下一次触发时间正常。
- [ ] `monitor.env` 的 `NOTIFY_TO` 已填并手动发过一封：`/opt/fs-billing/current/ops/monitor/notify.sh --subject '【FS-Billing】上线通知测试' --body '...'`；它与后台「告警设置」互不读取，两处都要配。
- [ ] 时钟偏差告警已按[查看与演示](ops-runbook.md#查看与演示)在 A 上演示过，告警页出现 `clock_skew` / `clock_skew_critical` 并收到开始与恢复邮件。
- [ ] `fs_heartbeat` 已恢复：A 的第一条心跳到达后，后台「系统告警」里该告警应为已恢复；上线时仍开着就不算完成（A 未到位时 Worker 启动约 5 分钟后会开这条告警）。
- [ ] 压测期间已在服务器 B 上实测扣费队列速率（`sample-resources.sh` 的 pg-boss 积压与静置时间），没有套用 `docs/perf/charge-queue.md` 的笔记本数字。
- [ ] 「B 之外」的外部存活探测暂不做，已按「带条件上线」第 ③ 项登记。

## 回滚

- [ ] `rollback.sh` 已演练过一次：`rollback.sh --list` 能看到最近 3 个 release，切回后两个服务健康（见[回滚](ops-runbook.md#回滚)）。
- [ ] 迁移门禁已执行：每个触及大表的新迁移都附了 `ops/migrate/rehearse.sh` 的演练结果，空库首发的 `0000`–`0024` 已注明不适用。
- [ ] 本次发布若有多条待执行迁移且触及 `cdrs` 或 `tenants`，已用 `rehearse.sh --batch` 量过整批锁时长，并安排在业务低峰发布；批次可能与线上流量死锁，证据见 [batch 汇总](evidence/phase-10/migration-rehearsal/batch/summary.md)。
- [ ] 回滚目标在 `deploy.sh` 保留的最近 3 个 release 之内，且旧代码与新 schema 兼容至少一个版本。

## FreeSWITCH（服务器 A）

- [ ] `WORKER_SHARED_KEY` 在四处一致：B 的 `app.env`、A 的 `vars.xml` 的 `billing_shared_key`、A 的 nginx relay `X-Billing-Key`、A 的 `heartbeat.env`；改一处必须同时改其余三处（见[密钥轮换](ops-runbook.md#密钥轮换)）。
- [ ] 每个租户都设了并发上限（`limit hash tenant <编码> <数量>`），且与后台租户配置相符。
- [ ] Worker 超时放行路径已验证：停 Worker 后新呼叫按 1800 秒放行并标记未验证，恢复后补推不重复（验收 6 的演练记录）。
- [ ] `replay-cdr.sh` 的定时器已启用，`/var/lib/freeswitch/cdr/retry/` 在补推后为空。
- [ ] A 的 `chronyc tracking` 正常，且 A 到 B 的 3001 只走内网或 WireGuard，不暴露公网。
- [ ] A 上的 `billing_tenant` 清单已保存并用于「数据」一节的核对；A 的配置备份与保留期已知（`retry/`、`archive/` 不是永久备份）。

## 带条件上线

以下四项是阶段 10 已登记的差距，不因本清单勾选而消失。每项写清解除条件；未解除期间
只接入试用客户，并在运维记录里保留登记。

| #   | 已登记的差距                                                                                                       | 怎么解除                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 异地备份缺失：当前只存本机 `/root/backups`，只接入试用客户，首个付费客户之前必须有异地备份；过渡期每周手工拉取一份 | 异地目标到位并通过一次恢复校验，或首个付费客户签约前完成首次异地恢复演练；过渡期按[每周手工拉取](ops-runbook.md#每周手工拉取过渡)执行并记录校验和。 |
| ②   | 证书为自签而客户已可使用门户（决定 4）                                                                             | 域名 A 记录指向 B 后执行 [certbot](ops-runbook.md#域名到位后certbot)，确认自动续期并把新指纹发给客户；切换会让所有会话失效，需提前通知。            |
| ③   | 没有 B 整机宕机的外部探测（决定 2）                                                                                | 补做 B 之外的外部探测（第三方监测或用户自己机器上的定时 `curl https://<地址>/api/health`）；未做期间不覆盖整机宕机、网络不通与 nginx 挂掉。         |
| ④   | nginx 与 PostgreSQL 日志保持 Debian 默认（决定 6，已知风险）                                                       | 本阶段不解除；用户接受该风险。若要收紧，先评审并改 nginx/PostgreSQL 的日志与保留期，再重跑[日志与隐私](ops-runbook.md#日志与隐私)的核对。           |
