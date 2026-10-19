# Phase 6 PR 3 挂断原因名称只读核对

## 结论

`docs/phase-6-design.md` 要求 46 个 FreeSWITCH 原因中文对照，并指出 PR 3 要对照 FreeSWITCH 1.11.3 核对名称/缺漏。当前 `packages/shared/src/hangup-cause.ts` 有 46 个 key。逐项与官方 1.11.3 `switch_call_cause_t` 枚举及 `switch_channel.c` 的名称映射表交叉比对：**46/46 均存在于两处且拼写完全一致，无名称差异**。该版本的枚举和映射表各有 82 个名称、两者集合一致。其余 36 个官方原因并未收录在项目 46 项表中；这是相对于完整官方集合的覆盖差异，是否应纳入属于产品范围/翻译决策，本审计不自行改译或建议扩充。

本次仅核对英文标识符是否为该版本正式名称、是否能通过 FreeSWITCH 映射表转换；没有评判中文译法质量。

## 官方版本与来源

- FreeSWITCH 官方仓库 `signalwire/freeswitch` 的 [v1.11.3 Release](https://github.com/signalwire/freeswitch/releases/tag/v1.11.3)，发布页面标出 tag `v1.11.3`、commit `ef32e20`。该短 SHA 对应完整 commit `ef32e205295e29f034f1453ad245ba5efb07b94a`。
- 固定到该完整 commit 的官方 [src/include/switch_types.h](https://github.com/signalwire/freeswitch/blob/ef32e205295e29f034f1453ad245ba5efb07b94a/src/include/switch_types.h)，`switch_call_cause_t` enum 位于约 2180–2268 行。
- 固定到该完整 commit 的官方 [src/switch_channel.c](https://github.com/signalwire/freeswitch/blob/ef32e205295e29f034f1453ad245ba5efb07b94a/src/switch_channel.c)，`CAUSE_CHART` 名称映射表位于约 57–145 行；`switch_channel_cause2str` 使用此表返回名称（约 203–215 行）。

## 逐项核对

以下 46 项全部同时命中 `switch_call_cause_t` 和 `CAUSE_CHART`，无差异：

`ALLOTTED_TIMEOUT`, `ATTENDED_TRANSFER`, `BEARERCAPABILITY_NOTAUTH`, `BEARERCAPABILITY_NOTAVAIL`, `BLIND_TRANSFER`, `BUSY_EVERYWHERE`, `CALL_REJECTED`, `DECLINE`, `DESTINATION_OUT_OF_ORDER`, `DOES_NOT_EXIST_ANYWHERE`, `EXCHANGE_ROUTING_ERROR`, `FACILITY_NOT_SUBSCRIBED`, `FACILITY_REJECTED`, `GATEWAY_DOWN`, `INCOMING_CALL_BARRED`, `INCOMPATIBLE_DESTINATION`, `INTERWORKING`, `INVALID_NUMBER_FORMAT`, `LOSE_RACE`, `MANAGER_REQUEST`, `MEDIA_TIMEOUT`, `NETWORK_OUT_OF_ORDER`, `NORMAL_CIRCUIT_CONGESTION`, `NORMAL_CLEARING`, `NORMAL_TEMPORARY_FAILURE`, `NORMAL_UNSPECIFIED`, `NOT_ACCEPTABLE`, `NO_ANSWER`, `NO_ROUTE_DESTINATION`, `NO_ROUTE_TRANSIT_NET`, `NO_USER_RESPONSE`, `NUMBER_CHANGED`, `ORIGINATOR_CANCEL`, `OUTGOING_CALL_BARRED`, `PICKED_OFF`, `PROGRESS_TIMEOUT`, `PROTOCOL_ERROR`, `RECOVERY_ON_TIMER_EXPIRE`, `REQUESTED_CHAN_UNAVAIL`, `SERVICE_UNAVAILABLE`, `SUBSCRIBER_ABSENT`, `SWITCH_CONGESTION`, `UNALLOCATED_NUMBER`, `UNWANTED`, `USER_BUSY`, `USER_NOT_REGISTERED`.

## 46 项表之外的官方名称

官方枚举和 `CAUSE_CHART` 另有以下 36 项，项目表未收录：

`ACCESS_INFO_DISCARDED`, `BAD_IDENTITY_INFO`, `BEARERCAPABILITY_NOTIMPL`, `BOWOUT`, `CALL_AWARDED_DELIVERED`, `CHANNEL_UNACCEPTABLE`, `CHAN_NOT_IMPLEMENTED`, `CRASH`, `FACILITY_NOT_IMPLEMENTED`, `IE_NONEXIST`, `INVALID_CALL_REFERENCE`, `INVALID_GATEWAY`, `INVALID_IDENTITY`, `INVALID_IE_CONTENTS`, `INVALID_MSG_UNSPECIFIED`, `INVALID_PROFILE`, `INVALID_URL`, `MANDATORY_IE_LENGTH_ERROR`, `MANDATORY_IE_MISSING`, `MESSAGE_TYPE_NONEXIST`, `NONE`, `NO_IDENTITY`, `NO_PICKUP`, `PRE_EMPTED`, `REDIRECTION_TO_NEW_DESTINATION`, `REJECT_ALL`, `RESPONSE_TO_STATUS_ENQUIRY`, `SERVICE_NOT_IMPLEMENTED`, `SRTP_READ_ERROR`, `STALE_DATE`, `SUCCESS`, `SYSTEM_SHUTDOWN`, `UNSUPPORTED_CERTIFICATE`, `USER_CHALLENGE`, `WRONG_CALL_STATE`, `WRONG_MESSAGE`.

## 验收解读

- 要求中的“46 个”数量满足。
- 要求的 46 个英文名称全部是 FreeSWITCH 1.11.3 的枚举项和可转名称，未发现拼写错误、别名差异或无法追溯的原因。
- 官方版本确已定位；没有使用其他版本替代。
- `formatHangupCause` 中未收录项返回原英文字符串，与设计文档约定相符；空串原样返回也是设计要求。
