const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** 一通已接通的话单（英国手机，4 分钟，北京时间 2026-10-16 18:00:00 接通）。 */
export function answeredCdr(n = 1, over: Record<string, unknown> = {}) {
  return {
    callUuid: uuid(n),
    startedAt: '2026-10-16T09:59:50.000Z',
    answeredAt: '2026-10-16T10:00:00.000Z',
    endedAt: '2026-10-16T10:03:50.000Z',
    caller: '075586001234',
    callee: '+447700900123',
    country: '英国',
    iso: 'GB',
    description: '手机',
    matchedPrefix: '447',
    durationSeconds: 230,
    billedMinutes: '4',
    rate: '0.0450',
    charge: '0.18',
    hangupCause: 'NORMAL_CLEARING',
    ...over,
  };
}

/** 一通未接通的话单：没有国家、前缀、费率，时长与费用为 0。 */
export function unansweredCdr(n = 2, over: Record<string, unknown> = {}) {
  return answeredCdr(n, {
    answeredAt: null,
    startedAt: '2026-10-16T08:00:00.000Z',
    endedAt: '2026-10-16T08:00:20.000Z',
    callee: '8613800138000',
    country: null,
    iso: null,
    description: null,
    matchedPrefix: null,
    durationSeconds: 0,
    billedMinutes: '0',
    rate: null,
    charge: '0',
    hangupCause: 'CALL_REJECTED',
    ...over,
  });
}

export function cdrList(
  items: unknown[],
  over: {
    total?: number;
    page?: number;
    unansweredCalls?: number;
    unverifiedCalls?: number;
    billedMinutes?: string;
    charge?: string;
    /** 仅后台响应（带 unverifiedCalls）有：范围内话单已删除的月份。 */
    deletedMonths?: unknown[];
  } = {},
) {
  return {
    currency: 'CNY',
    items,
    pagination: {
      page: over.page ?? 1,
      pageSize: 50,
      total: over.total ?? items.length,
    },
    summary: {
      billedMinutes: over.billedMinutes ?? '4',
      charge: over.charge ?? '0.18',
      unansweredCalls: over.unansweredCalls ?? 0,
      ...(over.unverifiedCalls === undefined
        ? {}
        : { unverifiedCalls: over.unverifiedCalls }),
    },
    ...(over.unverifiedCalls === undefined
      ? {}
      : { deletedMonths: over.deletedMonths ?? [] }),
  };
}
