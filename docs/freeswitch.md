# FreeSWITCH 侧准备清单

> 版本：v0.2（2026-10-13）
> 用途：列出服务器 A（FreeSWITCH）需要的组件和配置项。本地联调使用与服务器 A 相同的固定版本安装脚本。
> 业务规则以 `docs/design.md` §4 为准。§6 记录已确定的实现与仍需实机验证的项目。

---

## 1. 需要的组件

| 组件 | 用途 | 备注 |
|---|---|---|
| Debian 13 服务器 | 运行 FreeSWITCH | 与服务器 B 同机房，走内网 |
| FreeSWITCH 1.11.3 | 交换机本体 | 官方 SignalWire Debian 13 包，固定完整版本，见 §6 |
| mod_sofia | SIP 接入、TLS 注册、SRTP | 默认自带 |
| mod_dptools | `sched_hangup`（到时挂断）、`limit`（并发上限） | 默认自带 |
| mod_hash | `limit` 的计数后端 | 单机足够，无需数据库 |
| mod_json_cdr | 通话结束后把话单 POST 给 Workers | 需要在 `modules.conf.xml` 中启用 |
| 授权调用模块 | 外呼前调用 Workers 的授权接口 | mod_lua + Lua-cURL（Lua-cURLv3），Lua 5.3 ABI；总超时 1500 ms |
| TLS 证书 | SIP over TLS（5061） | 需要一个指向服务器 A 的域名；Let's Encrypt 或购买的证书均可 |
| NTP（chrony） | 两台服务器时间同步 | 计费按接通时间，时间偏差会影响跨午夜、跨月归属 |
| 防火墙（nftables） | 只开放 SIP/RTP 端口；只允许访问服务器 B 的 Workers 端口 | |
| SIPp | 呼叫模拟与压测 | 装在另一台测试机上，不装在生产交换机上 |

## 2. 需要你提供的信息

| 信息 | 用途 |
|---|---|
| 上游运营商 SIP Trunk 参数（地址、端口、认证方式、号码格式要求） | 配置出局网关 |
| 服务器 A 的公网 IP 和内网 IP | SIP 配置、防火墙、Workers 白名单 |
| 服务器 A 的 SIP 域名 | TLS 证书 |
| 客户接入方式：注册（账号密码）还是 IP 对接 | 决定每个租户的配置写在用户目录还是 ACL |

## 3. 全局配置项

### 3.1 授权

| 配置项 | 值 | 说明 |
|---|---|---|
| 授权接口地址 | `http://<服务器 B 内网 IP>:<端口>/authorize` | 已确定；Lua 的 billing_worker_url 只填地址与端口，不含路径 |
| 共享密钥 | 随机生成，两边一致 | 放在请求头里，不写进代码仓库 |
| 超时 | 1.5 秒 | 包括建立连接和等待响应的总时间 |
| 超时后放行时长 | 1800 秒 | 同时设置 `billing_unverified=true` |
| 放行时的挂断 | `sched_hangup +<最长秒数>` | 最长秒数由授权接口返回，已包含 4 小时上限 |

**拒绝时返回的 SIP 错误码**（已确定）：

| 拒绝原因 | SIP 错误码 |
|---|---|
| 租户不存在或已停用 | 403 Forbidden |
| 号码格式错误 | 484 Address Incomplete |
| 计费投影不一致 | 503 Service Unavailable |
| 计费号码匹配不到费率 | 404 Not Found |
| 余额不足（已停机） | 402 Payment Required |

### 3.2 话单推送（mod_json_cdr）

| 配置项 | 值 | 说明 |
|---|---|---|
| 推送地址 | `http://<服务器 B 内网 IP>:<端口>/cdr` | 已确定；经本机 nginx relay 添加共享密钥 |
| 认证 | 与授权接口相同的共享密钥 | |
| 只推 A 腿 | 是 | 一通电话只推一条，避免同一通话产生两条话单；`log-b-leg=false` |
| 失败重试 | 重试次数与间隔 | 3 次、每次间隔 5 秒，总计 4 次尝试 |
| 失败落盘目录 | `/var/lib/freeswitch/cdr/retry/` | 推送彻底失败时保存，恢复后补推 |

**话单里必须包含的字段**：

| 字段 | 用途 |
|---|---|
| `uuid` | 去重 |
| `billing_tenant` | 确定租户 |
| `billing_dialed_number` | 保存原始拨号，作为话单展示号码与归一化输入 |
| `billing_number` | Lua 的规范化投影，Worker 重新计算并核验后用于费率与账本 |
| 接通时间（`answer_epoch` 或 `answer_stamp`） | 确定费率版本、日期和月份归属 |
| 计费时长（`billsec`） | 计算费用 |
| `hangup_cause`、SIP 状态码 | 话单详情与排查 |
| `billing_unverified` | 标记计费系统故障期间放行的通话 |

### 3.3 号码格式

费率前缀使用带国家码的纯数字号码。客户拨号带 `+` 或 `00` 时是国际号码，计费时去掉该冠字；没有国际冠字时是国内号码，补 `86` 并先去掉一个开头的固话 `0`。例如 `13800138000` 计费为 `8613800138000`，`07551234567` 计费为 `867551234567`。`+13055551234` 计费为 `13055551234`，裸拨 `13055551234` 计费为 `8613055551234`。

桥接始终使用原始拨号，包括 `+`、`00` 和国内固话的 `0`。Lua 不改写 `destination_number`，只保存原始桥接变量与独立 `billing_number`。路由格式只允许开头可选的一个 `+` 和 1–17 位 ASCII 数字；`|`、`,`、空格等字符返回 SIP 484。规范化后的计费号码必须以 1–9 开头、总长 6–15 位，15 位限制不作用于桥接号码。

Worker 的 `resolveBillingNumber` 同时处理授权与 CDR。Lua 投影用于请求前校验和超时降级，Worker 重新计算并核验投影，不能直接信任交换机提供的计费号码。Lua 在脚本开始时设置 `billing_dialed_number`，提前退出的话单也保留原始拨号。授权请求的 `callee` 是规范化计费号码，`dialedNumber` 保留原始拨号；授权成功响应缺少或返回不一致的 `billingNumber` 时返回 SIP 503。话单以 `billing_dialed_number` 保留原始展示号码，数据库 `callee` 与 `billing_number` 分别保存原始拨号与计费号码。

授权必须包含 `dialedNumber`，CDR 必须包含 `billing_dialed_number`。缺失时分别按号码格式错误拒绝授权、按话单校验失败停放话单，不收费。完整接口要求见 [Worker 接口](worker-api.md)。

国内费率前缀必须带 `86`，不能使用原始拨号中的手机前缀或固话 `0`。以 owner 身份检查每个租户当前生效版本的前缀：

```sql
WITH effective AS (
  SELECT DISTINCT ON (tenant_id) id, tenant_id
  FROM rate_versions
  WHERE effective_from <= now()
  ORDER BY tenant_id, effective_from DESC
)
SELECT t.code, e.prefix, e.country, e.rate
FROM effective v
JOIN rate_entries e ON e.rate_version_id = v.id AND e.tenant_id = v.tenant_id
JOIN tenants t ON t.id = v.tenant_id
WHERE e.prefix ~ '^0'
   OR (e.prefix !~ '^86' AND (
     e.country ~* '(中国|china|\ycn\y)'
     OR e.prefix ~ '^1[3-9]'
   ))
ORDER BY t.code, e.prefix;
```

逐项核对结果，包括以 `0` 开头的固话前缀和未带 `86` 的国内前缀。国家名及 `1[3-9]` 只筛出候选，可能包含国际前缀，也可能遗漏短国内前缀；同时对照实际国内路由核验完整费率表。国内前缀必须使用 `86`；发现不符合要求的前缀时，发布正确的费率版本并确认生效。不要自动改写现有版本，CSV 校验和数据库前缀约束保持不变。

### 3.4 时间

- 两台服务器都启用 NTP 同步
- FreeSWITCH 话单中的时间以 epoch 秒为准传给计费系统，计费系统按 UTC 存储、按北京时间展示

## 4. 每个租户的配置项

| 配置项 | 示例 | 说明 |
|---|---|---|
| `billing_tenant` | `ABC001` | 写在 SIP 用户或 IP 对接上；必须与管理后台中的租户编码完全一致，否则话单进入未归属话单 |
| 并发上限 | `limit hash tenant ABC001 30` | 计费系统故障时控制透支的主要手段 |
| 接入方式 | SIP 账号密码，或 IP 白名单 | |
| TLS / SRTP | 是否强制 | 按客户终端能力决定 |

新开一个客户时，管理后台和 FreeSWITCH 两边都要配置。第一版两边分别手工配置，上线检查清单中要有"两边编码一致"这一项。

## 5. 网络与安全

- 服务器 A 访问服务器 B 的 Workers 端口走内网
- 服务器 B 的防火墙只允许服务器 A 的内网 IP 访问 Workers 端口（`design.md` §4.4）
- 服务器 A 对公网只开放 SIP（5060/5061）和 RTP 端口范围；SIP 端口建议加速率限制，防止扫描

## 6. 阶段 3 的决定与验证

- [x] 安装方式采用官方 SignalWire Debian 13 包。服务器 A 与镜像都执行 [install.sh](../freeswitch/install/install.sh)，固定完整版本 `1.11.3-release-33213556856-ef32e20529~trixie~amd64-1~trixie+1`，包括 `freeswitch-systemd`。包安装保留标准目录与 systemd 集成。vanilla 配置的 event socket 监听所有地址且使用默认密码，因此安装包之前用 `policy-rc.d`（返回 101）禁止包脚本启动服务，systemd 主机上同时屏蔽 `freeswitch.service`；成功后解除屏蔽并 `disable --now`，失败时保持屏蔽且停止。配置完成前服务保持停用。Docker 构建没有 systemd，只使用 `policy-rc.d`。由 `tests/install-freeswitch.test.ts` 覆盖。
- [x] 只安装本项目需要的模块与 vanilla 基础配置，不安装 `freeswitch-meta-all`，减少无关模块、依赖与启动配置。
- [x] `mod_lua` 链接 Lua 5.3。授权使用固定版本 Lua-cURL（Lua-cURLv3）`0.3.13-1` 和 Debian `lua-cjson` `2.1.0+dfsg-2.2+b2`。Debian `lua-curl` 是旧版接口且只提供 Lua 5.1、5.2，不能提供 `cURL.safe`。JSON 数字先用 `math.tointeger` 转成整数，再生成 SIP 与挂断命令；非整数响应按无效响应处理。
- [x] 话单只推 A 腿，失败原文落入 retry。独立 [replay-cdr.sh](../freeswitch/scripts/replay-cdr.sh) 补推超过一分钟的文件，Worker 按 UUID 去重。
- [x] 业务拒绝使用 SIP 402、403、404；非法号码使用 484。桥接保留原始拨号，国际与国内号码分别归一化为独立 `billing_number`，授权与话单由 Worker 同一函数核验。
- [x] 授权与话单路径为 `/authorize` 和 `/cdr`，请求格式见 [Worker 接口](worker-api.md)。
- [ ] 用 [run-integration.sh](../freeswitch/test/run-integration.sh) 保存真实 SIP、CDR 与账本证据，验证六种国内及国际拨号的上游原始 INVITE、规范化话单与账本，以及 1500 ms 停滞超时、60 秒 `ALLOTTED_TIMEOUT`、失败落盘与重复补推。此脚本使用本机回环地址，不替代服务器 A 的网络与 TLS 验收。

服务器 A 安装后，按以下步骤配置，再启动服务。vanilla 配置的 event socket 监听 `::`、密码为 `ClueCon`，`default_password` 为 `1234`，不能直接用于服务器 A。

1. 替换 `/etc/freeswitch/autoload_configs/event_socket.conf.xml`，将 `listen-ip` 设为 `127.0.0.1`，将 `password` 换成新的强密码。
2. 修改 `/etc/freeswitch/vars.xml` 的 `default_password`，换成新的强密码。
3. 替换 `/etc/freeswitch/sip_profiles/`、`directory/` 与 `dialplan/` 中的 vanilla 示例，使用服务器 A 的 SIP 接入、租户、上游网关与 billing 拨号计划配置。
4. 替换 `/etc/freeswitch/autoload_configs/modules.conf.xml`，只加载已安装且需要的模块，包括 `mod_lua` 与 `mod_json_cdr`。按 [FreeSWITCH 接入说明](../freeswitch/README.md) 配置授权脚本与话单推送。
5. 完成上述配置后，执行 `systemctl enable --now freeswitch`。

SignalWire 下载令牌属于仓库所有者 SpaceEggs/dogegg 的 SignalWire 账号，是个人 PAT。CI 使用仓库 secret `SIGNALWIRE_TOKEN`，通过 BuildKit secret 只传给安装步骤。服务器 A 从受限文件读取令牌，默认路径 `/run/secrets/signalwire_token`，也可用 `SIGNALWIRE_TOKEN_FILE` 或脚本参数指定。安装步骤关闭 shell tracing，在同一次运行内删除 apt 认证文件，失败时也删除。

轮换令牌时执行以下步骤：

1. 在上述 SignalWire 账号生成新 PAT，保留旧令牌直到新令牌验证成功。
2. 更新仓库 secret `SIGNALWIRE_TOKEN`，以及服务器 A 的受限令牌文件。不要把令牌写入仓库、构建参数或日志。
3. 手动触发 FreeSWITCH workflow，确认镜像构建、私有 GHCR 推送与联调成功。
4. 撤销旧 PAT。后续固定版本升级同时修改安装脚本并重建镜像，再执行相同联调。

GHCR 镜像保持私有，仅向获授权的仓库与运行环境开放拉取。PR 联调只使用 `GITHUB_TOKEN` 拉取镜像，不接触 SignalWire PAT；令牌为空或镜像无拉取权限时 workflow 给出 notice 并跳过对应工作。
