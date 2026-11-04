# 迁移演练结果

- 机器：开发机（macOS 笔记本，非服务器 B）
- PostgreSQL：PostgreSQL 17.9 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
- 数据来源：db:fsb_rehearse_0003
- 目标迁移：0024_suspended_at
- 临时库：fs_billing_rehearse（演练后删除）
- cdrs 行数：3000000
- 数据库大小：1947 MB
- maintenance_work_mem：64MB
- 写入探针：每 50ms 一次（插入 cdrs 后回滚），样本 144 个；最大延迟 2105.8 ms
- 探针 ≥500ms 的样本：2 个，最长 2105.8 ms
- 迁移总耗时：6563 ms（不含数据准备）
- 部署窗口估算：6563 ms 迁移 + 服务重启与健康检查（按 30s 重启 + 10s 检查估算）≈ 46.6 秒

锁采样间隔 100ms；「持锁跨度」是同一迁移事务下该锁模式的首末采样间隔，
因为锁一直持有到提交，它约等于该文件的墙钟耗时。

| 迁移                            | 墙钟 (ms) | 最强锁              | 持锁跨度 (ms) | 锁行数 |
| ------------------------------- | --------: | ------------------- | ------------: | -----: |
| 0004_billing_number_not_null    |      4093 | AccessExclusiveLock |          2100 |    369 |
| 0005_auth                       |        65 | （未采到）          |             - |      0 |
| 0006_admin_receivables          |        67 | （未采到）          |             - |      0 |
| 0007_auth_credentials           |        51 | （未采到）          |             - |      0 |
| 0008_auth_insert_user           |        50 | （未采到）          |             - |      0 |
| 0009_auth_credential_validation |        58 | （未采到）          |             - |      0 |
| 0010_cdrs_tenant_started_at     |       975 | AccessExclusiveLock |           827 |     84 |
| 0011_admin_rate_previews        |        59 | （未采到）          |             - |      0 |
| 0012_receivable_guards          |        62 | （未采到）          |             - |      0 |
| 0013_admin_email_lookup         |        49 | （未采到）          |             - |      0 |
| 0014_audit_reader               |       101 | （未采到）          |             - |      0 |
| 0015_rls_initplan               |       101 | AccessExclusiveLock |             0 |      1 |
| 0016_rate_list_iso_description  |       351 | AccessExclusiveLock |           196 |     51 |
| 0017_monthly_statements         |        59 | （未采到）          |             - |      0 |
| 0018_cdr_operations             |        84 | （未采到）          |             - |      0 |
| 0019_raw_cdr_archives           |        57 | （未采到）          |             - |      0 |
| 0020_system_alerts              |        57 | （未采到）          |             - |      0 |
| 0021_email_outbox               |        59 | （未采到）          |             - |      0 |
| 0022_alert_settings             |        51 | （未采到）          |             - |      0 |
| 0023_balance_notices            |        60 | （未采到）          |             - |      0 |
| 0024_suspended_at               |        54 | （未采到）          |             - |      0 |

## 说明

- 本结果是开发机上的演练，不是服务器 B 的基线；上线后在 B 上用生产备份重做一次。
- 原型数据使用合成号码；本文件不含电话号码、密钥或连接串。
- 探针与锁采样都是抽样，短于采样间隔的锁可能只被记录一次或不出现。
- 默认模式按文件分事务计时；真实 migrator 把本轮所有待执行迁移放在同一个事务里，有多个待执行迁移时实际持锁时长是整批的时长，下面的每文件数字会低估阻塞，部署前应再用 `--batch` 量一次。
