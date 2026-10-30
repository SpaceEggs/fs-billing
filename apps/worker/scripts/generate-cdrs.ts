import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import {
  connect,
  databaseEnvironmentSchema,
  loadDeletedMonths,
  loadRatingTenant,
  schema,
  withSystem,
} from '@fs-billing/db';
import {
  decimal,
  findRate,
  parseDialedNumber,
  priceCall,
  versionAt,
  type Currency,
  type Tenant,
} from '@fs-billing/rating';

const DAY = 86400000;
export function shanghaiDate(date: Date): string {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
function dateMs(day: string): number {
  const value = Date.parse(`${day}T00:00:00+08:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(value) ||
    shanghaiDate(new Date(value)) !== day
  )
    throw new Error('Invalid date');
  return value;
}
function hash(input: string) {
  return createHash('sha256').update(input).digest();
}
export function callUuid(
  seed: string,
  tenant: string,
  day: string,
  index: number,
): string {
  const b = hash(`fs-billing-synthetic-v1:${seed}:${tenant}:${day}:${index}`);
  b[6] = (b[6]! & 15) | 0x50;
  b[8] = (b[8]! & 63) | 0x80;
  const h = b.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function syntheticCaller(seed: string, tenant: string): string {
  const value = hash(
    `fs-billing-synthetic-caller:${seed}:${tenant}`,
  ).readBigUInt64BE(0);
  return `1${(value % 10000000000n).toString().padStart(10, '0')}`;
}
function randomFor(key: string) {
  let n = 0;
  return () => hash(`${key}:${n++}`).readUInt32BE(0) / 0x100000000;
}
export function buildCdr(input: {
  uuid: string;
  tenant: string;
  caller: string;
  number: string;
  start: number;
  billsec: number;
  ring: number;
}) {
  const { uuid, tenant, caller, number, start, billsec, ring } = input;
  return {
    variables: {
      uuid,
      billing_tenant: tenant,
      caller_id_number: caller,
      destination_number: `+${number}`,
      billing_dialed_number: `+${number}`,
      billing_number: number,
      start_epoch: String(start),
      answer_epoch: String(billsec ? start + ring : 0),
      end_epoch: String(start + ring + billsec),
      duration: String(ring + billsec),
      billsec: String(billsec),
      hangup_cause: billsec ? 'NORMAL_CLEARING' : 'NO_ANSWER',
    },
  };
}
export function fitsSpend(spent: string, charge: string, cap: string): boolean {
  return decimal(spent).plus(decimal(charge)).lte(decimal(cap));
}
type Call = {
  body: ReturnType<typeof buildCdr>;
  charge: string;
  billsec: number;
};
export function planDay(
  tenant: Tenant<Currency>,
  id: string,
  caller: string,
  day: string,
  seed: string,
  min: number,
  max: number,
  now: number,
): Call[] {
  const rnd = randomFor(`${seed}:${id}:${day}`);
  const weekend = [0, 6].includes(
    new Date(dateMs(day) + 8 * 3600000).getUTCDay(),
  );
  // These calculations generate call counts and durations, not money.
  /* eslint-disable money/no-number-money */
  const count = Math.round(
    (min + Math.floor(rnd() * (max - min + 1))) * (weekend ? 0.3 : 1),
  );
  const calls: Call[] = [];
  for (let i = 0; i < count; i++) {
    const period = rnd();
    const hour =
      period < 0.43
        ? 9 + rnd() * 3
        : period < 0.48
          ? 12 + rnd()
          : period < 0.94
            ? 13 + rnd() * 5
            : 18 + rnd() * 4;
    const start = Math.floor((dateMs(day) + hour * 3600000) / 1000);
    const ring = 3 + Math.floor(rnd() * 18);
    const billsec =
      rnd() < 0.15
        ? 0
        : rnd() < 0.06
          ? 300 + Math.floor(rnd() * 1501)
          : 30 + Math.floor(Math.pow(rnd(), 1.8) * 271);
    if ((start + ring + billsec) * 1000 > now) continue;
    /* eslint-enable money/no-number-money */
    const answer = new Date((start + ring) * 1000);
    const entries =
      versionAt(tenant.rates, answer)?.entries.filter((e) =>
        /^[1-9][0-9]{0,14}$/.test(e.prefix),
      ) ?? [];
    if (!entries.length) continue;
    const sorted = [...entries].sort(
      (a, b) =>
        a.perMinute.perMinute.comparedTo(b.perMinute.perMinute) ||
        a.prefix.localeCompare(b.prefix),
    );
    const entry =
      sorted[
        Math.min(
          sorted.length - 1,
          Math.floor(Math.pow(rnd(), 2) * sorted.length),
        )
      ]!;
    const length = Math.max(6, Math.min(15, Math.max(11, entry.prefix.length)));
    let number = entry.prefix;
    while (number.length < length) number += Math.floor(rnd() * 10);
    const parsed = parseDialedNumber(number);
    const matched = parsed && findRate(tenant.rates, parsed, answer);
    if (!matched) continue;
    calls.push({
      body: buildCdr({
        uuid: callUuid(seed, id, day, i),
        tenant: tenant.code,
        caller,
        number,
        start,
        billsec,
        ring,
      }),
      charge: priceCall(billsec, matched.perMinute).charge.value.toFixed(),
      billsec,
    });
  }
  return calls.sort(
    (a, b) =>
      Number(a.body.variables.start_epoch) -
      Number(b.body.variables.start_epoch),
  );
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((v, i) => !(i === 0 && v === '--')),
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      tenant: { type: 'string', multiple: true },
      'per-day': { type: 'string', default: '20-60' },
      'max-spend': { type: 'string' },
      seed: { type: 'string', default: '1' },
      'dry-run': { type: 'boolean', default: false },
      'worker-url': { type: 'string', default: 'http://127.0.0.1:3001' },
    },
  });
  const match = /^(\d+)-(\d+)$/.exec(values['per-day']);
  if (
    !match ||
    Number(match[1]) > Number(match[2]) ||
    Number(match[2]) > 10000 ||
    !/^-?\d+$/.test(values.seed)
  )
    throw new Error('Invalid per-day or seed');
  if (
    values['max-spend'] !== undefined &&
    (!/^\d+(?:\.\d+)?$/.test(values['max-spend']) ||
      decimal(values['max-spend']).isNegative())
  )
    throw new Error('Invalid max-spend');
  if (values.from) dateMs(values.from);
  if (values.to) dateMs(values.to);
  const url = new URL(values['worker-url']);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid worker URL');
  const env = databaseEnvironmentSchema.shape.APP_DATABASE_URL.safeParse(
    process.env.APP_DATABASE_URL,
  );
  if (!env.success || (!values['dry-run'] && !process.env.WORKER_SHARED_KEY))
    throw new Error('APP_DATABASE_URL and WORKER_SHARED_KEY are required');
  const connection = connect(env.data, { max: 2 });
  try {
    const tenants = await withSystem(connection.db, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.status, 'active'));
      const selected = rows.filter(
        (t) =>
          !values.tenant?.length ||
          values.tenant.some(
            (v) => v.toUpperCase() === t.code.toUpperCase() || v === t.id,
          ),
      );
      if (
        values.tenant?.some(
          (v) =>
            !selected.some(
              (t) => v === t.id || v.toUpperCase() === t.code.toUpperCase(),
            ),
        )
      )
        throw new Error('Tenant not found or inactive');
      const tenants = [];
      for (const t of selected) {
        const rating = await loadRatingTenant(tx, t.code);
        const history = await tx
          .select({
            caller: schema.cdrs.caller,
            startedAt: schema.cdrs.startedAt,
          })
          .from(schema.cdrs)
          .where(eq(schema.cdrs.tenantId, t.id))
          .orderBy(sql`${schema.cdrs.startedAt} desc`)
          .limit(100);
        const deleted = await loadDeletedMonths(tx, t.id);
        tenants.push({ ...t, rating, history, deleted });
      }
      return tenants;
    });
    const now = Date.now();
    const to = values.to ?? shanghaiDate(new Date(now));
    let failed = false;
    for (const t of tenants) {
      const caller =
        t.history.find((h) => h.caller.trim())?.caller ??
        syntheticCaller(values.seed, t.code);
      if (!t.rating) {
        console.error(`${t.code}: skipped (no rating or balance data)`);
        failed = true;
        continue;
      }
      const from =
        values.from ??
        (t.history[0]
          ? shanghaiDate(
              new Date(dateMs(shanghaiDate(t.history[0].startedAt)) + DAY),
            )
          : `${shanghaiDate(new Date(now)).slice(0, 7)}-01`);
      const available = t.rating.balance.value;
      const cap = available.isNegative() ? decimal('0') : available;
      if (cap.isZero()) {
        console.log(`${t.code}: skipped (balance <= 0)`);
        continue;
      }
      const requested =
        values['max-spend'] === undefined ? cap : decimal(values['max-spend']);
      const limit = requested.lt(cap) ? requested : cap;
      let spent = decimal('0');
      let seconds = 0;
      const calls: Call[] = [];
      days: for (let day = dateMs(from); day <= dateMs(to); day += DAY) {
        const date = shanghaiDate(new Date(day));
        if (t.deleted.has(`${date.slice(0, 7)}-01`)) continue;
        for (const call of planDay(
          t.rating,
          t.id,
          caller,
          date,
          values.seed,
          Number(match[1]),
          Number(match[2]),
          now,
        )) {
          if (!fitsSpend(spent.toFixed(), call.charge, limit.toFixed()))
            break days;
          spent = spent.plus(call.charge);
          seconds += call.billsec;
          calls.push(call);
        }
      }
      console.log(
        `${t.code}: planned ${calls.length}, minutes ${(seconds / 60).toFixed(2)}, estimated ${spent.toFixed(4)} ${t.currency}`,
      );
      if (values['dry-run']) continue;
      let accepted = 0,
        duplicate = 0,
        errors = 0,
        stop = false,
        cursor = 0;
      const send = async () => {
        while (!stop) {
          const call = calls[cursor++];
          if (!call) return;
          try {
            let response: Response | undefined;
            for (let attempt = 0; attempt < 4; attempt++) {
              response = await fetch(new URL('/cdr', url), {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-billing-key': process.env.WORKER_SHARED_KEY!,
                },
                body: JSON.stringify(call.body),
                signal: AbortSignal.timeout(15000),
              });
              if (response.status < 500 || attempt === 3) break;
              await new Promise((resolve) =>
                setTimeout(resolve, 250 * (attempt + 1)),
              );
            }
            if (!response) throw new Error('No response');
            if (response.status >= 400 && response.status < 500) {
              stop = true;
              errors++;
              console.error(
                `HTTP ${response.status}: ${await response.text()}`,
              );
              continue;
            }
            if (!response.ok) {
              errors++;
              continue;
            }
            const result: unknown = await response.json();
            const status =
              typeof result === 'object' &&
              result !== null &&
              'status' in result
                ? result.status
                : undefined;
            if (status === 'queued') accepted++;
            else if (status === 'duplicate') duplicate++;
            else {
              errors++;
              stop = true;
              console.error(`Unexpected ingest status: ${String(status)}`);
            }
          } catch {
            errors++;
            stop = true;
            console.error('Request failed');
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(4, calls.length) }, () => send()),
      );
      console.log(
        `${t.code}: accepted ${accepted}, duplicate ${duplicate}, failed ${errors}, unsent ${calls.length - Math.min(cursor, calls.length)}`,
      );
      if (errors) {
        failed = true;
        break;
      }
    }
    if (failed) process.exitCode = 1;
  } finally {
    await connection.pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Generator failed; check arguments, configuration, and database availability',
    );
    process.exitCode = 1;
  });
