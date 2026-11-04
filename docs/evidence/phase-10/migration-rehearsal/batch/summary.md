# 迁移演练结果

- 机器：开发机（macOS 笔记本，隔离实例，非服务器 B）
- PostgreSQL：PostgreSQL 17.9 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
- 数据来源：db:fsb_rehearse_0003
- 目标迁移：0024_suspended_at
- 临时库：fs_billing_rehearse（演练后删除）
- cdrs 行数：3000000
- 数据库大小：1947 MB
- maintenance_work_mem：64MB
- 写入探针：每 50ms 一次（插入 cdrs 后回滚），样本 82 个；最大延迟 3566.3 ms
- 探针 ≥500ms 的样本：1 个，最长 3566.3 ms
- 迁移总耗时：5650 ms（不含数据准备）
- 部署窗口估算：5650 ms 迁移 + 服务重启与健康检查（按 30s 重启 + 10s 检查估算）≈ 45.6 秒

本模式与真实 drizzle migrator 一致：本轮 21 个待执行迁移放在同一个事务里，
锁一直持有到整批提交，所以总墙钟就是这一批的持锁时长。

| 迁移范围                                         | 条数 | 总墙钟 (ms) | 最强锁              | 持锁跨度 (ms) | 探针最大 (ms) | 探针 ≥500ms            |
| ------------------------------------------------ | ---: | ----------: | ------------------- | ------------: | ------------: | ---------------------- |
| 0004_billing_number_not_null → 0024_suspended_at |   21 |        5650 | AccessExclusiveLock |          3500 |        3566.3 | 1 个（最长 3566.3 ms） |

## 首次运行死锁

第一次 `--batch` 运行以 `ERROR: deadlock detected` 失败，死锁发生在 migrator 与写入
探针之间：批次已经持有 `cdrs` 上的锁，随后要 `tenants`；探针的事务已经读过
`tenants`，正在等写 `cdrs`。为了完成测量，`--batch` 的探针改为缓存租户 id，不再
读 `tenants`。真实话单写入同样是读 `tenants` 再写 `cdrs`，所以一次部署有多个待执行
迁移时，可能与线上流量死锁。批次是原子的，死锁会让整批回滚、`db:migrate` 失败：
不会留下部分状态，但部署失败。`ops/deploy/deploy.sh` 是在旧服务仍在运行时执行迁移的。

原始输出：

```text
NOTICE:  relation "rehearse_stop" already exists, skipping
NOTICE:  relation "rehearse_probe_samples" already exists, skipping
NOTICE:  relation "rehearse_lock_samples" already exists, skipping
批次迁移失败：0004_billing_number_not_null -> 0024_suspended_at
ERROR:  deadlock detected
DETAIL:  Process 11023 waits for AccessExclusiveLock on relation 30812 of database 31872; blocked by process 11010.
Process 11010 waits for RowExclusiveLock on relation 31015 of database 31872; blocked by process 11023.
HINT:  See server log for query details.
错误：批次迁移失败；临时库保留供检查（若未 --keep 请手动 dropdb fs_billing_rehearse）
> build · deepseek-v4.1-flash
$ docker exec p10-migrate-postgres-1 psql -U fs_billing -d fs_billing_rehearse -Atc "select oid, relname, relkind from pg_class where oid in (30812, 31015)"
30812|tenants|r
31015|cdrs|p
```

上面的数字来自第二次运行，使用的是改过的探针，因此这一轮没有复现该竞争。

## 说明

- 本结果是开发机上的演练，不是服务器 B 的基线；上线后在 B 上用生产备份重做一次。
- 原型数据使用合成号码；本文件不含电话号码、密钥或连接串。
- 探针与锁采样都是抽样，短于采样间隔的锁可能只被记录一次或不出现。
