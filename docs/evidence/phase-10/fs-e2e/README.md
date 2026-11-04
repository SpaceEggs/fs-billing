# FreeSWITCH e2e 证据（验收 13）

本目录保存「CI 不得静默跳过 FreeSWITCH e2e」的两次运行结果：一次真实通过，一次故意让
镜像不可用、证明门禁会红。状态文件、`results.tsv` 与 `containers.log` 都是运行产物，未做修改。

## 通过的一次

- 运行：[actions/runs/41795812973](https://github.com/SpaceEggs/fs-billing/actions/runs/41795812973)
- 提交：`a83d190ef251de946f7f1de1c7206afc033203f3`（`main`）
- 事件：`workflow_dispatch`
- 结果：FreeSWITCH 联调 **15/15 通过**；`fs-e2e-status.json` 为 `status=passed`、
  `passed=15`、`total=15`。
- 门禁：该提交被 `ops/checks/require-fs-e2e.sh` 接受（脚本成功时输出以 `PASS` 开头）。
- 本目录文件：`fs-e2e-status.json`、`results.tsv`、`containers.log`。

## 反证：故意让镜像不可用

- 运行：[actions/runs/41795807569](https://github.com/SpaceEggs/fs-billing/actions/runs/41795807569)
- 提交：`21e359a6b6be71d0827ebbc8ba90f777250f6832`，在临时分支上，不是 `main`
- 事件：`workflow_dispatch`
- 构造：镜像 hash 故意写错，镜像作业关闭，所以该 hash 的镜像拉不到。
- 结果：运行结束为红色，`negative-wrong-image-status.json` 记录 `status=failed`、
  `passed=0`、`total=0`，原因是「镜像不可用，且此事件不允许跳过」。
- 门禁：`require-fs-e2e.sh 21e359a6b6be71d0827ebbc8ba90f777250f6832` 拒绝该提交
  （该提交上没有成功的运行，找不到可接受的 `status=passed`），退出非零。
- 临时分支与这个提交不在仓库历史里；这个状态文件只作反证，不是验收证据。

## 还不是发布提交

`a83d190` **不是发布提交**。验收 13 要求在实际发布提交上再触发一次
`workflow_dispatch`，保存同样的 `fs-e2e-status.json`、`results.tsv` 与 `containers.log`，并确认
`require-fs-e2e.sh <发布 SHA>` 通过；在此之前，本目录只证明门禁与流程可用，不能当作
发布提交的验收证据。发布时把这三个文件覆盖为发布提交那次运行的结果。

## 产物里的日志

通过的那次运行，产物 `freeswitch-integration` 里有 `containers.log`，已原样保存到本目录。
入库前核对过：没有密钥、口令或令牌，其中的号码都是联调用的合成号码。产物里还有
`assertions.log`、`worker.log` 和每个用例的 `*.sipp.log`、`*.messages.log`、`*.raw.json`、
`*.cdr.json`、`*.ledger.json` 等，没有入库，按运行号从 GitHub 下载。
