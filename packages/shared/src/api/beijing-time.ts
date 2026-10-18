export type BeijingDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const beijingFormatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
  calendar: 'gregory',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: '2-digit',
  numberingSystem: 'latn',
  second: '2-digit',
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
});

function numberPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const part = parts.find((candidate) => candidate.type === type);
  if (part === undefined) throw new Error(`Missing date-time part: ${type}`);
  return Number(part.value);
}

/** Calendar/time fields in the IANA Asia/Shanghai zone, including historical offsets. */
export function beijingDateTimeParts(
  value: string | Date,
): BeijingDateTimeParts {
  const instant = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(instant.getTime()))
    throw new RangeError(`Invalid date: ${String(value)}`);
  const parts = beijingFormatter.formatToParts(instant);
  return {
    year: numberPart(parts, 'year'),
    month: numberPart(parts, 'month'),
    day: numberPart(parts, 'day'),
    hour: numberPart(parts, 'hour'),
    minute: numberPart(parts, 'minute'),
    second: numberPart(parts, 'second'),
  };
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Beijing civil date as YYYY-MM-DD, with four-digit years for years 0001–9999. */
export function beijingDateOf(value: string | Date): string {
  const { year, month, day } = beijingDateTimeParts(value);
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}
