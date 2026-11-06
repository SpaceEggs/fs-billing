import {
  DEFAULT_LOCALE,
  formatHangupCause,
  formatMergedChargeNote,
  translate,
  type Locale,
  type PortalLedgerRow,
} from '@fs-billing/shared';

export type CdrExportRow = {
  calledAt: string;
  caller: string;
  callee: string;
  direction: 'outbound' | 'inbound';
  country: string | null;
  iso: string | null;
  description: string | null;
  durationSeconds: number;
  billedMinutes: string;
  rate: string | null;
  charge: string;
  hangupCause: string;
  matchedPrefix: string | null;
  callUuid: string;
  startedAt: string;
  endedAt: string;
};

export type LedgerExportRow = {
  kind: PortalLedgerRow['kind'];
  day: string;
  calls: number;
  partial: boolean;
  occurredAt: string;
  amount: string;
  balanceAfter: string;
  note: string;
  noteKey: string | null;
};

const CDR_HEADER_KEYS = [
  'answeredAt',
  'caller',
  'callee',
  'iso',
  'country',
  'description',
  'durationSeconds',
  'billedMinutes',
  'rate',
  'charge',
  'startedAt',
  'endedAt',
  'hangupCause',
  'matchedPrefix',
  'callUuid',
] as const;

/** 话单表头；后台在末尾多两列（验证状态、方向），由调用方追加。 */
export function cdrHeaders(locale: Locale = DEFAULT_LOCALE): string[] {
  return CDR_HEADER_KEYS.map((key) =>
    translate(locale, `csv:cdr.headers.${key}`),
  );
}

export function directionLabel(
  direction: 'outbound' | 'inbound',
  locale: Locale = DEFAULT_LOCALE,
): string {
  return translate(locale, `csv:cdr.direction.${direction}`);
}

export function unansweredLabel(locale: Locale = DEFAULT_LOCALE): string {
  return translate(locale, 'csv:cdr.unanswered');
}

export function unverifiedLabel(locale: Locale = DEFAULT_LOCALE): string {
  return translate(locale, 'csv:cdr.unverified');
}

export function ledgerHeaders(
  currency: string,
  locale: Locale = DEFAULT_LOCALE,
): string[] {
  return [
    translate(locale, 'csv:ledger.headers.time'),
    translate(locale, 'csv:ledger.headers.kind'),
    translate(locale, 'csv:ledger.headers.amount', { currency }),
    translate(locale, 'csv:ledger.headers.balanceAfter', { currency }),
    translate(locale, 'csv:ledger.headers.note'),
  ];
}

function cdrBaseCells(row: CdrExportRow, locale: Locale): readonly string[] {
  return [
    row.calledAt,
    row.caller,
    row.callee,
    row.iso ?? '',
    row.country ?? unansweredLabel(locale),
    row.description ?? '',
    String(row.durationSeconds),
    row.billedMinutes,
    row.rate ?? '',
    row.charge,
    row.startedAt,
    row.endedAt,
    formatHangupCause(row.hangupCause, locale),
    row.matchedPrefix ?? '',
    row.callUuid,
  ];
}

export function cdrCells(
  row: CdrExportRow,
  locale: Locale = DEFAULT_LOCALE,
): readonly string[] {
  return [...cdrBaseCells(row, locale), directionLabel(row.direction, locale)];
}

export function adminCdrCells(
  row: CdrExportRow & { unverified: boolean },
  locale: Locale = DEFAULT_LOCALE,
): readonly string[] {
  return [
    ...cdrBaseCells(row, locale),
    row.unverified ? unverifiedLabel(locale) : '',
    directionLabel(row.direction, locale),
  ];
}

function ledgerKindLabel(
  kind: PortalLedgerRow['kind'],
  locale: Locale,
): string {
  switch (kind) {
    case 'recharge':
      return translate(locale, 'enums:ledger.kind.recharge');
    case 'gift':
      return translate(locale, 'enums:ledger.kind.gift');
    case 'adjustment':
      return translate(locale, 'enums:ledger.kind.adjustment');
    case 'call_charge':
      return translate(locale, 'enums:ledger.kind.callCharge');
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function ledgerCells(
  row: LedgerExportRow,
  locale: Locale = DEFAULT_LOCALE,
): readonly string[] {
  let note = row.note;
  if (row.kind === 'call_charge') {
    note = formatMergedChargeNote(
      { day: row.day, calls: row.calls, partial: row.partial },
      locale,
    );
  } else if (row.noteKey !== null) {
    note = translate(locale, `enums:${row.noteKey}`);
  }
  return [
    row.occurredAt,
    ledgerKindLabel(row.kind, locale),
    row.amount,
    row.balanceAfter,
    note,
  ];
}
