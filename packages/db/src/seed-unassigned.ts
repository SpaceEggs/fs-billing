import { beijingTime, normalizeDialedNumber } from '@fs-billing/rating';
import { seededUuid } from './seed-calls.js';

/**
 * ABC01 的 326 条未归属话单（阶段 8 验收 1，设计稿「未归属话单原型」的形状）：
 * - 1 条原有的示例话单（9-28，新加坡 2 分钟，0.056），由 seed.ts 保留；
 * - 323 条 9-29 当天的话单，接通时间从 13:47:02 起逐条往前，被叫轮换九个号码，时长确定性地有长有短；
 *   最后两条的时长是为合计凑整而定的；
 * - 2 条被叫 1876 的话单接通在 2026-08-05，早于 ABC001 第一个费率版本的生效时间（2026-08-12 09:30），
 *   按接通时刻没有费率（阶段 8 决定 37）：不靠删前缀，因为最长前缀会落到前缀 1。
 * 按 ABC001 的首个费率表（RATES_CSV）定价，324 条可分配话单合计恰为 58.35，2 条无费率。
 * 设计稿同一循环里还有 12 条空标签待处理话单和 5 条已忽略话单（决定 47），由下面两个函数生成，
 * 不混进 ABC01，所以 326 条和 ¥58.35 不变。空标签的时长和时刻走设计稿原公式（`i % 28 === 3`，
 * 时长 `% 600`），不用 ABC01 为凑 58.35 改过的时长。
 * 全部是确定性计算，没有随机数，重复播种不增行。
 */

export interface PlannedUnassigned {
  readonly callUuid: string;
  readonly tenantTag: string;
  readonly reason: string;
  readonly caller: string;
  readonly callee: string;
  readonly billingNumber: string;
  readonly startedAt: Date;
  readonly answeredAt: Date;
  readonly endedAt: Date;
  readonly durationSeconds: number;
  readonly hangupCause: string;
}

/** 已忽略的种子行。`admin` 是 seed.ts 里的管理员键，写入时换成 admins.id。 */
export interface PlannedIgnoredUnassigned extends PlannedUnassigned {
  readonly ignoreReason: string;
  readonly admin: 'wang' | 'li';
  readonly resolvedAt: Date;
}

const TAG = 'ABC01';
const REASON = '租户不存在';
const CALLERS = ['075586001234', '075586001235', '075586001236'] as const;
const CALLEES = [
  '8613800138000',
  '447700900123',
  '85291234567',
  '14155550123',
  '6591234567',
  '442071234567',
  '8613912345678',
  '81345678901',
  '8613600136000',
] as const;

/** 9-29 当天的话单条数（不含原有的示例话单与 2 条无费率话单）。 */
export const SEPTEMBER_ROWS = 323;
/** 前 321 条按公式取时长，最后两条是凑整用的尾部。 */
const FORMULA_ROWS = 321;
/** 尾部两条：447 的 4 个计费分钟（0.1800）与 86 的 7 个计费分钟（0.3500）。 */
const TAIL: readonly { callee: string; seconds: number }[] = [
  { callee: '447700900123', seconds: 215 },
  { callee: '8613800138000', seconds: 395 },
];

/** 两条接通早于 ABC001 第一个费率版本的话单。 */
const EARLY: readonly {
  callee: string;
  answeredAt: string;
  seconds: number;
}[] = [
  {
    callee: '18765551234',
    answeredAt: '2026-08-05 11:20:04',
    seconds: 63,
  },
  {
    callee: '18765559876',
    answeredAt: '2026-08-05 15:42:31',
    seconds: 87,
  },
];

function plan(
  label: string,
  caller: string,
  callee: string,
  answeredAt: Date,
  seconds: number,
  tenantTag = TAG,
  reason = REASON,
): PlannedUnassigned {
  const dialed = `+${callee}`;
  const billingNumber = normalizeDialedNumber(dialed);
  if (!billingNumber) throw new Error(`种子未归属话单号码无效：${dialed}`);
  const ring = 3 + (seconds % 5);
  // 空标签没有可放进 UUID 的文字。用 empty 占位，避免出现双冒号。
  const scope = tenantTag === '' ? 'empty' : tenantTag;
  return {
    callUuid: seededUuid(`fs-billing:seed:unassigned:${scope}:${label}`),
    tenantTag,
    reason,
    caller,
    callee: dialed,
    billingNumber,
    startedAt: new Date(answeredAt.getTime() - ring * 1000),
    answeredAt,
    endedAt: new Date(answeredAt.getTime() + seconds * 1000),
    durationSeconds: seconds,
    hangupCause: 'NORMAL_CLEARING',
  };
}

/** 325 条：323 条 9-29 的话单加 2 条早于费率生效的话单（不含原有的示例话单）。 */
export function planAbc01Unassigned(): PlannedUnassigned[] {
  const rows: PlannedUnassigned[] = [];
  let secondOfDay = 13 * 3600 + 47 * 60 + 2;
  for (let i = 0; i < SEPTEMBER_ROWS; i++) {
    const tail = i >= FORMULA_ROWS ? TAIL[i - FORMULA_ROWS]! : undefined;
    const seconds = tail?.seconds ?? 20 + ((i * 97) % 515);
    const callee = tail?.callee ?? CALLEES[(i * 7) % CALLEES.length]!;
    const hh = String(Math.floor(secondOfDay / 3600)).padStart(2, '0');
    const mm = String(Math.floor((secondOfDay % 3600) / 60)).padStart(2, '0');
    const ss = String(secondOfDay % 60).padStart(2, '0');
    rows.push(
      plan(
        `september:${i}`,
        CALLERS[i % CALLERS.length]!,
        callee,
        beijingTime(`2026-09-29 ${hh}:${mm}:${ss}`),
        seconds,
      ),
    );
    secondOfDay -= 30 + ((i * 13) % 17);
  }
  for (const [index, early] of EARLY.entries()) {
    rows.push(
      plan(
        `early:${index}`,
        CALLERS[index % CALLERS.length]!,
        early.callee,
        beijingTime(early.answeredAt),
        early.seconds,
      ),
    );
  }
  return rows;
}

const MISSING_TAG = '缺少租户标签';
const EMPTY_CALLER = '02088776655';

function dayClock(secondOfDay: number): string {
  const hh = String(Math.floor(secondOfDay / 3600)).padStart(2, '0');
  const mm = String(Math.floor((secondOfDay % 3600) / 60)).padStart(2, '0');
  const ss = String(secondOfDay % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * 设计稿 `data()` 里 `i % 28 === 3` 的 12 条。时刻沿 338 次循环往回走，和 ABC01 的 323 次不是同一条时间线。
 */
export function planEmptyTagUnassigned(): PlannedUnassigned[] {
  const rows: PlannedUnassigned[] = [];
  let secondOfDay = 13 * 3600 + 47 * 60 + 2;
  for (let i = 0; i < 338; i++) {
    if (i % 28 === 3) {
      const callee = `86137${String(10000000 + i * 7919).slice(0, 8)}`;
      const seconds = 20 + ((i * 97) % 600);
      rows.push(
        plan(
          String(i),
          EMPTY_CALLER,
          callee,
          beijingTime(`2026-09-29 ${dayClock(secondOfDay)}`),
          seconds,
          '',
          MISSING_TAG,
        ),
      );
    }
    secondOfDay -= 30 + ((i * 13) % 17);
  }
  return rows;
}

/**
 * 设计稿 `seeded` / `seedIgn` 的 5 条。
 * 设计稿没有停放原因：TEST 记「租户不存在」，空标签记「缺少租户标签」，与 worker 入库停放的两句相同。
 */
const IGNORED: readonly {
  id: string;
  tenantTag: string;
  caller: string;
  callee: string;
  seconds: number;
  answeredAt: string;
  reason: string;
  ignoreReason: string;
  admin: PlannedIgnoredUnassigned['admin'];
  resolvedAt: string;
}[] = [
  {
    id: 's1',
    tenantTag: 'TEST',
    caller: '075500000001',
    callee: '8613800000001',
    seconds: 12,
    answeredAt: '2026-09-28 17:42:10',
    reason: REASON,
    ignoreReason: 'FreeSWITCH 测试呼叫，不属于任何客户',
    admin: 'wang',
    resolvedAt: '2026-09-28 18:05:00',
  },
  {
    id: 's2',
    tenantTag: 'TEST',
    caller: '075500000001',
    callee: '8613800000001',
    seconds: 9,
    answeredAt: '2026-09-28 17:40:51',
    reason: REASON,
    ignoreReason: 'FreeSWITCH 测试呼叫，不属于任何客户',
    admin: 'wang',
    resolvedAt: '2026-09-28 18:05:00',
  },
  {
    id: 's3',
    tenantTag: 'TEST',
    caller: '075500000001',
    callee: '8613800000002',
    seconds: 31,
    answeredAt: '2026-09-28 17:39:33',
    reason: REASON,
    ignoreReason: 'FreeSWITCH 测试呼叫，不属于任何客户',
    admin: 'wang',
    resolvedAt: '2026-09-28 18:05:00',
  },
  {
    id: 's4',
    tenantTag: '',
    caller: '02088776600',
    callee: '8613500135000',
    seconds: 64,
    answeredAt: '2026-09-26 10:15:08',
    reason: MISSING_TAG,
    ignoreReason: '内部线路，运维排障拨测',
    admin: 'li',
    resolvedAt: '2026-09-26 11:30:00',
  },
  {
    id: 's5',
    tenantTag: '',
    caller: '02088776600',
    callee: '8613500135000',
    seconds: 58,
    answeredAt: '2026-09-26 10:12:47',
    reason: MISSING_TAG,
    ignoreReason: '内部线路，运维排障拨测',
    admin: 'li',
    resolvedAt: '2026-09-26 11:30:00',
  },
];

export function planIgnoredUnassigned(): PlannedIgnoredUnassigned[] {
  return IGNORED.map((row) => ({
    ...plan(
      row.id,
      row.caller,
      row.callee,
      beijingTime(row.answeredAt),
      row.seconds,
      row.tenantTag,
      row.reason,
    ),
    ignoreReason: row.ignoreReason,
    admin: row.admin,
    resolvedAt: beijingTime(row.resolvedAt),
  }));
}
