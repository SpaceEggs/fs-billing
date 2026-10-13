# FreeSWITCH 接入 Worker

示例实现 [design.md](../docs/design.md) §4 的呼叫前授权与话单推送。测试机准备见 [准备清单](../docs/freeswitch.md)，HTTP 契约见 [Worker 接口](../docs/worker-api.md)。地址、gateway 与密钥都需要替换成测试机配置。

## 安装授权脚本与拨号计划

1. 加载 `mod_lua` 与 `mod_json_cdr`。在 **mod_lua 使用的 Lua 版本**中安装 `Lua-cURL` 与 `lua-cjson`，确认 `require('cURL.safe')` 和 `require('cjson.safe')` 成功。脚本用 libcurl 的 `timeout_ms=1500` 限制整个 HTTP 请求，含连接与响应读取，不用只支持整数秒的 `mod_curl timeout`。
2. 将 [billing_authorize.lua](scripts/billing_authorize.lua) 放进 FreeSWITCH 的 scripts 目录。在受限的 `vars.xml` 设置全局变量 `billing_worker_url=http://10.0.0.20:3001`、`billing_shared_key=<WORKER_SHARED_KEY>`，执行 `reloadxml`。密钥不放通道变量，避免进入原始话单。
3. 从可信的 directory 用户或 IP 路由设置 `billing_tenant=ABC001`。拒绝客户端用 SIP header 覆盖租户标签。将 [billing.xml](dialplan/billing.xml) 放进 dialplan 目录，客户使用 `billing` context，将 `upstream` 换成实际 gateway。`billing-authorized` 只供脚本之后的内部寻路，不给客户配置为入口。
4. 设置租户并发上限。Worker 故障时每通均放行 1800 秒，并发上限用于控制透支。

脚本先去掉被叫开头的 `+`、再去掉 `00`，把规范化结果同时写回 A-leg 的 `destination_number` 与桥接变量 `billing_destination`。授权请求只包含租户编码、被叫与 A-leg UUID；余额不保存在交换机。含非数字字符的号码仍交给 Worker 返回 `号码格式错误`。

放行设置 `billing_authorized=true`。未接通时设置 `execute_on_answer=sched_hangup +N ALLOTTED_TIMEOUT`，接通后才开始计时；已接通的通道直接执行 `sched_hangup +N ALLOTTED_TIMEOUT`。本示例占用 `execute_on_answer`，其他接通动作需要合并到同一接通处理流程。拨号计划不要在授权前 `answer`。Lua 执行后用单独的 `billing-authorized` context 重新判断放行标记；XML 条件在执行应用之前求值，不能在同一轮条件里依赖 Lua 刚设置的变量。

业务拒绝用返回的 `sipCode` 执行 `respond` 并挂断，不执行 bridge。超时、无响应、5xx 或无法解析的成功响应放行 1800 秒并设置 `billing_unverified=true`。401、403、无业务拒绝形状的 400 以及本机配置错误返回 503，修正配置后再试。正常授权设该标记为 false。脚本不重试授权，也不记录共享密钥。

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

## 测试机验收

- 呼叫 `+447…` 与 `00447…`，确认授权请求、上游桥接与 A-leg CDR 都是纯数字。检查 UUID 与租户标签一致。
- 用可用金额只够一分钟的测试租户打一通电话，保存授权 `maxSeconds=60`、接通日志、约 60 秒后 `ALLOTTED_TIMEOUT` 与账本记录。振铃时间不计入定时挂断。
- 用停用或余额不足的租户呼叫，保存 SIP 403 或 402，确认没有上游 bridge。
- 停 Worker 或将授权流量延迟超过 1.5 秒，确认拨号继续、接通后计时 1800 秒、CDR 带 `billing_unverified=true`。恢复后照常扣费，首次有效话单写一条 `auth_timeout` 告警。
- 停 Worker 后挂断通话，确认 archive 与 retry 有完整原文。恢复 Worker 后运行重推任务，确认 retry 文件移除、数据库只有一条正式话单和一笔扣费。再次 POST archive 副本只能得到 `duplicate`。

本地 HTTP/DB 验证不替代 FreeSWITCH 测试机通话。保留实际 SIP、接通、定时挂断、推送日志与 UUID 对应的 DB 查询结果后，才能勾选 plan 阶段 3 的实机验收项。
