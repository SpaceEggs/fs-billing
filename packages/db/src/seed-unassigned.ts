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
): PlannedUnassigned {
  const dialed = `+${callee}`;
  const billingNumber = normalizeDialedNumber(dialed);
  if (!billingNumber) throw new Error(`种子未归属话单号码无效：${dialed}`);
  const ring = 3 + (seconds % 5);
  return {
    callUuid: seededUuid(`fs-billing:seed:unassigned:${TAG}:${label}`),
    tenantTag: TAG,
    reason: REASON,
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
