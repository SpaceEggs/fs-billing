import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decimal, priceCall, rate, type Currency } from '@fs-billing/rating';
import { connect } from '../src/client.js';

/**
 * 阶段 10 压测（验收 4、6）的只读核对。设计 §4 的四项检查：
 *
 *   1. 授权超时率为 0：窗口内 unverified 话单为 0、没有窗口内开始的 auth_timeout 告警、
 *      SIPp 统计没有失败呼叫；Worker 日志里的授权延迟分位数可选。
 *   2. 所有话单入库：SIPp 成功数 = 窗口内 cdrs 行数；raw_cdrs 每个 UUID 都有原文；
 *      unassigned_cdrs 为 0；call_uuid 无重复；retry/ 目录为空（给 --retry-dir 时）。
 *   3. 扣费总额 = 逐条计算合计：用 packages/rating 的 priceCall（decimal.js）按每条话单的
 *      费率快照与通话秒数重算，与 call_charge 流水之和、余额变化三者逐位相等。
 *   4. 未经验证话单（验收 6）：单独给出条数与金额，未接通不扣费，已接通照样按同一规则扣费。
 *
 * 全部只读；连接串从 DATABASE_URL 或仓库根 .env 读取，不打印。任何一项不相等退出非零。
 *
 * 单独运行：
 *   pnpm --filter @fs-billing/db exec tsx --env-file-if-exists=../../.env \
 *     scripts/verify-load.ts --tenant LOADTEST \
 *     --since 2026-11-04T02:00:00Z --until 2026-11-04T02:30:00Z \
 *     --sipp-log /tmp/load/full.log
 */

export type CurrencyCode = Currency;

export interface CdrChargeInput {
  readonly callUuid: string;
  readonly currency: CurrencyCode;
  readonly rate: string | null;
  readonly durationSeconds: number;
  readonly answered: boolean;
}

export type RecomputeResult =
  | {
      readonly ok: true;
      readonly billedMinutes: string;
      /** 正数，与 cdrs.charge 同一符号。 */
      readonly charge: string;
      /** 流水金额，负数；未接通或 0 元为 "0"。 */
      readonly ledgerAmount: string;
      readonly expectsLedger: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * 与 packages/db/src/cdr-intake.ts 的 priceCdr/chargeCall 完全同一套规则：
 * 未接通不收费；已接通按接通时刻的费率快照和 billsec 走 priceCall（60/60，不舍入）；
 * 金额为 0 时不写流水。费率快照缺失在真实扣费里会抛错，这里记成核对失败。
 */
export function recomputeCharge(cdr: CdrChargeInput): RecomputeResult {
  if (!cdr.answered) {
    return {
      ok: true,
      billedMinutes: '0',
      charge: '0',
      ledgerAmount: '0',
      expectsLedger: false,
    };
  }
  if (cdr.rate === null) {
    return { ok: false, reason: `话单 ${cdr.callUuid} 已接通但缺少费率快照` };
  }
  if (!Number.isInteger(cdr.durationSeconds) || cdr.durationSeconds < 0) {
    return {
      ok: false,
      reason: `话单 ${cdr.callUuid} 的 duration_seconds=${cdr.durationSeconds} 不是非负整数`,
    };
  }
  let perMinute;
  try {
    perMinute = rate(cdr.currency, cdr.rate);
  } catch (error) {
    return {
      ok: false,
      reason: `话单 ${cdr.callUuid} 的费率快照不合法：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const priced = priceCall(cdr.durationSeconds, perMinute);
  const charge = priced.charge.value;
  return {
    ok: true,
    billedMinutes: priced.billedMinutes.toFixed(),
    charge: charge.toFixed(),
    ledgerAmount: charge.isZero() ? '0' : charge.neg().toFixed(),
    expectsLedger: !charge.isZero(),
  };
}

/** 十进制逐位相等（不设容差；末尾 0 不同但数值相同视为相等）。 */
export function exactDecimalEqual(left: string, right: string): boolean {
  return decimal(left).eq(decimal(right));
}

/**
 * 三方核对：逐条重算合计（正数）、call_charge 流水合计（负数）、余额变化（负数）。
 * 返回人可读的差异；空数组表示三者完全相等。
 */
export function reconcileTotals(totals: {
  readonly recomputed: string;
  readonly ledger: string;
  readonly balanceDelta: string;
}): string[] {
  const failures: string[] = [];
  const recomputed = decimal(totals.recomputed);
  const ledgerPositive = decimal(totals.ledger).neg();
  const balancePositive = decimal(totals.balanceDelta).neg();
  if (!recomputed.eq(ledgerPositive)) {
    failures.push(
      `逐条重算合计 ${recomputed.toFixed()} ≠ 流水合计 ${ledgerPositive.toFixed()}`,
    );
  }
  if (!recomputed.eq(balancePositive)) {
    failures.push(
      `逐条重算合计 ${recomputed.toFixed()} ≠ 余额变化 ${balancePositive.toFixed()}`,
    );
  }
  if (!ledgerPositive.eq(balancePositive)) {
    failures.push(
      `流水合计 ${ledgerPositive.toFixed()} ≠ 余额变化 ${balancePositive.toFixed()}`,
    );
  }
  return failures;
}

export interface SippCounts {
  readonly successful: number;
  readonly failed: number;
  readonly failed5xx: number;
  readonly timeouts: number;
}

function parseCount(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

const lastIntegerOnMatchingLine = (
  lines: readonly string[],
  label: RegExp,
): number | undefined => {
  let found: number | undefined;
  for (const line of lines) {
    if (!label.test(line)) continue;
    const numbers = [...line.matchAll(/\d+/g)];
    const last = numbers[numbers.length - 1]?.[0];
    if (last !== undefined) found = Number(last);
  }
  return found;
};

/**
 * 解析 SIPp 的 `-trace_stat` CSV（取最后一行累计值）或终端统计表（取每个标签最后一行
 * 的最后一个数字，兼容 `[ 360 ]` 与 `| 0 | 360` 两种排版）。解析不出来时返回字符串，
 * 由调用方记失败，不猜数字。
 */
export function parseSippCounts(text: string): SippCounts | string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let header: string[] | undefined;
  let lastRow: string[] | undefined;
  for (const line of lines) {
    if (!line.includes(';')) continue;
    if (/successful/i.test(line) && /failed/i.test(line)) {
      header = line.split(';').map((cell) => cell.trim());
      lastRow = undefined;
      continue;
    }
    if (header) lastRow = line.split(';').map((cell) => cell.trim());
  }
  if (header && lastRow) {
    const find = (pattern: RegExp) =>
      header.findIndex((cell) => pattern.test(cell));
    const at = (index: number) =>
      index >= 0 ? parseCount(lastRow?.[index]) : 0;
    const successful = at(find(/^successful/i));
    return {
      successful,
      failed: at(find(/^failed/i)),
      failed5xx: at(find(/5xx/i)),
      timeouts: at(find(/timeout/i)),
    };
  }

  const successful = lastIntegerOnMatchingLine(
    lines,
    /^\s*Successful call\s*(?:\[|\|)/,
  );
  if (successful === undefined) {
    return '无法从 SIPp 日志解析 Successful call；请传 -trace_stat 文件或 --sipp-success';
  }
  return {
    successful,
    failed:
      lastIntegerOnMatchingLine(lines, /^\s*Failed call\s*(?:\[|\|)/) ?? 0,
    failed5xx: lastIntegerOnMatchingLine(lines, /5xx/i) ?? 0,
    timeouts: lastIntegerOnMatchingLine(lines, /timeout/i) ?? 0,
  };
}

/** 从 Worker 的 pino 行里取 /authorize 的响应时间（毫秒）。 */
export function authorizationLatencies(text: string): number[] {
  const values: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('/authorize')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const entry = parsed as {
      req?: { url?: unknown };
      res?: { responseTime?: unknown };
      responseTime?: unknown;
    };
    if (entry.req?.url !== '/authorize') continue;
    const value =
      typeof entry.responseTime === 'number'
        ? entry.responseTime
        : typeof entry.res?.responseTime === 'number'
          ? entry.res.responseTime
          : undefined;
    if (value !== undefined && Number.isFinite(value)) values.push(value);
  }
  return values;
}

export interface Percentiles {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

function nearestRank(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

export function percentiles(
  values: readonly number[],
): Percentiles | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
  };
}

interface Options {
  tenant: string;
  since: Date;
  until: Date;
  sippLogs: string[];
  sippSuccess?: number;
  sippFailed?: number;
  retryDir?: string;
  workerLog?: string;
  maxUnverified: number;
  expectAuthTimeout: boolean;
  skipSipp: boolean;
  databaseUrl: string;
}

function parseDate(name: string, value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new Error(`${name} 不是合法时间：${value}`);
  return parsed;
}

function parseOptions(argv: string[]): Options {
  if (!process.env.DATABASE_URL) {
    const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
    if (existsSync(envPath)) process.loadEnvFile(envPath);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('需要 DATABASE_URL（只读连接即可）');
  const envTenant = process.env.LOADTEST_TENANT;
  const options: Options = {
    tenant: envTenant ?? '',
    since: new Date(Number.NaN),
    until: new Date(Number.NaN),
    sippLogs: [],
    maxUnverified: 0,
    expectAuthTimeout: false,
    skipSipp: false,
    databaseUrl,
  };
  let sinceText = '';
  let untilText = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--tenant':
        if (!value) throw new Error('--tenant 需要参数');
        options.tenant = value;
        index += 1;
        break;
      case '--since':
        if (!value) throw new Error('--since 需要参数');
        sinceText = value;
        index += 1;
        break;
      case '--until':
        if (!value) throw new Error('--until 需要参数');
        untilText = value;
        index += 1;
        break;
      case '--sipp-log':
        if (!value) throw new Error('--sipp-log 需要参数');
        options.sippLogs.push(value);
        index += 1;
        break;
      case '--sipp-success':
        if (!value) throw new Error('--sipp-success 需要参数');
        options.sippSuccess = Number(value);
        index += 1;
        break;
      case '--sipp-failed':
        if (!value) throw new Error('--sipp-failed 需要参数');
        options.sippFailed = Number(value);
        index += 1;
        break;
      case '--retry-dir':
        if (!value) throw new Error('--retry-dir 需要参数');
        options.retryDir = value;
        index += 1;
        break;
      case '--worker-log':
        if (!value) throw new Error('--worker-log 需要参数');
        options.workerLog = value;
        index += 1;
        break;
      case '--max-unverified':
        if (!value) throw new Error('--max-unverified 需要参数');
        options.maxUnverified = Number(value);
        index += 1;
        break;
      case '--expect-auth-timeout':
        options.expectAuthTimeout = true;
        break;
      case '--skip-sipp':
        options.skipSipp = true;
        break;
      case '-h':
      case '--help':
        console.log(
          '用法：verify-load.ts --tenant CODE --since ISO --until ISO ' +
            '[--sipp-log FILE ...] [--sipp-success N] [--sipp-failed N] ' +
            '[--retry-dir DIR] [--worker-log FILE] [--max-unverified N] ' +
            '[--expect-auth-timeout] [--skip-sipp]',
        );
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  if (!options.tenant) throw new Error('需要 --tenant');
  if (!sinceText || !untilText) throw new Error('需要 --since 与 --until');
  options.since = parseDate('--since', sinceText);
  options.until = parseDate('--until', untilText);
  if (options.until <= options.since)
    throw new Error('--until 必须晚于 --since');
  if (!Number.isInteger(options.maxUnverified) || options.maxUnverified < 0) {
    throw new Error('--max-unverified 必须是非负整数');
  }
  for (const name of ['sippSuccess', 'sippFailed'] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(
        `--${name === 'sippSuccess' ? 'sipp-success' : 'sipp-failed'} 必须是非负数`,
      );
    }
  }
  return options;
}

interface TenantRow {
  id: string;
  code: string;
  currency: CurrencyCode;
  status: string;
  overdraft: string;
  balance: string;
}

interface CdrRow {
  call_uuid: string;
  billing_number: string;
  duration_seconds: number;
  billed_minutes: string;
  rate: string | null;
  charge: string;
  answered_at: Date | null;
  unverified: boolean;
  hangup_cause: string;
}

interface LedgerRow {
  idempotency_key: string;
  amount: string;
}

interface AlertRow {
  kind: string;
  started_at: Date;
  recovered_at: Date | null;
  affected_calls: number;
  notify: boolean;
  subject_key: string | null;
}

class Report {
  readonly lines: string[] = [];
  failures = 0;

  section(title: string) {
    this.lines.push('', `## ${title}`);
  }

  pass(label: string, detail: string) {
    this.lines.push(`PASS\t${label}\t${detail}`);
  }

  fail(label: string, detail: string) {
    this.failures += 1;
    this.lines.push(`FAIL\t${label}\t${detail}`);
  }

  skip(label: string, detail: string) {
    this.lines.push(`SKIP\t${label}\t${detail}`);
  }

  info(detail: string) {
    this.lines.push(`INFO\t${detail}`);
  }

  print() {
    console.log(this.lines.join('\n'));
  }
}

function countRetryFiles(directory: string): number {
  if (!existsSync(directory)) {
    throw new Error(`--retry-dir 不存在：${directory}`);
  }
  return readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.cdr.json'),
  ).length;
}

async function verify(options: Options): Promise<number> {
  const report = new Report();
  const connection = connect(options.databaseUrl, {
    max: 1,
    application_name: 'fsb-verify-load',
  });
  const { pool } = connection;
  try {
    const tenantResult = await pool.query<TenantRow>(
      `select t.id::text as id, t.code, t.currency, t.status,
              t.overdraft_limit::text as overdraft,
              coalesce(b.balance, '0')::text as balance
         from tenants t
         left join tenant_balances b on b.tenant_id = t.id
        where upper(t.code) = upper($1)`,
      [options.tenant],
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) throw new Error(`数据库里没有租户 ${options.tenant}`);
    if (tenantResult.rows.length > 1)
      throw new Error(`租户编码 ${options.tenant} 不唯一`);

    report.lines.push(
      `压测核对 tenant=${tenant.code} currency=${tenant.currency} window=${options.since.toISOString()}..${options.until.toISOString()}`,
    );
    report.info(
      `租户余额 ${tenant.balance}，透支额度 ${tenant.overdraft}，状态 ${tenant.status}`,
    );

    const cdrResult = await pool.query<CdrRow>(
      `select call_uuid::text as call_uuid, billing_number,
              duration_seconds, billed_minutes::text as billed_minutes,
              rate::text as rate, charge::text as charge, answered_at,
              unverified, hangup_cause
         from cdrs
        where tenant_id = $1
          and started_at >= $2::timestamptz
          and started_at < $3::timestamptz
        order by started_at`,
      [tenant.id, options.since.toISOString(), options.until.toISOString()],
    );
    const cdrs = cdrResult.rows;

    const ledgerResult = await pool.query<LedgerRow>(
      `select l.idempotency_key, l.amount::text as amount
         from ledger_entries l
         join cdrs c
           on c.tenant_id = l.tenant_id
          and l.idempotency_key = 'call:' || c.call_uuid::text
        where l.tenant_id = $1
          and l.kind = 'call_charge'
          and c.started_at >= $2::timestamptz
          and c.started_at < $3::timestamptz`,
      [tenant.id, options.since.toISOString(), options.until.toISOString()],
    );
    const ledgerByKey = new Map<string, string>();
    let duplicateLedgerKeys = 0;
    let ledgerTotal = decimal('0');
    for (const row of ledgerResult.rows) {
      if (ledgerByKey.has(row.idempotency_key)) duplicateLedgerKeys += 1;
      ledgerByKey.set(row.idempotency_key, row.amount);
      ledgerTotal = ledgerTotal.plus(decimal(row.amount));
    }

    // 1. 逐条重算与费率快照。
    report.section('逐条重算（packages/rating priceCall，60/60，decimal.js）');
    let recomputedTotal = decimal('0');
    const recomputeErrors: string[] = [];
    let snapshotChargeMismatches = 0;
    let snapshotMinutesMismatches = 0;
    for (const cdr of cdrs) {
      const recomputed = recomputeCharge({
        callUuid: cdr.call_uuid,
        currency: tenant.currency,
        rate: cdr.rate,
        durationSeconds: cdr.duration_seconds,
        answered: cdr.answered_at !== null,
      });
      if (!recomputed.ok) {
        recomputeErrors.push(recomputed.reason);
        continue;
      }
      recomputedTotal = recomputedTotal.plus(decimal(recomputed.charge));
      if (!exactDecimalEqual(cdr.charge, recomputed.charge))
        snapshotChargeMismatches += 1;
      if (!exactDecimalEqual(cdr.billed_minutes, recomputed.billedMinutes)) {
        snapshotMinutesMismatches += 1;
      }
    }
    if (recomputeErrors.length === 0) {
      report.pass('逐条重算', `${cdrs.length} 条话单全部可重算`);
    } else {
      report.fail(
        '逐条重算',
        `${recomputeErrors.length} 条失败；前 5 条：${recomputeErrors.slice(0, 5).join('；')}`,
      );
    }
    if (snapshotChargeMismatches === 0) {
      report.pass('话单金额快照', 'cdrs.charge 与重算值逐条相等');
    } else {
      report.fail(
        '话单金额快照',
        `${snapshotChargeMismatches} 条 cdrs.charge 与重算值不相等`,
      );
    }
    if (snapshotMinutesMismatches === 0) {
      report.pass('计费分钟快照', 'cdrs.billed_minutes 与重算值逐条相等');
    } else {
      report.fail('计费分钟快照', `${snapshotMinutesMismatches} 条不相等`);
    }

    // 2. 流水与余额三方核对。
    report.section('扣费总额');
    const totalLedgerResult = await pool.query<{ total: string }>(
      `select coalesce(sum(amount), 0)::text as total
         from ledger_entries where tenant_id = $1`,
      [tenant.id],
    );
    const totalLedger = totalLedgerResult.rows[0]?.total ?? '0';
    const sinceLedgerResult = await pool.query<{
      total: string;
      entries: number;
      other_kinds: number;
    }>(
      `select coalesce(sum(amount), 0)::text as total,
              count(*)::int as entries,
              count(*) filter (where kind <> 'call_charge')::int as other_kinds
         from ledger_entries
        where tenant_id = $1 and created_at >= $2::timestamptz`,
      [tenant.id, options.since.toISOString()],
    );
    const sinceLedger = sinceLedgerResult.rows[0] ?? {
      total: '0',
      entries: 0,
      other_kinds: 0,
    };

    // 余额变化 = 当前余额 − 窗口开始前的余额；窗口前余额由全量流水合计减去窗口内流水得出。
    // 余额与全量流水不等时，这里会同时在「账本不变量」失败。
    const balanceBefore = decimal(totalLedger).minus(
      decimal(sinceLedger.total),
    );
    const balanceDelta = decimal(tenant.balance).minus(balanceBefore);
    const mismatches = reconcileTotals({
      recomputed: recomputedTotal.toFixed(),
      ledger: ledgerTotal.toFixed(),
      balanceDelta: balanceDelta.toFixed(),
    });
    if (mismatches.length === 0) {
      report.pass(
        '三方相等',
        `重算=${recomputedTotal.toFixed()}，流水=${ledgerTotal.toFixed()}，余额变化=${balanceDelta.toFixed()}`,
      );
    } else {
      report.fail('三方相等', mismatches.join('；'));
    }
    if (sinceLedger.other_kinds === 0) {
      report.pass('窗口内无非通话流水', `窗口内流水 ${sinceLedger.entries} 笔`);
    } else {
      report.fail(
        '窗口内无非通话流水',
        `窗口内还有 ${sinceLedger.other_kinds} 笔充值/赠送/调整；三方比较不成立`,
      );
    }
    if (exactDecimalEqual(totalLedger, tenant.balance)) {
      report.pass(
        '账本不变量',
        `余额 ${tenant.balance} = 全部流水合计 ${totalLedger}`,
      );
    } else {
      report.fail(
        '账本不变量',
        `余额 ${tenant.balance} ≠ 全部流水合计 ${totalLedger}`,
      );
    }
    if (duplicateLedgerKeys === 0) {
      report.pass('扣费流水唯一', `${ledgerByKey.size} 笔 call_charge`);
    } else {
      report.fail('扣费流水唯一', `${duplicateLedgerKeys} 个重复幂等键`);
    }

    // 未接通的话单不得有流水；应扣费的话单必须有流水。
    let unansweredWithLedger = 0;
    let missingLedger = 0;
    for (const cdr of cdrs) {
      const key = `call:${cdr.call_uuid}`;
      const recomputed = recomputeCharge({
        callUuid: cdr.call_uuid,
        currency: tenant.currency,
        rate: cdr.rate,
        durationSeconds: cdr.duration_seconds,
        answered: cdr.answered_at !== null,
      });
      if (!recomputed.ok) continue;
      if (!recomputed.expectsLedger && ledgerByKey.has(key))
        unansweredWithLedger += 1;
      if (recomputed.expectsLedger && !ledgerByKey.has(key)) missingLedger += 1;
    }
    if (unansweredWithLedger === 0) {
      report.pass('未接通不扣费', '未接通与 0 元话单没有 call_charge 流水');
    } else {
      report.fail(
        '未接通不扣费',
        `${unansweredWithLedger} 条未接通/0 元话单有流水`,
      );
    }
    if (missingLedger === 0) {
      report.pass(
        '应扣费都已扣费',
        '所有金额大于 0 的话单都有 call_charge 流水',
      );
    } else {
      report.fail('应扣费都已扣费', `${missingLedger} 条话单缺少流水`);
    }

    // 3. 所有话单入库。
    report.section('所有话单入库');
    const unverified = cdrs.filter((cdr) => cdr.unverified);
    report.info(
      `窗口内话单 ${cdrs.length} 条，其中未验证 ${unverified.length} 条`,
    );

    if (unverified.length <= options.maxUnverified) {
      report.pass(
        '授权超时',
        `未验证话单 ${unverified.length} 条（允许 ${options.maxUnverified} 条）`,
      );
    } else {
      report.fail(
        '授权超时',
        `未验证话单 ${unverified.length} 条，超过允许的 ${options.maxUnverified} 条`,
      );
    }

    const alertResult = await pool.query<AlertRow>(
      `select kind, started_at, recovered_at, affected_calls, notify, subject_key
         from system_alerts
        where kind = 'auth_timeout'
          and (tenant_id is null or tenant_id = $1)
          and started_at < $3::timestamptz
          and coalesce(recovered_at, 'infinity'::timestamptz) > $2::timestamptz
        order by started_at`,
      [tenant.id, options.since.toISOString(), options.until.toISOString()],
    );
    const alertSummary = alertResult.rows
      .map(
        (row) =>
          `${row.started_at.toISOString()}→${row.recovered_at?.toISOString() ?? '未恢复'} affected=${row.affected_calls} notify=${row.notify}`,
      )
      .join('；');
    if (options.expectAuthTimeout) {
      if (alertResult.rows.length > 0) {
        report.pass(
          'auth_timeout 告警',
          `${alertResult.rows.length} 条：${alertSummary}`,
        );
      } else {
        report.fail(
          'auth_timeout 告警',
          '演练期望窗口内出现 auth_timeout，实际没有',
        );
      }
    } else if (alertResult.rows.length === 0) {
      report.pass('auth_timeout 告警', '窗口内没有 auth_timeout');
    } else {
      report.fail(
        'auth_timeout 告警',
        `窗口内有 ${alertResult.rows.length} 条：${alertSummary}`,
      );
    }

    const duplicateCdrUuids = await pool.query<{ duplicates: number }>(
      `select count(*)::int as duplicates from (
         select call_uuid
           from cdrs
          where tenant_id = $1 and started_at >= $2::timestamptz and started_at < $3::timestamptz
          group by call_uuid having count(*) > 1
       ) duplicated`,
      [tenant.id, options.since.toISOString(), options.until.toISOString()],
    );
    if ((duplicateCdrUuids.rows[0]?.duplicates ?? 0) === 0) {
      report.pass(
        'call_uuid 无重复',
        `${new Set(cdrs.map((row) => row.call_uuid)).size} 个 UUID`,
      );
    } else {
      report.fail(
        'call_uuid 无重复',
        `${duplicateCdrUuids.rows[0]?.duplicates} 个 UUID 出现多条话单`,
      );
    }

    const rawResult = await pool.query<{
      total: number;
      distinct_uuids: number;
    }>(
      `select count(*)::int as total,
              count(distinct r.payload->'variables'->>'uuid')::int as distinct_uuids
         from raw_cdrs r
         join cdrs c
           on c.tenant_id = $1
          and c.started_at >= $2::timestamptz
          and c.started_at < $3::timestamptz
          and r.payload->'variables'->>'uuid' = c.call_uuid::text
        where r.received_at >= $2::timestamptz`,
      [tenant.id, options.since.toISOString(), options.until.toISOString()],
    );
    const raw = rawResult.rows[0] ?? { total: 0, distinct_uuids: 0 };
    const distinctCdrs = new Set(cdrs.map((row) => row.call_uuid)).size;
    if (raw.distinct_uuids === distinctCdrs) {
      report.pass(
        'raw_cdrs 覆盖',
        `${raw.distinct_uuids} 个 UUID 有原文（原文 ${raw.total} 行，重推可能多于话单）`,
      );
    } else {
      report.fail(
        'raw_cdrs 覆盖',
        `只有 ${raw.distinct_uuids}/${distinctCdrs} 个 UUID 有原文`,
      );
    }

    const unassignedResult = await pool.query<{ total: number }>(
      `select count(*)::int as total
         from unassigned_cdrs
        where upper(tenant_tag) = upper($1)
          and received_at >= $2::timestamptz`,
      [tenant.code, options.since.toISOString()],
    );
    const unassigned = unassignedResult.rows[0]?.total ?? 0;
    if (unassigned === 0) {
      report.pass('无未归属话单', '窗口内该租户没有 unassigned_cdrs');
    } else {
      report.fail('无未归属话单', `窗口内 ${unassigned} 条 unassigned_cdrs`);
    }

    const callUuidResult = await pool.query<{ total: number }>(
      `select count(*)::int as total
         from call_uuids
        where tenant_id = $1 and started_at >= $2::timestamptz and started_at < $3::timestamptz`,
      [tenant.id, options.since.toISOString(), options.until.toISOString()],
    );
    const callUuidRows = callUuidResult.rows[0]?.total ?? 0;
    if (callUuidRows === distinctCdrs) {
      report.pass('call_uuids', `${callUuidRows} 个登记，与话单一一对应`);
    } else {
      report.fail(
        'call_uuids',
        `登记 ${callUuidRows} 个，话单 ${distinctCdrs} 个`,
      );
    }

    if (options.retryDir) {
      const retryFiles = countRetryFiles(options.retryDir);
      if (retryFiles === 0) {
        report.pass('retry 目录为空', options.retryDir);
      } else {
        report.fail('retry 目录为空', `${retryFiles} 个 .cdr.json 尚未补推`);
      }
    } else {
      report.skip(
        'retry 目录为空',
        '未提供 --retry-dir（在服务器 A 上可传该目录复查）',
      );
    }

    // 4. SIPp 成功数与失败数。
    report.section('SIPp 统计');
    let successful = options.sippSuccess;
    let failed = options.sippFailed ?? 0;
    let failed5xx = 0;
    let timeouts = 0;
    const parseErrors: string[] = [];
    if (options.sippLogs.length > 0) {
      let parsedSuccessful = 0;
      let parsedFailed = 0;
      for (const log of options.sippLogs) {
        if (!existsSync(log)) {
          parseErrors.push(`${log} 不存在`);
          continue;
        }
        const parsed = parseSippCounts(readFileSync(log, 'utf8'));
        if (typeof parsed === 'string') {
          parseErrors.push(`${log}：${parsed}`);
          continue;
        }
        parsedSuccessful += parsed.successful;
        parsedFailed += parsed.failed;
        failed5xx += parsed.failed5xx;
        timeouts += parsed.timeouts;
      }
      if (parseErrors.length === 0) {
        successful = parsedSuccessful;
        failed = parsedFailed;
      } else {
        for (const error of parseErrors) report.fail('SIPp 统计解析', error);
      }
    }
    if (successful === undefined) {
      if (options.skipSipp) {
        report.skip('SIPp 成功数', '按 --skip-sipp 跳过');
      } else {
        report.fail(
          'SIPp 成功数',
          '未提供可解析的 --sipp-log，也没有 --sipp-success',
        );
      }
    } else if (successful === cdrs.length) {
      report.pass('SIPp 成功数 = 话单数', `${successful} = ${cdrs.length}`);
    } else {
      report.fail('SIPp 成功数 = 话单数', `${successful} ≠ ${cdrs.length}`);
    }
    if (failed === 0 && failed5xx === 0 && timeouts === 0) {
      report.pass(
        'SIPp 失败呼叫为 0',
        `failed=${failed}，5xx=${failed5xx}，timeout=${timeouts}`,
      );
    } else {
      report.fail(
        'SIPp 失败呼叫为 0',
        `failed=${failed}，5xx=${failed5xx}，timeout=${timeouts}`,
      );
    }

    // 5. 未经验证话单（验收 6 的专门小节）。
    report.section('未经验证话单');
    if (unverified.length === 0) {
      report.pass('未验证话单', '窗口内没有 unverified 话单');
    } else {
      let unverifiedRecomputed = decimal('0');
      let unverifiedLedger = decimal('0');
      let unverifiedAnswered = 0;
      let unverifiedUnanswered = 0;
      let unverifiedMissingLedger = 0;
      for (const cdr of unverified) {
        const recomputed = recomputeCharge({
          callUuid: cdr.call_uuid,
          currency: tenant.currency,
          rate: cdr.rate,
          durationSeconds: cdr.duration_seconds,
          answered: cdr.answered_at !== null,
        });
        if (!recomputed.ok) {
          report.fail('未验证话单重算', recomputed.reason);
          continue;
        }
        if (cdr.answered_at !== null) unverifiedAnswered += 1;
        else unverifiedUnanswered += 1;
        unverifiedRecomputed = unverifiedRecomputed.plus(
          decimal(recomputed.charge),
        );
        const ledgerAmount = ledgerByKey.get(`call:${cdr.call_uuid}`);
        if (ledgerAmount !== undefined) {
          unverifiedLedger = unverifiedLedger.plus(decimal(ledgerAmount));
        } else if (recomputed.expectsLedger) {
          unverifiedMissingLedger += 1;
        }
      }
      report.info(
        `未验证 ${unverified.length} 条：接通 ${unverifiedAnswered}，未接通 ${unverifiedUnanswered}，` +
          `重算扣费 ${unverifiedRecomputed.toFixed()}，流水 ${unverifiedLedger.toFixed()}`,
      );
      if (unverifiedMissingLedger === 0) {
        report.pass('未验证话单照常扣费', '应扣费的未验证话单都有流水');
      } else {
        report.fail(
          '未验证话单照常扣费',
          `${unverifiedMissingLedger} 条缺流水`,
        );
      }
      if (
        exactDecimalEqual(
          unverifiedRecomputed.toFixed(),
          unverifiedLedger.neg().toFixed(),
        )
      ) {
        report.pass('未验证话单金额一致', '重算合计 = 流水平合计');
      } else {
        report.fail(
          '未验证话单金额一致',
          `重算 ${unverifiedRecomputed.toFixed()} ≠ 流水 ${unverifiedLedger.neg().toFixed()}`,
        );
      }
    }

    // 6. 授权延迟（可选，取自 Worker 日志）。
    report.section('授权延迟');
    if (options.workerLog) {
      if (!existsSync(options.workerLog)) {
        report.fail('Worker 日志', `${options.workerLog} 不存在`);
      } else {
        const stats = percentiles(
          authorizationLatencies(readFileSync(options.workerLog, 'utf8')),
        );
        if (stats) {
          report.info(
            `样本 ${stats.count}：p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms p99=${stats.p99.toFixed(1)}ms`,
          );
        } else {
          report.info('日志里没有 /authorize 的 responseTime 记录');
        }
      }
    } else {
      report.skip('授权延迟', '未提供 --worker-log');
    }

    report.info('资源峰值见 sample-resources.sh 的 CSV；本脚本不设通过线。');
    report.lines.push(
      '',
      `结果：${report.failures === 0 ? 'PASS' : 'FAIL'}（失败项 ${report.failures}）`,
    );
    report.print();
    return report.failures === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const code = await verify(options);
  process.exitCode = code;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) await main();
