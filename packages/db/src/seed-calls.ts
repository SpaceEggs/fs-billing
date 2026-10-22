import { createHash } from 'node:crypto';
import {
  beijingMonth,
  beijingTime,
  decimal,
  longestPrefix,
  normalizeDialedNumber,
  priceCall,
  type Currency,
  type RateEntry,
} from '@fs-billing/rating';

/**
 * ABC001 的逐通话单种子（阶段 7 决定 20）。
 *
 * 设计稿「客户门户 第二批.dc.html:592-633」的月账单：8 月（12 至 31 日）9,642 通、37,468 分钟、1,873.40，
 * 9 月（1 至 29 日）12,804 通、49,726 分钟、2,486.30，国家表与日表逐项相等。
 * 这里把它们还原成一通一条的话单：每个（日、国家）格子给出通话数与计费分钟，再展开成逐通话单。
 * 全部是确定性计算，没有随机数：同样的输入永远生成同样的 UUID、时间与费用，重复播种不增行。
 *
 * 金额不用浮点：每分钟费率只出现在最后的 `priceCall`（decimal.js）里。分配算法用的是整数分钟与
 * 「千分之一元/分钟」的整数单价，并在 `assertRateCard` 里与真实费率表逐项核对。
 */

export type CountryKey = 'CN' | 'JM' | 'UKM' | 'JP' | 'HK' | 'SG' | 'UK' | 'US';

interface CountrySpec {
  readonly key: CountryKey;
  /** 费率表里的国家名。「英国手机」（447）与「英国」（44）在费率表里都是 英国，账单按国家合并。 */
  readonly country: string;
  readonly prefix: string;
  /** 千分之一元/分钟；与费率表核对。 */
  readonly milliPerMinute: number;
  /** 费用整到分所需的最小分钟粒度（0.045 元/分钟要成对，0.028 元/分钟要 5 的倍数）。 */
  readonly grain: number;
  readonly callee: (n: number) => string;
}

const digits = (n: number, width: number) =>
  String(n % 10 ** width).padStart(width, '0');

const COUNTRIES: readonly CountrySpec[] = [
  {
    key: 'CN',
    country: '中国',
    prefix: '86',
    milliPerMinute: 50,
    grain: 1,
    callee: (n) => `138${digits(n, 8)}`,
  },
  {
    key: 'JM',
    country: '牙买加',
    prefix: '1876',
    milliPerMinute: 250,
    grain: 1,
    callee: (n) => `+1876555${digits(n, 4)}`,
  },
  {
    key: 'UKM',
    country: '英国',
    prefix: '447',
    milliPerMinute: 45,
    grain: 2,
    callee: (n) => `+4477${digits(n, 8)}`,
  },
  {
    key: 'JP',
    country: '日本',
    prefix: '81',
    milliPerMinute: 35,
    grain: 2,
    callee: (n) => `+8190${digits(n, 8)}`,
  },
  {
    key: 'HK',
    country: '中国香港',
    prefix: '852',
    milliPerMinute: 30,
    grain: 1,
    callee: (n) => `+8529${digits(n, 7)}`,
  },
  {
    key: 'SG',
    country: '新加坡',
    prefix: '65',
    milliPerMinute: 28,
    grain: 5,
    callee: (n) => `+659${digits(n, 7)}`,
  },
  {
    key: 'UK',
    country: '英国',
    prefix: '44',
    milliPerMinute: 20,
    grain: 1,
    callee: (n) => `+4420${digits(n, 8)}`,
  },
  {
    key: 'US',
    country: '美国/加拿大',
    prefix: '1',
    milliPerMinute: 10,
    grain: 1,
    callee: (n) => `+1415${digits(n, 7)}`,
  },
];
const KEYS = COUNTRIES.map((c) => c.key);
const specOf = (key: CountryKey) => COUNTRIES.find((c) => c.key === key)!;

/** [日, 当日通话费用（分）, 计费分钟, 通话数]，取自设计稿 genDays 的输出。 */
export type DayRow = readonly [number, number, number, number];

export const AUGUST_DAYS: readonly DayRow[] = [
  [12, 3150, 629, 163],
  [13, 9968, 1994, 515],
  [14, 10301, 2064, 528],
  [15, 10637, 2129, 550],
  [16, 10973, 2195, 565],
  [17, 9405, 1879, 482],
  [18, 7054, 1407, 365],
  [19, 7278, 1459, 376],
  [20, 10413, 2084, 535],
  [21, 10749, 2149, 550],
  [22, 11085, 2214, 572],
  [23, 9517, 1907, 491],
  [24, 9853, 1973, 506],
  [25, 7390, 1478, 383],
  [26, 7614, 1521, 392],
  [27, 10861, 2168, 557],
  [28, 11197, 2242, 574],
  [29, 9629, 1927, 498],
  [30, 9965, 1992, 513],
  [31, 10301, 2057, 527],
];

export const SEPTEMBER_DAYS: readonly DayRow[] = [
  [1, 8945, 1788, 461],
  [2, 9253, 1852, 477],
  [3, 9561, 1911, 490],
  [4, 9870, 1971, 511],
  [5, 7197, 1443, 373],
  [6, 6271, 1256, 322],
  [7, 9047, 1809, 463],
  [8, 9356, 1869, 483],
  [9, 9664, 1929, 497],
  [10, 9973, 1998, 512],
  [11, 10281, 2057, 533],
  [12, 6374, 1274, 329],
  [13, 6580, 1313, 337],
  [14, 9459, 1896, 485],
  [15, 9767, 1955, 505],
  [16, 10076, 2015, 519],
  [17, 8636, 1725, 442],
  [18, 8945, 1785, 463],
  [19, 6683, 1340, 346],
  [20, 6888, 1379, 354],
  [21, 9870, 1973, 505],
  [22, 10178, 2033, 525],
  [23, 8605, 1725, 444],
  [24, 8348, 1672, 429],
  [25, 9012, 1802, 467],
  [26, 8590, 1716, 443],
  [27, 8127, 1621, 416],
  [28, 8864, 1776, 454],
  [29, 4210, 843, 219],
];

/** 设计稿国家表：[通话数, 计费分钟]。 */
type CountryTotals = Readonly<Record<CountryKey, readonly [number, number]>>;

const AUGUST_COUNTRIES: CountryTotals = {
  CN: [7350, 28803],
  JM: [145, 700],
  UKM: [580, 2000],
  JP: [540, 2000],
  HK: [384, 1400],
  SG: [318, 1200],
  UK: [212, 900],
  US: [113, 465],
};

const SEPTEMBER_COUNTRIES: CountryTotals = {
  CN: [9820, 38476],
  JM: [186, 900],
  UKM: [812, 2800],
  JP: [704, 2600],
  HK: [466, 1700],
  SG: [398, 1500],
  UK: [236, 1000],
  US: [182, 750],
};

/** 每个月的通话窗口（北京时间）：开户日从 10 点起，9-29 在设计稿的「截至 14:03」之前。 */
const WINDOWS: Readonly<Record<string, readonly [string, string]>> = {
  '2026-08-12': ['10:00:00', '22:30:00'],
  '2026-09-29': ['00:00:30', '13:30:00'],
};
const DEFAULT_WINDOW: readonly [string, string] = ['00:00:30', '22:30:00'];

/** 种子里需要原样保留的已接通示例话单（并入 9 月分配，补写扣费流水）。 */
export interface FixedCall {
  readonly callUuid: string;
  readonly key: CountryKey;
  /** 北京时间。 */
  readonly startedAt: string;
  readonly ringSeconds: number;
  readonly talkSeconds: number;
  readonly caller: string;
  readonly callee: string;
  readonly hangupCause: string;
}

export interface PlannedCall {
  readonly callUuid: string;
  /** 通话所在北京日，YYYY-MM-DD。 */
  readonly day: string;
  readonly startedAt: Date;
  readonly answeredAt: Date;
  readonly endedAt: Date;
  readonly caller: string;
  readonly callee: string;
  readonly billingNumber: string;
  readonly durationSeconds: number;
  readonly billedMinutes: number;
  readonly key: CountryKey;
  readonly matchedPrefix: string;
  readonly country: string;
  readonly iso: string;
  readonly description: string;
  /** 每分钟费率，4 位小数。 */
  readonly perMinute: string;
  readonly charge: string;
  readonly hangupCause: string;
}

export interface CallPlanInput<C extends Currency> {
  /** 话单号码、租户代码等进入 UUID 的标签。 */
  readonly tenantCode: string;
  readonly entries: readonly RateEntry<C>[];
  readonly fixedCalls: readonly FixedCall[];
  readonly caller: string;
}

// ---------------------------------------------------------------------------------------------
// 分配：每个（日、国家）格子的分钟数与通话数

/** 最大余数法：把 `quota` 按权重分成整数，权重全为 0 时按下标顺序分。结果之和恒等于 quota。 */
function apportion(quota: number, weights: readonly number[]): number[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) {
    const even = weights.map(() => 0);
    for (let i = 0; i < quota; i++) even[i % even.length]!++;
    return even;
  }
  const shares = weights.map((w) => Math.floor((quota * w) / weightSum));
  const remainders = weights.map((w, i) => ({
    i,
    r: quota * w - shares[i]! * weightSum,
  }));
  let left = quota - shares.reduce((a, b) => a + b, 0);
  remainders.sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) shares[remainders[k]!.i]!++;
  return shares;
}

export interface MonthCells {
  /** minutes[key][i]、calls[key][i]：第 i 天该国家的计费分钟与通话数。 */
  readonly minutes: Readonly<Record<CountryKey, readonly number[]>>;
  readonly calls: Readonly<Record<CountryKey, readonly number[]>>;
}

/**
 * 把国家合计分配到每一天，使每天的费用、计费分钟、通话数都与设计稿日表一致，每个国家的合计与国家表一致。
 *
 * 1. 非 CN、非 US 的分钟按当日费用比例、以费用整到分的粒度分配；
 * 2. 当日剩余费用由 US（0.01 元/分钟）补零头、CN（0.05 元/分钟）吃整数部分，所以每天费用精确；
 * 3. 用「1 分钟 HK + 1 分钟 UK（0.03 + 0.02）= 1 分钟 CN（0.05）」的等价交换在天与天之间挪动分钟，
 *    保持费用与国家合计不变，把每天的分钟数调到设计稿的值；
 * 4. 通话数按分钟比例分配（每个有分钟的格子至少一通、不多于分钟数），再在天与天之间挪动到设计稿的值。
 */
export function allocateMonth(
  days: readonly DayRow[],
  byCountry: CountryTotals,
): MonthCells {
  const count = days.length;
  const dayGoal = days.map((d) => d[1] * 10); // 千分之一元
  const minutes = {} as Record<CountryKey, number[]>;
  for (const key of KEYS) {
    if (key === 'CN' || key === 'US') continue;
    const spec = specOf(key);
    const blocks = byCountry[key][1] / spec.grain;
    if (!Number.isInteger(blocks))
      throw new Error(`${key} 分钟数不是粒度的整数倍`);
    minutes[key] = apportion(blocks, dayGoal).map((b) => b * spec.grain);
  }
  const rest = days.map((_, i) =>
    (['JM', 'UKM', 'JP', 'HK', 'SG', 'UK'] as const).reduce(
      (sum, key) => sum + minutes[key][i]! * specOf(key).milliPerMinute,
      0,
    ),
  );
  const gap = dayGoal.map((goal, i) => goal - rest[i]!);
  // US 每分钟 10、CN 每分钟 50（千分之一元）：u ≡ gap/10 (mod 5)。
  const usBase = gap.map((g) => {
    if (g < 0 || g % 10 !== 0) throw new Error('当日费用无法用整分钟凑出');
    return (g / 10) % 5;
  });
  const usExtra = byCountry.US[1] - usBase.reduce((a, b) => a + b, 0);
  if (usExtra < 0 || usExtra % 5 !== 0)
    throw new Error('美国/加拿大分钟数无法凑出整分');
  const usSpread = apportion(usExtra / 5, gap);
  minutes.US = usBase.map((base, i) => base + 5 * usSpread[i]!);
  minutes.CN = gap.map((g, i) => {
    const left = g - 10 * minutes.US[i]!;
    if (left < 0 || left % 50 !== 0) throw new Error('中国分钟数无法凑出整分');
    return left / 50;
  });
  for (const key of KEYS) {
    if (minutes[key].reduce((a, b) => a + b, 0) !== byCountry[key][1])
      throw new Error(`${key} 分钟合计与国家表不符`);
  }

  const dayMinutes = () =>
    days.map((_, i) => KEYS.reduce((sum, key) => sum + minutes[key][i]!, 0));
  // 把每天分钟调到设计稿：天 i 多、天 j 少时，i 上 HK+UK 换成 CN，j 上 CN 换成 HK+UK。
  for (let guard = 0; guard < 100_000; guard++) {
    const diff = dayMinutes().map((m, i) => m - days[i]![2]);
    let over = 0;
    let under = 0;
    diff.forEach((d, i) => {
      if (d > diff[over]!) over = i;
      if (d < diff[under]!) under = i;
    });
    if (diff[over]! <= 0 || diff[under]! >= 0) break;
    if (
      minutes.HK[over]! < 1 ||
      minutes.UK[over]! < 1 ||
      minutes.CN[under]! < 1
    )
      throw new Error('无法把当日分钟调到设计稿的值');
    minutes.HK[over]!--;
    minutes.UK[over]!--;
    minutes.CN[over]!++;
    minutes.CN[under]!--;
    minutes.HK[under]!++;
    minutes.UK[under]!++;
  }
  if (dayMinutes().some((m, i) => m !== days[i]![2]))
    throw new Error('当日分钟与设计稿不符');

  const calls = {} as Record<CountryKey, number[]>;
  for (const key of KEYS) {
    const minutesOfKey = minutes[key];
    const floor: number[] = minutesOfKey.map((m) => (m > 0 ? 1 : 0));
    const more = apportion(
      byCountry[key][0] - floor.reduce((a, b) => a + b, 0),
      minutesOfKey.map((m, i) => m - floor[i]!),
    );
    calls[key] = floor.map((f, i) => f + more[i]!);
  }
  const dayCalls = () =>
    days.map((_, i) => KEYS.reduce((sum, key) => sum + calls[key][i]!, 0));
  for (let guard = 0; guard < 100_000; guard++) {
    const diff = dayCalls().map((n, i) => n - days[i]![3]);
    let over = 0;
    let under = 0;
    diff.forEach((d, i) => {
      if (d > diff[over]!) over = i;
      if (d < diff[under]!) under = i;
    });
    if (diff[over]! <= 0 || diff[under]! >= 0) break;
    const key = KEYS.find(
      (k) => calls[k][over]! > 1 && calls[k][under]! < minutes[k][under]!,
    );
    if (key === undefined) throw new Error('无法把当日通话数调到设计稿的值');
    calls[key][over]!--;
    calls[key][under]!++;
  }
  if (dayCalls().some((n, i) => n !== days[i]![3]))
    throw new Error('当日通话数与设计稿不符');
  for (let i = 0; i < count; i++) {
    for (const key of KEYS) {
      if (calls[key][i]! > minutes[key][i]!)
        throw new Error('通话数超过分钟数');
    }
  }
  return { minutes, calls };
}

// ---------------------------------------------------------------------------------------------
// 展开：逐通话单

/** 32 位整数混合；同样的输入给出同样的输出。 */
function mix(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    h = Math.imul(h ^ part, 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return h >>> 0;
}

/** UUID v5 风格：由标签确定地算出。 */
export function seededUuid(label: string): string {
  const bytes = createHash('sha1').update(label).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 把 minutes 个计费分钟分给 count 通话（每通至少 1 分钟），确定性地有长有短。 */
function spreadMinutes(count: number, minutes: number, seed: number): number[] {
  if (count === 0) return [];
  const weights = Array.from(
    { length: count },
    (_, k) => 1 + (mix(seed, k) % 6),
  );
  return apportion(minutes - count, weights).map((extra) => 1 + extra);
}

function clock(day: string, time: string): Date {
  return beijingTime(`${day} ${time}`);
}

const MONTHS = [
  {
    label: '2026-08',
    days: AUGUST_DAYS,
    countries: AUGUST_COUNTRIES,
  },
  {
    label: '2026-09',
    days: SEPTEMBER_DAYS,
    countries: SEPTEMBER_COUNTRIES,
  },
] as const;

/** 核对分配算法里写死的整数单价与真实费率表一致。 */
export function assertRateCard<C extends Currency>(
  entries: readonly RateEntry<C>[],
  keys: readonly CountryKey[] = KEYS,
): void {
  for (const spec of COUNTRIES.filter((c) => keys.includes(c.key))) {
    const entry = entries.find((e) => e.prefix === spec.prefix);
    if (
      !entry ||
      entry.country !== spec.country ||
      !entry.perMinute.perMinute.times(1000).eq(spec.milliPerMinute)
    )
      throw new Error(
        `种子费率表缺少 ${spec.country}（${spec.prefix}）或单价不符`,
      );
  }
}

function buildCall<C extends Currency>(
  entries: readonly RateEntry<C>[],
  day: string,
  key: CountryKey,
  callUuid: string,
  startedAt: Date,
  ringSeconds: number,
  talkSeconds: number,
  callee: string,
  hangupCause: string,
  caller: string,
): PlannedCall {
  const billing = normalizeDialedNumber(callee);
  if (!billing) throw new Error(`种子号码格式错误：${callee}`);
  const entry = longestPrefix(entries, billing);
  const spec = specOf(key);
  if (!entry || entry.prefix !== spec.prefix)
    throw new Error(
      `种子号码 ${callee} 没有匹配到 ${spec.country}（${spec.prefix}）`,
    );
  const answeredAt = new Date(startedAt.getTime() + ringSeconds * 1000);
  const priced = priceCall(talkSeconds, entry.perMinute);
  return {
    callUuid,
    day,
    startedAt,
    answeredAt,
    endedAt: new Date(answeredAt.getTime() + talkSeconds * 1000),
    caller,
    callee,
    billingNumber: billing,
    durationSeconds: talkSeconds,
    billedMinutes: priced.billedMinutes.toNumber(),
    key,
    matchedPrefix: entry.prefix,
    country: entry.country,
    iso: entry.iso,
    description: entry.description,
    perMinute: entry.perMinute.perMinute.toFixed(4),
    charge: priced.charge.value.toFixed(),
    hangupCause,
  };
}

/**
 * 8、9 月全部已接通话单：确定性顺序（8 月在前，按日、按当日顺序）。
 * 每通的计费分钟等于分配值，费用由 `priceCall` 按真实费率表算出。
 */
export function planAbc001Calls<C extends Currency>(
  input: CallPlanInput<C>,
): PlannedCall[] {
  assertRateCard(input.entries);
  const planned: PlannedCall[] = [];
  const fixedByCell = new Map<string, FixedCall[]>();
  for (const fixed of input.fixedCalls) {
    const cell = `${fixed.startedAt.slice(0, 10)}:${fixed.key}`;
    fixedByCell.set(cell, [...(fixedByCell.get(cell) ?? []), fixed]);
  }

  for (const month of MONTHS) {
    const cells = allocateMonth(month.days, month.countries);
    month.days.forEach((row, index) => {
      const day = `${month.label}-${String(row[0]).padStart(2, '0')}`;
      const slots: { key: CountryKey; billed: number }[] = [];
      for (const key of KEYS) {
        const fixed = fixedByCell.get(`${day}:${key}`) ?? [];
        const fixedMinutes = fixed.reduce(
          (sum, call) => sum + Math.ceil(call.talkSeconds / 60),
          0,
        );
        const n = cells.calls[key][index]! - fixed.length;
        const m = cells.minutes[key][index]! - fixedMinutes;
        if (n < 0 || m < n)
          throw new Error(`${day} ${key} 放不下并入的示例话单`);
        const spread = spreadMinutes(n, m, mix(row[0], KEYS.indexOf(key), 7));
        for (const billed of spread) slots.push({ key, billed });
      }
      // 当日顺序确定地打乱，再均匀铺在通话窗口里。
      const ordered = slots
        .map((slot, i) => ({ slot, i, h: mix(row[0], i, 5) }))
        .sort((a, b) => a.h - b.h || a.i - b.i)
        .map((entry) => entry.slot);
      const [from, to] = WINDOWS[day] ?? DEFAULT_WINDOW;
      const start = clock(day, from).getTime();
      const span = clock(day, to).getTime() - start;
      const width = Math.max(1, Math.floor(span / 1000 / ordered.length));
      ordered.forEach((slot, k) => {
        const second =
          Math.floor((k * span) / 1000 / ordered.length) +
          (mix(row[0], k, 11) % width);
        const startedAt = new Date(start + second * 1000);
        const ringSeconds = 2 + (mix(row[0], k, 13) % 11);
        const talkSeconds =
          (slot.billed - 1) * 60 + 1 + (mix(row[0], k, 17) % 60);
        const callee = specOf(slot.key).callee(mix(row[0], k, 19));
        planned.push(
          buildCall(
            input.entries,
            day,
            slot.key,
            seededUuid(`fs-billing:seed:${input.tenantCode}:cdr:${day}:${k}`),
            startedAt,
            ringSeconds,
            talkSeconds,
            callee,
            'NORMAL_CLEARING',
            input.caller,
          ),
        );
      });
      for (const key of KEYS) {
        for (const fixed of fixedByCell.get(`${day}:${key}`) ?? []) {
          planned.push(
            buildCall(
              input.entries,
              day,
              key,
              fixed.callUuid,
              beijingTime(fixed.startedAt),
              fixed.ringSeconds,
              fixed.talkSeconds,
              fixed.callee,
              fixed.hangupCause,
              fixed.caller,
            ),
          );
        }
      }
    });
  }
  return planned;
}

// ---------------------------------------------------------------------------------------------
// 当前月的少量通话（阶段 7 PR 1 追加）

/** 第一个可以带“本月通话”的月份之后的月份：2026-08、09 是设计稿的月账单，不能再加通话。 */
const LAST_MOCKUP_MONTH = '2026-09-01';

/**
 * 当前月通话的种子月份（YYYY-MM-01），没有则 null。
 * 通话都在该月 1 日凌晨（北京时间 00:05 至 02:00 之间开始），所以必须等到该月 03:00 之后才播种，
 * 保证播种时它们全都已经发生；晚于设计稿的 9 月才有（8、9 月的数字不能变）。
 */
export function currentMonthSeedMonth(now: Date): string | null {
  const month = `${beijingMonth(now)}-01`;
  if (month <= LAST_MOCKUP_MONTH) return null;
  if (now.getTime() < beijingTime(`${month} 03:00:00`).getTime()) return null;
  return month;
}

/** [开始时间（北京时间，当月 1 日）, 国家, 计费分钟]：固定 20 通，每个月都一样。 */
const CURRENT_MONTH_CALLS: readonly (readonly [string, CountryKey, number])[] =
  [
    ['00:05:12', 'CN', 3],
    ['00:11:40', 'CN', 5],
    ['00:18:03', 'JM', 2],
    ['00:24:55', 'CN', 4],
    ['00:31:20', 'UK', 6],
    ['00:38:47', 'CN', 2],
    ['00:44:09', 'JP', 3],
    ['00:52:31', 'CN', 7],
    ['00:58:16', 'HK', 4],
    ['01:03:42', 'CN', 3],
    ['01:09:58', 'SG', 5],
    ['01:15:21', 'CN', 6],
    ['01:21:07', 'UK', 4],
    ['01:27:33', 'CN', 2],
    ['01:33:50', 'US', 8],
    ['01:40:14', 'CN', 5],
    ['01:46:29', 'JP', 3],
    ['01:51:45', 'CN', 3],
    ['01:56:02', 'HK', 2],
    ['01:59:18', 'CN', 4],
  ];

/** 当前月预存的时刻：早于第一通话。 */
const CURRENT_MONTH_RECHARGE_TIME = '00:03:00';

export interface CurrentMonthPlan {
  readonly month: string;
  readonly calls: readonly PlannedCall[];
  /** 北京时间，早于第一通话。 */
  readonly rechargeAt: string;
  /** 恰为当月通话扣费合计，所以播种前后余额不变。 */
  readonly rechargeAmount: string;
}

/**
 * 某月 1 日凌晨的 20 通已接通话单加一笔等额预存。国家、计费分钟、通话秒数、费用逐月相同，
 * UUID 由租户与日期确定地算出，同一个月重复播种不增行；换一个月是另一组行，每组都自己抵平，
 * 余额因此永远不受播种次数影响。只用费率没有随版本变过的国家（不含 447），所以 8 月卡与 10 月卡结果一样。
 */
export function planCurrentMonthCalls<C extends Currency>(input: {
  readonly month: string;
  readonly tenantCode: string;
  readonly entries: readonly RateEntry<C>[];
  readonly caller: string;
}): CurrentMonthPlan {
  const used = [...new Set(CURRENT_MONTH_CALLS.map((c) => c[1]))];
  assertRateCard(input.entries, used);
  const day = input.month;
  const calls = CURRENT_MONTH_CALLS.map(([time, key, billed], k) => {
    const ringSeconds = 2 + (mix(k, 13) % 11);
    const talkSeconds = (billed - 1) * 60 + 1 + (mix(k, 17) % 60);
    return buildCall(
      input.entries,
      day,
      key,
      seededUuid(`fs-billing:seed:${input.tenantCode}:cdr:${day}:${k}`),
      beijingTime(`${day} ${time}`),
      ringSeconds,
      talkSeconds,
      specOf(key).callee(mix(k, 19)),
      'NORMAL_CLEARING',
      input.caller,
    );
  });
  const rechargeAmount = calls
    .reduce((sum, call) => sum.plus(call.charge), decimal('0'))
    .toFixed();
  return {
    month: day,
    calls,
    rechargeAt: `${day} ${CURRENT_MONTH_RECHARGE_TIME}`,
    rechargeAmount,
  };
}
