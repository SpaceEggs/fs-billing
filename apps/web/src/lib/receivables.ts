import {
  currencySchema,
  type AdminCurrencyTotals,
  type AdminReceivable,
  type Currency,
  type Money,
} from '@fs-billing/shared';
import { ApiRequestError } from './api';
import { apiProblem, fieldIssues } from './api-problem';
import { formatDate } from './format';

/**
 * 合计卡片：CNY、USD 各自一张，不相加。服务端在币种筛选时把另一币种置为 "0"，
 * 那只是固定的响应结构，不代表该币种没有应收，所以选了币种只显示该币种（设计文档 L108）。
 * 金额原样保留十进制字符串，显示时由 decimal.js 格式化，不经浮点数。
 */
export function visibleTotals(
  totals: AdminCurrencyTotals,
  currency: Currency | undefined,
): Money[] {
  return currencySchema.options
    .filter((option) => currency === undefined || option === currency)
    .map((option) => ({ currency: option, amount: totals[option] }));
}

export type ConfirmPaymentDraft = { receivedOn: string; note: string };
export type ConfirmPaymentErrors = Partial<
  Record<keyof ConfirmPaymentDraft, string>
>;

/** 收款日期的可选范围：赊账当天（北京时间）到今天（北京时间）。 */
export function receivedOnBounds(receivable: AdminReceivable, now: Date) {
  return { min: formatDate(receivable.createdAt), max: formatDate(now) };
}

export function validateConfirmPayment(
  draft: ConfirmPaymentDraft,
  bounds: { min: string; max: string },
): ConfirmPaymentErrors {
  const errors: ConfirmPaymentErrors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.receivedOn))
    errors.receivedOn = '请选择实际收款日期';
  else if (draft.receivedOn > bounds.max)
    errors.receivedOn = '收款日期不能晚于今天（北京时间）';
  else if (draft.receivedOn < bounds.min)
    errors.receivedOn = `收款日期不能早于赊账日期 ${bounds.min}`;
  if (draft.note.length > 2000) errors.note = '备注最多 2000 字';
  return errors;
}

/**
 * 确认收款的 409：页面数据已过时。列表随即刷新，由管理员核对后重新确认，不自动重试。
 * 刷新是否完成由对话框另行说明，这里的文案不预先声称“已刷新”。
 */
const staleMessages = {
  ALREADY_RECEIVED: '该笔已确认收款，可能已由其他管理员处理。',
  SETTLEMENT_CONFLICT:
    '该笔的收款状态已变化（例如确认后又被撤销），请核对后重新确认。',
  RECEIVABLE_VOIDED: '该笔应收已作废，不能再确认收款。',
} as const;

export type ConfirmPaymentFailure =
  /** 状态已变：刷新列表，本对话框不能再提交（令牌已过时）。 */
  | { kind: 'stale'; message: string }
  /** 服务端逐字段校验失败。 */
  | { kind: 'fields'; errors: ConfirmPaymentErrors }
  /** 网络中断：结果未知，刷新列表；可用原令牌手动再试（设计文档 L169）。 */
  | { kind: 'unknown' }
  /** 其余失败（限流、服务不可用等）按通用说明显示。 */
  | { kind: 'general' };

export function confirmPaymentFailure(error: unknown): ConfirmPaymentFailure {
  if (error instanceof ApiRequestError && error.status === 0)
    return { kind: 'unknown' };
  const problem = apiProblem(error);
  if (problem.kind === 'conflict') {
    switch (problem.code) {
      case 'ALREADY_RECEIVED':
      case 'SETTLEMENT_CONFLICT':
      case 'RECEIVABLE_VOIDED':
        return { kind: 'stale', message: staleMessages[problem.code] };
      default:
        return { kind: 'stale', message: problem.message };
    }
  }
  if (problem.kind === 'not-found')
    return { kind: 'stale', message: '该笔应收不存在或已被删除。' };
  if (problem.kind === 'validation') {
    const fields = fieldIssues(problem);
    const errors: ConfirmPaymentErrors = {};
    const receivedOn = fields.get('receivedOn');
    const note = fields.get('note');
    if (receivedOn) errors.receivedOn = receivedOn;
    if (note) errors.note = note;
    if (Object.keys(errors).length) return { kind: 'fields', errors };
  }
  return { kind: 'general' };
}

/**
 * 确认失败（409 或网络中断）后列表是否已与服务端核对：`flaggedAt` 是发起刷新的时间，
 * 此后有一次成功的列表请求才算核对完成；刷新失败时保留“失败”，由管理员重试。
 */
export type ListRefresh = 'fresh' | 'refreshing' | 'failed';

export function listRefresh(
  flaggedAt: number | undefined,
  list: { dataUpdatedAt: number; isError: boolean; isFetching: boolean },
): ListRefresh {
  if (flaggedAt === undefined || list.dataUpdatedAt >= flaggedAt)
    return 'fresh';
  return list.isError && !list.isFetching ? 'failed' : 'refreshing';
}
