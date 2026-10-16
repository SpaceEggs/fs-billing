import {
  currencySchema,
  type AdminCurrencyTotals,
  type AdminLedgerEntry,
  type AdminReceivable,
  type AdminReceivableStatus,
  type Currency,
  type Money,
} from '@fs-billing/shared';
import Decimal from 'decimal.js';
import { queryOptions } from '@tanstack/react-query';
import { apiKey, send } from './admin-api';
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
 * 收款操作（确认、撤销确认、作废）的 409：页面数据已过时。列表随即刷新，由管理员核对后重新操作，不自动重试。
 * 刷新是否完成由对话框另行说明，这里的文案不预先声称“已刷新”。
 */
const confirmStale = {
  ALREADY_RECEIVED: '该笔已确认收款，可能已由其他管理员处理。',
  SETTLEMENT_CONFLICT:
    '该笔的收款状态已变化（例如确认后又被撤销），请核对后重新确认。',
  RECEIVABLE_VOIDED: '该笔应收已作废，不能再确认收款。',
};
const reverseStale = {
  SETTLEMENT_CONFLICT:
    '该笔的收款确认已变化（可能已被撤销或重新确认），请核对后再操作。',
  RECEIVABLE_VOIDED: '该笔应收已作废，不能撤销确认。',
};
const voidStale = {
  ALREADY_RECEIVED: '该笔已确认收款，须先撤销确认才能作废。',
  RECEIVABLE_VOIDED: '该笔应收已作废，可能已由其他管理员处理。',
  RECEIVABLE_REVERSAL_MISMATCH:
    '所选调账不能用于冲正：金额须恰为赊账金额的相反数、晚于赊账，且未被其他作废使用或被之后的反向调账抵消。',
};

export type ReceivableActionFailure<Field extends string> =
  /** 状态已变：刷新列表，本对话框不能再提交（打开时的快照已过时）。 */
  | { kind: 'stale'; message: string }
  /** 服务端逐字段校验失败。 */
  | { kind: 'fields'; errors: Partial<Record<Field, string>> }
  /** 网络中断：结果未知，刷新列表；可用原快照手动再试（设计文档 L169）。 */
  | { kind: 'unknown' }
  /** 其余失败（限流、服务不可用等）按通用说明显示。 */
  | { kind: 'general' };

function actionFailure<Field extends string>(
  error: unknown,
  stale: Partial<Record<string, string>>,
  fields: readonly Field[],
): ReceivableActionFailure<Field> {
  if (error instanceof ApiRequestError && error.status === 0)
    return { kind: 'unknown' };
  const problem = apiProblem(error);
  if (problem.kind === 'conflict')
    return { kind: 'stale', message: stale[problem.code] ?? problem.message };
  if (problem.kind === 'not-found')
    return { kind: 'stale', message: '该笔应收不存在或已被删除。' };
  if (problem.kind === 'validation') {
    const issues = fieldIssues(problem);
    const errors: Partial<Record<Field, string>> = {};
    for (const field of fields) {
      const message = issues.get(field);
      if (message) errors[field] = message;
    }
    if (Object.keys(errors).length) return { kind: 'fields', errors };
  }
  return { kind: 'general' };
}

export type ConfirmPaymentFailure = ReceivableActionFailure<
  keyof ConfirmPaymentDraft
>;
export const confirmPaymentFailure = (error: unknown): ConfirmPaymentFailure =>
  actionFailure(error, confirmStale, ['receivedOn', 'note']);
export const reversePaymentFailure = (error: unknown) =>
  actionFailure(error, reverseStale, ['reason']);
export const voidReceivableFailure = (error: unknown) =>
  actionFailure(error, voidStale, ['reason']);

/** 撤销确认与作废的原因：必填、去空白后非空、最多 2000 字（契约同规则）。 */
export function validateReason(reason: string): string | undefined {
  if (!reason.trim()) return '请填写原因';
  if (reason.length > 2000) return '原因最多 2000 字';
  return undefined;
}

/**
 * 作废可选的冲正调账（G2）：同一租户、金额恰为赊账金额相反数（decimal.js 比较，-500.0000 等于 -500.00）、
 * 时间严格晚于赊账。`ledger.tenantId` 是这批流水所属租户，不是该应收的租户时没有候选。
 * 是否真能用于冲正（未被其他作废使用、之后没有反向调账抵消）仍由服务端判定。
 */
export function reversalCandidates(
  receivable: AdminReceivable,
  ledger: { tenantId: string; items: readonly AdminLedgerEntry[] },
): AdminLedgerEntry[] {
  if (ledger.tenantId !== receivable.tenant.id) return [];
  const target = new Decimal(receivable.amount).negated();
  const after = Date.parse(receivable.createdAt);
  return ledger.items.filter(
    (entry) =>
      entry.kind === 'adjustment' &&
      new Decimal(entry.amount).eq(target) &&
      Date.parse(entry.occurredAt) > after,
  );
}

/** 待收款页的三种视图（G1）：标题、合计标签与空状态文案。 */
export const receivableViews = {
  pending: {
    label: '待收款',
    empty: { title: '所有赊账均已收款', hint: '新的赊账充值会出现在这里' },
  },
  received: {
    label: '已收款',
    empty: { title: '还没有已收款的赊账', hint: '确认收款后会出现在这里' },
  },
  voided: {
    label: '已作废',
    empty: { title: '没有已作废的赊账', hint: '作废的赊账会出现在这里' },
  },
} as const satisfies Record<
  AdminReceivableStatus,
  { label: string; empty: { title: string; hint: string } }
>;

/**
 * 确认失败（409 或网络中断）后列表是否已与服务端核对。不比较时间戳：每次列表请求（含自动重试）
 * 领一个递增序号，成功的响应带上序号，失败的错误按序号登记。发起核对时记下已发出的最大序号（`mark`），
 * 此后发出的请求成功才算核对完成；此后发出的请求失败且没有请求在途时为失败，由管理员重试。
 * 序号随页面重新挂载从头计，而缓存的响应活得更久，所以响应还带上发号器身份，别的发号器的响应不算核对结果。
 */
export type ListRefresh = 'fresh' | 'refreshing' | 'failed';

type Request = { sequencer: symbol; number: number };

export type Sequenced<Data> = Data & { request: Request };

export function sequencedRequests() {
  const sequencer = Symbol('list requests');
  let issued = 0;
  const failures = new WeakMap<object, number>();
  return {
    wrap<Data extends object>(fetch: () => Promise<Data>) {
      return async (): Promise<Sequenced<Data>> => {
        const number = ++issued;
        try {
          return { ...(await fetch()), request: { sequencer, number } };
        } catch (error) {
          if (typeof error === 'object' && error !== null)
            failures.set(error, number);
          throw error;
        }
      };
    },
    mark: () => issued,
    refresh(
      mark: number | undefined,
      list: {
        data: { request: Request } | undefined;
        error: unknown;
        isFetching: boolean;
      },
    ): ListRefresh {
      const request = list.data?.request;
      if (
        mark === undefined ||
        (request?.sequencer === sequencer && request.number > mark)
      )
        return 'fresh';
      const failed =
        typeof list.error === 'object' && list.error !== null
          ? (failures.get(list.error) ?? 0)
          : 0;
      return failed > mark && !list.isFetching ? 'failed' : 'refreshing';
    },
  };
}

/** 作废对话框最多翻这么多条调账流水（每页 100），超过时说明未全部列出。 */
export const adjustmentScanLimit = 1000;

/** 该应收所属租户自赊账时起的调账流水（新到旧），用于挑选冲正候选。 */
export function adjustmentsSince(receivable: AdminReceivable) {
  const tenantId = receivable.tenant.id;
  const pageSize = 100;
  const query = {
    kind: 'adjustment' as const,
    from: receivable.createdAt,
    pageSize,
  };
  return queryOptions({
    queryKey: [
      ...apiKey('adminTenantLedger', { params: { tenantId }, query }),
      'all',
    ],
    queryFn: async () => {
      const items: AdminLedgerEntry[] = [];
      for (let page = 1; ; page += 1) {
        const result = await send('adminTenantLedger', {
          params: { tenantId },
          query: { ...query, page },
        });
        items.push(...result.items);
        const done =
          result.items.length === 0 || items.length >= result.pagination.total;
        if (done || items.length >= adjustmentScanLimit)
          return { tenantId, items, truncated: !done };
      }
    },
  });
}

/** 确认人、作废人的姓名（G10）：管理员很少，全部取回一次后缓存；账号变更会使其失效。 */
export const adminNames = queryOptions({
  queryKey: [...apiKey('adminAccounts'), 'names'],
  staleTime: 5 * 60_000,
  queryFn: async () => {
    const names = new Map<string, string>();
    for (let page = 1; page <= 10; page += 1) {
      const result = await send('adminAccounts', {
        query: { page, pageSize: 100 },
      });
      for (const account of result.items) names.set(account.id, account.name);
      if (page * result.pagination.pageSize >= result.pagination.total) break;
    }
    return names;
  },
});

/** 未找到（或尚未取回）的管理员显示「—」。 */
export const adminName = (names: Map<string, string> | undefined, id: string) =>
  names?.get(id) ?? '—';
