# 异地备份驱动约定

**现状：只存本机。** 按用户决定 9（[阶段 10 设计](../../../docs/phase-10-design.md#已决定)），阶段 10
带条件上线：备份暂时只写 `BACKUP_DIR`（生产为 `/root/backups`），只接入试用客户；
**首个付费客户之前必须有异地备份**。本目录只约定脚本接口，不提供任何真实地址、账号或存储桶。

这台机器上的备份防不了整机丢失（磁盘损坏、被入侵、误删整个系统），能防的是误删数据、
坏迁移、应用层事故。异地目标到位前，过渡办法是每周把最近一套备份手工拉到运维自己的
机器，步骤见 [运维手册「备份」](../../../docs/ops-runbook.md#备份)。

## 脚本接口

`backup.sh` 读 `backup.conf` 的 `OFFSITE_COMMAND`：

- 为空：跳过，只存本机（默认）。
- 非空：按空白拆成「命令 + 参数」，**对每个产物调用一次**，产物绝对路径作为**最后一个参数**
  追加在命令末尾。调用顺序：库 dump、角色 SQL、归档目录 tar、配置 tar、`SHA256SUMS`。
- 每次调用的退出码被记录；任一失败只标记为失败并继续提交其余产物，整次备份最后退出非零
  （`fs-billing-backup.service` 因此记为失败）。
- 不做 shell 求值，也不支持 `{}` 之类的占位符。目标主机、存储桶、远端路径写在命令参数里，
  或者写在驱动自己的配置文件里。
- 命令与参数不进日志（日志只写产物的文件名），但**它们会出现在进程列表里**：不要把密码、
  token 写进 `OFFSITE_COMMAND`。`rclone` 的凭据放在 `~/.config/rclone/rclone.conf`（0600），
  `rsync` 用 root 的 SSH 密钥与 `~/.ssh/config`。

命令要满足：给定一个本地普通文件，把它完整送到异地并在退出 0 前落盘；不删除源文件；
可重复执行（同一产物重复提交应覆盖或幂等，不应报错）。脚本不负责异地的保留策略。

## 示例（占位符，执行前替换）

```sh
# 另一台机器，SSH 密钥登录；目标目录事先存在且只有运维可读
OFFSITE_COMMAND="rsync -a --partial --protect-args"

# 对象存储，rclone 远端在 rclone.conf 里配置
OFFSITE_COMMAND="rclone copyto --immutable"
```

`rsync` 需要目标作为最后一个参数，所以实际配置成：

```sh
OFFSITE_COMMAND="rsync -a --partial <user>@<backup-host>:<remote-dir>/"
```

`rclone copyto` 需要「源 + 目标」，而脚本只追加源路径，所以用一层包装脚本：

```sh
#!/bin/sh
# /usr/local/sbin/fs-billing-offsite
# 参数：本地产物路径。远端名与目录来自 rclone.conf 与下面的环境变量。
set -eu
exec rclone copyto --immutable "$1" "<remote>:<bucket>/fs-billing/$(basename "$1")"
```

```sh
OFFSITE_COMMAND="env FS_BILLING_OFFSITE_REMOTE=<remote> /usr/local/sbin/fs-billing-offsite"
```

## 加密

配置 tar 含 `/etc/fs-billing`（数据库密码、`BETTER_AUTH_SECRET`、SMTP 授权码）、
`/etc/nginx/conf.d` 与 `/etc/ssl/fs-billing`（证书私钥）；
其余产物含完整通话号码与客户资料。**异地副本必须加密**，且密钥不与备份放在同一台机器上。
加密同样用包装脚本完成（先在本地加密再上传，或上传前流式加密）：

```sh
#!/bin/sh
set -eu
exec age --encrypt --recipient <age-public-key> --output - "$1" |
  rclone rcat "<remote>:<bucket>/fs-billing/$(basename "$1").age"
```

本机不保存解密私钥；恢复演练时从运维保管的离线私钥解密。加密后的文件不再能用
`sha256sum` 校验明文，所以异地侧要另存一份上传前后的校验和，或使用支持端到端校验的工具。

## 恢复演练要覆盖异地副本

`verify-restore.sh` 只校验本机最新一套。异地目标启用后，至少每季度做一次
「从异地副本解密、解包、恢复到临时库」的人工演练，并把 `snapshot-counts.sh` 的输出
存进证据目录；这一步与每周自动演练同样重要。
