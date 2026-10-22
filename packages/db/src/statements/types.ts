import type { StatementReconcileStatus } from '../schema.js';

/** 账单的 6 个数 + 通话数 + 计费分钟。金额与分钟是精确十进制字符串，不舍入。 */
export interface StatementFigures {
  readonly openingBalance: string;
  readonly recharge: string;
  readonly gift: string;
  readonly adjustment: string;
  /** 正数；公式里减去。 */
  readonly callCharges: string;
  readonly closingBalance: string;
  /** 已接通话单条数，含 0 元通话。 */
  readonly calls: number;
  readonly callMinutes: string;
}

export interface StatementCountryRow {
  readonly country: string;
  readonly calls: number;
  readonly minutes: string;
  readonly charge: string;
}

export interface StatementDayRow {
  /** 北京日，YYYY-MM-DD。 */
  readonly day: string;
  readonly calls: number;
  readonly minutes: string;
  readonly charge: string;
}

/** 一次取数的结果：头部来自流水，明细来自话单，二者读自同一个快照。 */
export interface StatementComputation extends StatementFigures {
  /** 通话扣费 − 国家费用合计。 */
  readonly breakdownGap: string;
  /** 只含有通话的国家，按费用降序、国家名升序。 */
  readonly countries: readonly StatementCountryRow[];
  /** 只含有通话的北京日，升序。没有通话的日子由读取方补零。 */
  readonly days: readonly StatementDayRow[];
}

export interface StatementHeader extends StatementFigures {
  readonly id: string;
  readonly tenantId: string;
  /** 该月 1 日，YYYY-MM-01。 */
  readonly month: string;
  readonly version: number;
  readonly breakdownGap: string;
  readonly detailsDeleted: boolean;
  readonly generatedAt: Date;
  readonly firstGeneratedAt: Date;
  /** 空表示定时任务。 */
  readonly generatedBy: string | null;
  readonly reconcileStatus: StatementReconcileStatus;
  readonly reconciledAt: Date | null;
  readonly reconcileDiff: string | null;
}

export interface StoredStatement extends StatementHeader {
  readonly countries: readonly StatementCountryRow[];
  readonly days: readonly StatementDayRow[];
}

/** 列表与详情用同一个枚举：final 有账单行；in_progress 是当前北京月；pending 已结束但还没有账单行。 */
export type StatementState = 'final' | 'in_progress' | 'pending';

export interface LiveStatement {
  readonly month: string;
  readonly state: 'in_progress' | 'pending';
  readonly asOf: Date;
  readonly statement: StatementComputation;
}

export const STATEMENT_FIGURE_KEYS = [
  'openingBalance',
  'recharge',
  'gift',
  'adjustment',
  'callCharges',
  'closingBalance',
  'calls',
  'callMinutes',
] as const satisfies readonly (keyof StatementFigures)[];
