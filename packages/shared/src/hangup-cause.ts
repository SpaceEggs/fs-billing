/**
 * FreeSWITCH 挂断原因（cdrs.hangup_cause 存的是 switch_cause_t 的名字）的中文对照。
 * 门户与后台的话单详情、CSV 导出共用这一张表。未收录的原因只显示英文原文。
 */
export const HANGUP_CAUSE_LABELS = {
  NORMAL_CLEARING: '正常挂断',
  NORMAL_UNSPECIFIED: '正常结束，未说明原因',
  ORIGINATOR_CANCEL: '主叫在接通前取消',
  NO_ANSWER: '无人应答',
  NO_USER_RESPONSE: '被叫无响应',
  USER_BUSY: '被叫忙',
  CALL_REJECTED: '被叫拒接',
  SUBSCRIBER_ABSENT: '被叫不在服务区',
  UNALLOCATED_NUMBER: '空号',
  NO_ROUTE_DESTINATION: '没有到达该号码的路由',
  NO_ROUTE_TRANSIT_NET: '没有到达中转网络的路由',
  INVALID_NUMBER_FORMAT: '号码格式错误',
  NUMBER_CHANGED: '号码已变更',
  DESTINATION_OUT_OF_ORDER: '被叫线路故障',
  NETWORK_OUT_OF_ORDER: '网络故障',
  NORMAL_TEMPORARY_FAILURE: '临时故障',
  NORMAL_CIRCUIT_CONGESTION: '线路拥塞',
  SWITCH_CONGESTION: '交换设备拥塞',
  REQUESTED_CHAN_UNAVAIL: '请求的通道不可用',
  EXCHANGE_ROUTING_ERROR: '路由错误',
  FACILITY_REJECTED: '业务被拒绝',
  FACILITY_NOT_SUBSCRIBED: '未开通该业务',
  OUTGOING_CALL_BARRED: '呼出受限',
  INCOMING_CALL_BARRED: '呼入受限',
  BEARERCAPABILITY_NOTAUTH: '承载能力未授权',
  BEARERCAPABILITY_NOTAVAIL: '承载能力不可用',
  SERVICE_UNAVAILABLE: '服务不可用',
  INCOMPATIBLE_DESTINATION: '目的地不兼容',
  RECOVERY_ON_TIMER_EXPIRE: '信令超时',
  PROTOCOL_ERROR: '协议错误',
  INTERWORKING: '网络互通异常',
  ALLOTTED_TIMEOUT: '达到最长通话时长',
  MEDIA_TIMEOUT: '媒体超时',
  PROGRESS_TIMEOUT: '呼叫进展超时',
  USER_NOT_REGISTERED: '用户未注册',
  GATEWAY_DOWN: '网关不可用',
  MANAGER_REQUEST: '系统请求挂断',
  LOSE_RACE: '已由其他分支应答',
  PICKED_OFF: '被代接',
  BLIND_TRANSFER: '盲转接',
  ATTENDED_TRANSFER: '协商转接',
  BUSY_EVERYWHERE: '所有路径均忙',
  DECLINE: '被叫拒绝',
  DOES_NOT_EXIST_ANYWHERE: '号码不存在',
  NOT_ACCEPTABLE: '不接受该呼叫',
  UNWANTED: '被判定为骚扰呼叫',
} as const satisfies Record<string, string>;

export type KnownHangupCause = keyof typeof HANGUP_CAUSE_LABELS;

function isKnown(cause: string): cause is KnownHangupCause {
  return Object.hasOwn(HANGUP_CAUSE_LABELS, cause);
}

/** 已收录原因的中文名，未收录或为空时为 undefined。 */
export function hangupCauseLabel(cause: string): string | undefined {
  const name = cause.trim();
  return isKnown(name) ? HANGUP_CAUSE_LABELS[name] : undefined;
}

/**
 * 详情与导出里的显示文本，如「NORMAL_CLEARING（正常挂断）」。
 * 未收录的原因保留英文原文，空值（入库默认 ''）返回空串。
 */
export function formatHangupCause(cause: string): string {
  const name = cause.trim();
  const label = hangupCauseLabel(name);
  return label === undefined ? name : `${name}（${label}）`;
}
