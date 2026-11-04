# 压测脚本低速冒烟（开发机，不是验收证据）

**这不是阶段 10 验收 4–6 的证据。** 它只证明 `ops/loadtest/*` 与
`packages/db/scripts/verify-load.ts` 能在一台开发笔记本上跑通；正式 30 分钟压测、
`restart-front` 与 `stop-worker` 演练必须等服务器 A、服务器 B 与独立 SIPp 主机到位后
按 `docs/ops-runbook.md`「压测与演练」重做，并放到
`docs/evidence/phase-10/loadtest/`、`drill-restart-front/`、`drill-stop-worker/`。

## 环境

- macOS + OrbStack，Docker 容器使用 `--network host` 访问本机回环；PostgreSQL 17.9
  在 `127.0.0.1:55436`（compose 项目 `p10-load`），Mailpit 同项目。
- 本地镜像 `fs-billing-freeswitch:local`、`fs-billing-sipp:local`。
- FreeSWITCH 容器名 `p10-load-freeswitch`，nginx relay 容器名 `p10-load-nginx`；
  两者都是本次冒烟临时启动，结束时删除。
- 测试租户 `FSIOK`（`freeswitch/test/seed.sql` 播种），费率含 `8613`、`86755`、
  `44`、`1` 四类前缀；余额从 100.00 开始。
- SIPp：2 cps × 180 秒 = 360 通，`-l 10`，每通保持 2–8 秒；上游是
  `uas-carrier.xml`，没有真实运营商线路。

## 结果

| 项                        | 实际值                                      |
| ------------------------- | ------------------------------------------- |
| 呼叫窗口（UTC）           | 2026-11-04T09:17:01Z → 2026-11-04T09:20:39Z |
| SIPp 成功 / 失败          | 360 / 0                                     |
| 窗口内话单                | 360（全部接通，`unverified` 0）             |
| 重算扣费合计              | 7.90 CNY                                    |
| `call_charge` 流水合计    | −7.90 CNY（360 笔）                         |
| 余额变化                  | 100.00 → 92.10，即 −7.90 CNY                |
| `raw_cdrs` / `call_uuids` | 360 个 UUID 均有原文；登记与话单一一对应    |
| `unassigned_cdrs`         | 0                                           |
| `verify-load.ts`          | PASS（失败项 0），见 `verify-load.txt`      |

SIPp 统计的原始累计行（手工从 `.smoke/out2/smoke.log` 摘录）：

```text
  Successful call        |        0                  |      360
  Failed call            |        0                  |        0
  Elapsed Time           | 00:03:38:316000           | 00:03:38:316000
```

## 故意错账

把一条话单的 `cdrs.charge` 从 0.01 改成 0.99，再跑同一窗口的核对：`verify-load.ts`
报 `FAIL 话单金额快照 1 条 cdrs.charge 与重算值不相等` 并退出 1，见
`verify-load-mismatch.txt`。随后把该行改回 0.01。这个检查证明核对不是只打印、也不是
只看合计。

## 没有跑的部分

- `drill.sh restart-front` / `stop-worker`：它们直接 `systemctl` 服务器 B 与
  `fs_cli` 服务器 A，本机没有这些单元与交换机；只做了 `shellcheck`。
- `sample-resources.sh`：读取 `/proc/stat`、`/proc/meminfo` 与 `journalctl`，本机 macOS
  没有这些；只做了 `shellcheck`。没有资源 CSV 数据，不在这里填数字。
- `run-load.sh` 的 10 分钟中压、30 分钟正式阶段与 50×3 分钟补充模式没有跑。
- 静置阶段观察到的队列吞吐约 0.6 通/秒（两个 Worker 同时消费时），360 通用了约 10 分钟
  才清空。这个速率来自 charge Worker 的 pg-boss 默认值（一次只取一个任务、每 2 秒轮询
  一次），不是这台笔记本特有的；后来已修复，见
  [docs/perf/charge-queue.md](../../../perf/charge-queue.md)；18,000 通能否在 10 分钟内
  清空，需要在真实 B 上量，见交接说明。
