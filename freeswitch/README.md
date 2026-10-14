# FreeSWITCH 接入 Worker

示例实现 [design.md](../docs/design.md) §4 的呼叫前授权与话单推送。测试机准备见 [准备清单](../docs/freeswitch.md)，HTTP 契约见 [Worker 接口](../docs/worker-api.md)。地址、gateway 与密钥都需要替换成测试机配置。

## 服务器 A 安装与启动

以 root 运行 [install.sh](install/install.sh)，令牌放在受限文件 `/run/secrets/signalwire_token`。脚本安装固定版本的 `freeswitch-systemd`。安装包之前写入返回 101 的 `/usr/sbin/policy-rc.d`，systemd 主机上再 `systemctl mask freeswitch.service`，包脚本不能启动带 vanilla 配置的服务。全部步骤成功后解除屏蔽并执行 `systemctl disable --now freeswitch.service`；任何一步失败，服务保持屏蔽且停止，修复后重新执行脚本。`policy-rc.d` 在退出时移除或恢复原文件。Docker 构建没有 systemd，只使用 `policy-rc.d`。

vanilla 配置的 event socket 监听 `::`、密码为 `ClueCon`，`default_password` 为 `1234`。服务停用期间完成以下步骤：

1. 替换 `/etc/freeswitch/autoload_configs/event_socket.conf.xml`，将 `listen-ip` 设为 `127.0.0.1`，将 `password` 换成新的强密码。
2. 修改 `/etc/freeswitch/vars.xml` 的 `default_password`，换成新的强密码。
3. 替换 `/etc/freeswitch/sip_profiles/`、`directory/` 与 `dialplan/` 中的 vanilla 示例，使用服务器 A 的 SIP 接入、租户、上游网关与下述 billing 拨号计划配置。
4. 替换 `/etc/freeswitch/autoload_configs/modules.conf.xml`，只加载已安装且需要的模块，包括 `mod_lua` 与 `mod_json_cdr`。完成下述授权脚本与话单推送配置。
5. 完成上述配置后，执行 `systemctl enable --now freeswitch`。

## 安装授权脚本与拨号计划

自定义 `lua.conf.xml` 的 `script-directory` 时，在路径末尾保留 `;;`，以保留 Lua 默认模块搜索路径。

1. 加载 `mod_lua` 与 `mod_json_cdr`。在 **mod_lua 使用的 Lua 版本**中安装 `Lua-cURL`（Lua-cURLv3）与 `lua-cjson`，确认 `require('cURL.safe')` 和 `require('cjson.safe')` 成功。脚本用 libcurl 的 `timeout_ms=1500` 限制整个 HTTP 请求，含连接与响应读取，不用只支持整数秒的 `mod_curl timeout`。
2. 将 [billing_authorize.lua](scripts/billing_authorize.lua) 放进 FreeSWITCH 的 scripts 目录。在受限的 `vars.xml` 设置全局变量 `billing_worker_url=http://10.0.0.20:3001`、`billing_shared_key=<WORKER_SHARED_KEY>`，执行 `reloadxml`。密钥不放通道变量，避免进入原始话单。
3. 从可信的 directory 用户或 IP 路由设置 `billing_tenant=ABC001`。拒绝客户端用 SIP header 覆盖租户标签。将 [billing.xml](dialplan/billing.xml) 放进 dialplan 目录，客户使用 `billing` context，将 `upstream` 换成实际 gateway。`billing-authorized` 只供脚本之后的内部寻路，不给客户配置为入口。
4. 设置租户并发上限。Worker 故障时合法号码每通放行 1800 秒，并发上限用于控制透支。

脚本始终保留原始 `destination_number`，将原始号码写入 `billing_destination` 供桥接，在脚本开始时就写入 `billing_dialed_number`，使提前退出或校验失败的话单也保留原始拨号。`billing_number` 单独保存计费投影。带 `+` 或 `00` 的号码按国际号码去掉冠字；其他号码按国内号码先去掉一个开头的 `0`，再加 `86`。例如 `07551234567` 的计费号码是 `867551234567`，上游仍收到 `07551234567`。`+13055551234` 按国际号码计费，裸拨 `13055551234` 按 `8613055551234` 计费。

桥接格式只接受一个可选的开头 `+` 和 1–17 位 ASCII 数字，拒绝 `|`、`,`、空格等字符。独立的计费号码必须首位为 1–9、长度为 6–15 位。非法路由或计费投影在请求前返回 SIP 484，以 `INVALID_NUMBER_FORMAT` 挂断。15 位 E.164 上限只校验 `billing_number`，不截断或改写上游号码。

授权请求包含租户、A-leg UUID、规范化 `callee` 与原始 `dialedNumber`，以及 `billingNumber` 投影。Worker 的同一个 `resolveBillingNumber` 处理授权与 CDR，重新计算并核验 Lua 投影；授权成功响应中的号码必须存在且与本地投影一致，否则返回 SIP 503 并拒绝通话。Lua 投影用于授权前校验与超时降级，计费以 Worker 核验并持久化的结果为准。余额不保存在交换机。

放行设置 `billing_authorized=true`。未接通时设置 `execute_on_answer=sched_hangup +N ALLOTTED_TIMEOUT`，接通后才开始计时；已接通的通道直接执行 `sched_hangup +N ALLOTTED_TIMEOUT`。本示例占用 `execute_on_answer`，其他接通动作需要合并到同一接通处理流程。拨号计划不要在授权前 `answer`。Lua 执行后用单独的 `billing-authorized` context 重新判断放行标记；XML 条件在执行应用之前求值，不能在同一轮条件里依赖 Lua 刚设置的变量。

业务拒绝用返回的 `sipCode` 执行 `respond` 并挂断，不执行 bridge。合法号码遇到超时、无响应、5xx（包括 `/authorize` 的 503）或无法解析的成功响应放行 1800 秒并设置 `billing_unverified=true`。401、403、无业务拒绝形状的 400 以及本机配置错误返回 503，修正配置后再试。正常授权设该标记为 false。脚本不重试授权，也不记录共享密钥。

## 配置话单推送与落盘重推

1. 在 FreeSWITCH 机器的 nginx `http` 块加载 [billing-cdr.conf](nginx/billing-cdr.conf)。修改 Worker 内网地址与 `X-Billing-Key`，执行 `nginx -t` 后 reload。relay 仅监听 `127.0.0.1:3002`，Worker 白名单加入 **FreeSWITCH 机器实际来源 IP**。
2. 把 [json_cdr.conf.xml](autoload_configs/json_cdr.conf.xml) 放进 autoload_configs，创建 `/var/lib/freeswitch/cdr/archive` 与 `/var/lib/freeswitch/cdr/retry`，让 FreeSWITCH 与重推任务可读写。目录限服务账号访问。重载 `mod_json_cdr`，确认日志中的 URL 与目录。
3. 用服务账号每分钟运行 `sh /path/to/replay-cdr.sh`。脚本把 retry 中最后修改超过一分钟的 `.cdr.json` 原文 POST 到本机 relay；2xx 后删除 retry 文件，非 2xx 或无响应保留，下次重推。archive 保留成功和失败推送的副本，按运维保留规则另行归档。

上游 [mod_json_cdr 源码](https://github.com/signalwire/freeswitch/blob/master/src/mod/event_handlers/mod_json_cdr/mod_json_cdr.c) 没有自定义 HTTP header 配置；`cred` 发送 HTTP Basic 认证，不能生成 Worker 的 `X-Billing-Key`。因此示例通过本机 relay 添加共享密钥，Worker 仍检查真实来源 IP 与密钥。不要配置不存在的 `http-header` 参数，也不要将密钥放 URL 查询参数。

`encode=false` 发送直接 JSON，`encode-values=false` 保留变量原值。只推 A-leg，防止 B-leg 的另一 UUID 产生第二笔账。每次请求最多等待 5 秒，失败后间隔 5 秒重试 3 次（共 4 次尝试）；模块耗尽 HTTP 尝试后落入 retry，**不会自行扫描磁盘重推**。独立脚本补足这一环节。Worker 503 必须传回 FreeSWITCH，relay 不拦截错误、不自动改成 200。

手动重推一份已完成的失败文件：

```sh
curl --noproxy '*' --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  --data-binary @/var/lib/freeswitch/cdr/retry/a_<UUID>.cdr.json \
  http://127.0.0.1:3002/cdr
```

收到 `queued`、`duplicate`、`unassigned` 或 `invalid` 都表示 Worker 已保存原文。重复推送由 `call_uuids` 去重，不重复扣费；`unassigned` 与 `invalid` 需要查看数据库告警，不要通过改标签重推来认领已有 UUID。

## 本地回归验证

在仓库根目录执行 Lua harness：

```sh
lua5.3 freeswitch/tests/billing_authorize_test.lua
```

该测试用模拟 session 与 HTTP 响应运行真实授权脚本，覆盖桥接保留原始拨号、独立计费号码、国内与国际归一化、非法号码在请求前返回 484、投影核验、合法号码遇到授权 503/超时才降级、正常授权与接通后限时挂断。`pnpm check` 同时运行 Lua harness 和拨号计划条件测试；CI 缺少 `lua5.3` 时失败，本地缺少时可跳过对应测试。

完整 FreeSWITCH 联调使用 [run-integration.sh](test/run-integration.sh)，需要 Linux、Docker Compose、Node、pnpm、Python 3 与 curl。SIP 观测容器使用 `NET_RAW` 权限，只捕获回环 INVITE；授权代理记录号码与 UUID，不记录密钥。脚本启动本机 Worker、FreeSWITCH、nginx relay 与容器内 SIPp，使用数据库中的 `FSI` 前缀测试租户。租户编码不含下划线，遵守数据库约束。测试先执行六个号码用例，包括 `+44`、`0044`、国内手机、国内固话、`+1305` 与裸拨 `1305`。每个用例断言上游 INVITE 保留原始号码，授权请求的 `callee == billingNumber` 等于规范化号码，`dialedNumber` 等于原始拨号。正式话单的 `callee` 保留原始拨号，`billing_number` 保存规范化号码；前缀、费率、扣费金额与账本备注使用规范化号码。停用、余额不足、计费限时与话单重推用例也核验同一授权请求格式及各自的租户。非法号码在请求前拒绝；连接拒绝与延迟用例绕过授权观测代理，这三类用例均断言代理没有授权记录。测试还包含真实 60 秒计费限时：断言时长 59–60 秒（调度器按整秒触发；61 秒起会计成 2 分钟）、计费 1 分钟、话单金额 0.01、扣费流水 −0.01、余额从 0.01 扣到 0，并按受控 Call-ID 验证原始话单、正式话单与唯一扣费。

`ALLOTTED_TIMEOUT` 的话单结束时间依赖媒体持续流动，无媒体的通话腿在现场复现中会延迟约 5 秒拆线，因此 SIPp 的客户与运营商两端在通话期间持续发送 RTP。

```sh
# 已有镜像，默认 fs-billing-freeswitch:local。
FS_IMAGE=fs-billing-freeswitch:local bash freeswitch/test/run-integration.sh
# 先用环境中的 SIGNALWIRE_TOKEN 作为 BuildKit secret 构建。
bash freeswitch/test/run-integration.sh --build
# 指定日志目录。
bash freeswitch/test/run-integration.sh /tmp/fs-integration-local
```

`WORKER_SHARED_KEY` 未设置时脚本生成临时密钥，不写入仓库。脚本输出 PASS/FAIL 表，失败返回非零，退出时停止测试容器、Worker 与本次启动的 PostgreSQL；保留日志及测试租户，避免删除其他开发数据。[fs_check.lua](test/fs_check.lua) 在 `mod_lua` 中检查 Lua 5.3、真实 `cURL.safe` 与 `cjson.safe`，以及 JSON 整数转换。

[现场复现脚本](../docs/evidence/phase-3/live-repro-pstack.sh) 使用真实 Worker HTTP 与数据库验证毫秒费率切换、故障 503 和恢复重推。它不替代 FreeSWITCH 测试机通话。

## 测试机验收

- 呼叫 `+447…`、`00447…`、`138…` 与 `0755…`，确认上游 INVITE 与客户原始拨号完全一致。检查授权及 A-leg CDR 的原始拨号、独立计费号码、UUID 与租户标签；正式话单的计费前缀和账本备注必须使用 `billing_number`。
- 用可用金额只够一分钟的测试租户打一通电话，保存授权 `maxSeconds=60`、接通日志、约 60 秒后 `ALLOTTED_TIMEOUT` 与账本记录。振铃时间不计入定时挂断。
- 用停用或余额不足的租户呼叫，保存 SIP 403 或 402，确认没有上游 bridge。
- 停 Worker 或将授权流量延迟超过 1.5 秒，确认拨号继续、接通后计时 1800 秒、CDR 带 `billing_unverified=true`。恢复后照常扣费，首次有效话单写一条 `auth_timeout` 告警。
- 停 Worker 后挂断通话，确认 archive 与 retry 有完整原文。恢复 Worker 后运行重推任务，确认 retry 文件移除、数据库只有一条正式话单和一笔扣费。再次 POST archive 副本只能得到 `duplicate`。

本地 HTTP/DB 验证不替代 FreeSWITCH 测试机通话。保留实际 SIP、接通、定时挂断、推送日志与 UUID 对应的 DB 查询结果后，才能勾选 plan 阶段 3 的实机验收项。
