import { sql } from 'drizzle-orm';
import type { PoolDb } from '../client.js';
import { withSystem } from '../client.js';
import { exportMonthToPartial } from './export.js';
import {
  beginExport,
  loadManifest,
  markDetached,
  markDropped,
  markFailed,
  markVerified,
  requestReexport,
  requireArchivedFile,
  stageOf,
  type ArchiveManifest,
} from './manifest.js';
import { partialKey, type ArchiveStore } from './store.js';
import {
  ARCHIVE_RESTORE_HOLD_DAYS,
  ArchiveBusyError,
  ArchiveError,
  archiveFileKey,
  type ArchiveStage,
  type ArchiveStep,
} from './types.js';
import { assertArchiveFile, verifyPartial } from './verify.js';

/** 测试用的故障注入点：抛错即模拟这一刻崩溃（或失败）。 */
export type ArchiveCheckpoint =
  | 'exported'
  | 'verified'
  | 'published'
  | 'marked'
  | 'detach-in-transaction'
  | 'drop-in-transaction';

export interface ArchiveOptions {
  /** 月末之后再过这么多个月才归档（RAW_CDR_ARCHIVE_AFTER_MONTHS，默认 6）。 */
  afterMonths: number;
  /** 分离之后这么多天才丢弃（RAW_CDR_ARCHIVE_GRACE_DAYS，默认 7）。 */
  graceDays: number;
  /** 整月恢复之后这么多天内不再归档该月，默认 30。 */
  restoreHoldDays?: number;
  /** 测试用的“现在”；默认数据库时钟。 */
  asOf?: Date;
  staleAfterMs?: number;
  onCheckpoint?: (point: ArchiveCheckpoint) => void | Promise<void>;
}

export interface ArchivePlan {
  /** 已分离、宽限期已过、可以丢弃的月份（升序）。 */
  dropDue: string[];
  /** 本次要走导出、校验、分离的月份：最老的未完成月；没有则 null。 */
  next: string | null;
  /** 清单与分区状态矛盾（例如清单说已分离，分区却仍挂在父表下）：只报告，不自动处理。 */
  inconsistent: { month: string; reason: string }[];
}

interface PlanRow extends Record<string, unknown> {
  month: string;
  detached_at: string | null;
  dropped_at: string | null;
  held: boolean | null;
}

/**
 * 「超过 6 个月」按分区整月算：月份 M 在 M 月末 + afterMonths 个月（北京时间）之后才可归档，
 * 即 M + afterMonths + 1 个月的 1 日 00:00 起。
 */
export async function planRawArchive(
  db: PoolDb,
  options: ArchiveOptions,
): Promise<ArchivePlan> {
  const asOf = options.asOf ?? null;
  const hold = options.restoreHoldDays ?? ARCHIVE_RESTORE_HOLD_DAYS;
  return withSystem(db, async (tx) => {
    const { rows: attached } = await tx.execute<PlanRow>(sql`
      WITH clock AS (SELECT coalesce(${asOf}::timestamptz, now()) AS t),
      parts AS (
        SELECT to_date(substring(c.relname FROM '^raw_cdrs_(\\d{4}_\\d{2})$'), 'YYYY_MM') AS month
        FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'public.raw_cdrs'::regclass AND c.relname ~ '^raw_cdrs_\\d{4}_\\d{2}$'
      )
      SELECT to_char(p.month, 'YYYY-MM-DD') AS month,
        m.detached_at::text AS detached_at, m.dropped_at::text AS dropped_at,
        (m.restored_at IS NOT NULL AND m.restored_at + make_interval(days => ${hold}) > clock.t) AS held
      FROM parts p CROSS JOIN clock LEFT JOIN raw_cdr_archives m ON m.month = p.month
      WHERE ((p.month + make_interval(months => ${options.afterMonths + 1}))::timestamp
             AT TIME ZONE 'Asia/Shanghai') <= clock.t
      ORDER BY p.month`);
    const { rows: due } = await tx.execute<{ month: string }>(sql`
      SELECT to_char(month, 'YYYY-MM-DD') AS month FROM raw_cdr_archives
      WHERE detached_at IS NOT NULL AND dropped_at IS NULL
        AND detached_at + make_interval(days => ${options.graceDays}) <= coalesce(${asOf}::timestamptz, now())
      ORDER BY month`);
    const plan: ArchivePlan = {
      dropDue: due.map((row) => row.month),
      next: null,
      inconsistent: [],
    };
    for (const row of attached) {
      if (row.dropped_at !== null || row.detached_at !== null) {
        plan.inconsistent.push({
          month: row.month,
          reason: `清单记着${row.dropped_at !== null ? '已丢弃' : '已分离'}，分区却仍挂在 raw_cdrs 下`,
        });
        continue;
      }
      if (row.held) continue;
      plan.next ??= row.month;
    }
    return plan;
  });
}

function sqlStateOf(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause)
    if ('code' in current && typeof current.code === 'string')
      return current.code;
  return undefined;
}

/** 错误信息写进 last_error 与告警：不能带原文（解析器的错误片段、数据库的行内容）。 */
export function describeFailure(error: unknown): string {
  if (error instanceof ArchiveError) return error.message.slice(0, 500);
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') {
      const text = /^[0-9A-Z]{5}$/.test(current.code)
        ? `PostgreSQL ${current.code}: ${current.message}`
        : current.code;
      return text.slice(0, 500);
    }
  }
  return (error instanceof Error ? error.name : '未知错误').slice(0, 500);
}

export interface ArchiveRunSummary {
  /** 本次走到的月份与阶段（导出、校验、分离）。 */
  advanced: { month: string; stage: ArchiveStage } | null;
  /** 本次丢弃的月份。 */
  dropped: string[];
  /** 另一个任务正在写这个月的临时文件，本次跳过。 */
  busy: string | null;
  failures: { month: string; step: ArchiveStep; message: string }[];
  inconsistent: ArchivePlan['inconsistent'];
}

const stageOrder: Record<ArchiveStage, number> = {
  exporting: 0,
  verified: 1,
  detached: 2,
  dropped: 3,
};

/** 并发的另一个任务已经把这个月推过了这一步：本任务的失败不算数，调用方按最新清单继续。 */
class ArchiveSupersededError extends Error {
  constructor(readonly month: string) {
    super(`${month.slice(0, 7)} 已被另一个任务推进`);
    this.name = 'ArchiveSupersededError';
  }
}

/**
 * 把一步包起来：抛错就记 failed（attempts + 1、last_error），再以 ArchiveError 往外抛。
 * 例外：另一个任务在写临时文件（Busy）、或清单显示别的任务已越过这一步（Superseded），都不算失败。
 */
async function step<T>(
  db: PoolDb,
  month: string,
  name: ArchiveStep,
  expected: ArchiveStage,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ArchiveBusyError) throw error;
    const latest = await loadManifest(db, month).catch(() => null);
    if (latest && stageOrder[stageOf(latest)] > stageOrder[expected])
      throw new ArchiveSupersededError(month);
    const message = describeFailure(error);
    await markFailed(db, month, `${name}: ${message}`).catch(() => undefined);
    throw new ArchiveError(message, name, { cause: error });
  }
}

/**
 * 导出 → 校验 → 改成正式文件名 → 记入清单（verified）。别的任务已经完成时返回最新清单，什么都不重做。
 * 校验没过或没能发布就丢掉临时文件，下次从头导出。
 */
async function exportAndVerify(
  db: PoolDb,
  store: ArchiveStore,
  month: string,
  options: ArchiveOptions,
): Promise<ArchiveManifest | null> {
  const fileKey = archiveFileKey(month);
  const checkpoint = async (point: ArchiveCheckpoint) => {
    await options.onCheckpoint?.(point);
  };
  const started = await step(db, month, 'export', 'exporting', () =>
    beginExport(db, month),
  );
  if (started) {
    const exported = await step(db, month, 'export', 'exporting', () =>
      exportMonthToPartial(db, store, month, {
        ...(options.staleAfterMs !== undefined && {
          staleAfterMs: options.staleAfterMs,
        }),
      }),
    );
    await step(db, month, 'verify', 'exporting', async () => {
      try {
        await checkpoint('exported');
        await verifyPartial(db, store, month, exported);
        await checkpoint('verified');
        await store.publish(fileKey);
        await checkpoint('published');
        // false：别的任务先一步完成，我们改名覆盖的是内容相同的文件，清单以它的为准。
        await markVerified(db, month, exported);
        await checkpoint('marked');
      } catch (error) {
        await store.remove(partialKey(fileKey)).catch(() => undefined);
        throw error;
      }
    });
  }
  return loadManifest(db, month);
}

/**
 * 把一个月推进到 detached（导出 → 校验 → 分离）。每步幂等，按清单里的时间戳续作：
 * 崩溃后再来一次，停在哪一步就从哪一步接着做。校验通过之前数据库一行不动。
 */
export async function archiveMonth(
  db: PoolDb,
  store: ArchiveStore,
  month: string,
  options: ArchiveOptions,
): Promise<ArchiveStage> {
  try {
    return await advanceMonth(db, store, month, options);
  } catch (error) {
    if (!(error instanceof ArchiveSupersededError)) throw error;
    const latest = await loadManifest(db, month);
    return latest ? stageOf(latest) : 'exporting';
  }
}

async function advanceMonth(
  db: PoolDb,
  store: ArchiveStore,
  month: string,
  options: ArchiveOptions,
): Promise<ArchiveStage> {
  let manifest = await loadManifest(db, month);
  if (!manifest || stageOf(manifest) === 'exporting')
    manifest = await exportAndVerify(db, store, month, options);
  if (!manifest) throw new ArchiveError('导出后清单里没有这个月', 'export');
  if (stageOf(manifest) !== 'verified') return stageOf(manifest);

  const archived = requireArchivedFile(manifest, month);
  await step(db, month, 'detach', 'verified', async () => {
    // 文件在 DETACH 之前必须还在、哈希与清单一致。
    await assertArchiveFile(store, archived, 'detach');
    // 分离（DDL）和清单更新在同一个事务里：要么都提交，要么都不动。
    try {
      await withSystem(db, async (tx) => {
        await tx.execute(
          sql`select raw_cdrs_detach_partition(${month}::date, ${JSON.stringify(archived.dbFingerprint)}::jsonb)`,
        );
        await options.onCheckpoint?.('detach-in-transaction');
        if (!(await markDetached(tx, month)))
          throw new ArchiveError('清单里的归档不能标为已分离', 'detach');
      });
    } catch (error) {
      // XX001：分区内容与导出时不一致，已有的文件不再代表分区——退回重新导出。
      if (sqlStateOf(error) === 'XX001') await requestReexport(db, month);
      throw error;
    }
  });
  return 'detached';
}

/** 步骤 4：宽限期之后丢弃 …_archived。丢弃之前再核对一次文件哈希：文件是原文的唯一副本。 */
export async function dropMonth(
  db: PoolDb,
  store: ArchiveStore,
  month: string,
  options: Pick<ArchiveOptions, 'onCheckpoint'> = {},
): Promise<void> {
  try {
    await dropDetached(db, store, month, options);
  } catch (error) {
    // 另一个任务已经丢弃了：目标达成，不算失败。
    if (!(error instanceof ArchiveSupersededError)) throw error;
  }
}

async function dropDetached(
  db: PoolDb,
  store: ArchiveStore,
  month: string,
  options: Pick<ArchiveOptions, 'onCheckpoint'>,
): Promise<void> {
  await step(db, month, 'drop', 'detached', async () => {
    const manifest = requireArchivedFile(await loadManifest(db, month), month);
    if (stageOf(manifest) !== 'detached')
      throw new ArchiveError(`${month.slice(0, 7)} 不处于已分离状态`, 'drop');
    await assertArchiveFile(store, manifest, 'drop');
    await withSystem(db, async (tx) => {
      await tx.execute(sql`select raw_cdrs_drop_detached(${month}::date)`);
      await options.onCheckpoint?.('drop-in-transaction');
      if (!(await markDropped(tx, month)))
        throw new ArchiveError('清单里的归档不能标为已丢弃', 'drop');
    });
  });
}

/**
 * 一次归档运行：先丢弃宽限期已过的月份，再把最老的未完成月推进到 detached。
 * 一个月失败不影响其他月份；失败记入清单（state = failed）并在 summary 里返回，由调用方开告警。
 */
export async function runRawArchive(
  db: PoolDb,
  store: ArchiveStore,
  options: ArchiveOptions,
): Promise<ArchiveRunSummary> {
  const plan = await planRawArchive(db, options);
  const summary: ArchiveRunSummary = {
    advanced: null,
    dropped: [],
    busy: null,
    failures: [],
    inconsistent: plan.inconsistent,
  };
  for (const month of plan.dropDue) {
    try {
      await dropMonth(db, store, month, options);
      summary.dropped.push(month);
    } catch (error) {
      summary.failures.push(failureOf(month, 'drop', error));
    }
  }
  if (plan.next) {
    try {
      summary.advanced = {
        month: plan.next,
        stage: await archiveMonth(db, store, plan.next, options),
      };
    } catch (error) {
      if (error instanceof ArchiveBusyError) summary.busy = plan.next;
      else summary.failures.push(failureOf(plan.next, 'export', error));
    }
  }
  return summary;
}

function failureOf(month: string, fallback: ArchiveStep, error: unknown) {
  return {
    month,
    step:
      error instanceof ArchiveError && isStep(error.step)
        ? error.step
        : fallback,
    message: describeFailure(error),
  };
}

const isStep = (value: string): value is ArchiveStep =>
  value === 'export' ||
  value === 'verify' ||
  value === 'detach' ||
  value === 'drop';
