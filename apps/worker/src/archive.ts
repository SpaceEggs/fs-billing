import { and, eq, isNull, like, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  lockTenants,
  runRawArchive,
  schema,
  withSystem,
  type ArchiveOptions,
  type ArchiveRunSummary,
  type ArchiveStore,
  type PoolDb,
} from '@fs-billing/db';
import { ARCHIVE_QUEUE } from './queue.js';

/** 归档在 04:00（北京时间）：01:00 分区维护之后，与 02:00 账单生成、03:00 账单核对错开。 */
export const ARCHIVE_CRON = '0 4 * * *';
export const ARCHIVE_TIMEZONE = 'Asia/Shanghai';

type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

/** 一个月同时只开一条未恢复的告警，按描述前缀识别（同账单核对的做法）。 */
const alertPrefix = (month: string) => `原始话单归档 ${month.slice(0, 7)} `;

/**
 * 失败开 `raw_archive_failed` 告警（每月一条，再次失败更新描述），成功（推进或丢弃）后置 recovered_at；
 * 已丢弃的月份也一并恢复。矛盾状态（清单与分区对不上）同样开告警，但不触发重试。
 */
export async function syncArchiveAlerts(
  db: PoolDb,
  summary: ArchiveRunSummary,
): Promise<void> {
  const failing = new Map<string, string>();
  for (const failure of summary.failures)
    failing.set(
      failure.month,
      `${alertPrefix(failure.month)}失败（${failure.step}）：${failure.message}`,
    );
  for (const item of summary.inconsistent)
    failing.set(
      item.month,
      `${alertPrefix(item.month)}状态矛盾：${item.reason}`,
    );
  const succeeded = [
    ...(summary.advanced ? [summary.advanced.month] : []),
    ...summary.dropped,
  ].filter((month) => !failing.has(month));
  await withSystem(db, async (tx) => {
    await lockTenants(tx, []);
    for (const [month, description] of failing) {
      const updated = await tx
        .update(schema.systemAlerts)
        .set({ description })
        .where(
          and(
            eq(schema.systemAlerts.kind, 'raw_archive_failed'),
            isNull(schema.systemAlerts.recoveredAt),
            like(schema.systemAlerts.description, `${alertPrefix(month)}%`),
          ),
        )
        .returning({ id: schema.systemAlerts.id });
      if (updated.length === 0)
        await tx.insert(schema.systemAlerts).values({
          kind: 'raw_archive_failed',
          description,
          affectedCalls: 0,
        });
    }
    for (const month of succeeded)
      await tx
        .update(schema.systemAlerts)
        .set({ recoveredAt: sql`now()` })
        .where(
          and(
            eq(schema.systemAlerts.kind, 'raw_archive_failed'),
            isNull(schema.systemAlerts.recoveredAt),
            like(schema.systemAlerts.description, `${alertPrefix(month)}%`),
          ),
        );
    // 已丢弃的月份没有什么可失败的了：残留的告警一并恢复（例如人工处理过）。
    await tx.execute(sql`
      UPDATE system_alerts a SET recovered_at = now()
      WHERE a.kind = 'raw_archive_failed' AND a.recovered_at IS NULL
        AND EXISTS (SELECT 1 FROM raw_cdr_archives m
          WHERE m.dropped_at IS NOT NULL
            AND a.description LIKE '原始话单归档 ' || to_char(m.month, 'YYYY-MM') || ' %')`);
  });
}

/**
 * 一次归档运行（pg-boss 任务体）：先丢弃宽限期已过的月份，再把最老的未完成月推进到 detached。
 * 失败写清单并开告警，然后抛出，由 pg-boss 退避重试；仍失败则次日 04:00 再来。
 */
export async function runRawArchiveJob(
  db: PoolDb,
  store: ArchiveStore,
  options: ArchiveOptions,
  logger: Logger,
): Promise<ArchiveRunSummary> {
  const startedAt = Date.now();
  const summary = await runRawArchive(db, store, options);
  await syncArchiveAlerts(db, summary);
  logger.info(
    {
      advanced: summary.advanced,
      dropped: summary.dropped,
      busy: summary.busy,
      failures: summary.failures,
      inconsistent: summary.inconsistent,
      elapsedMs: Date.now() - startedAt,
    },
    '原始话单归档运行结束',
  );
  if (summary.failures.length > 0)
    throw new Error(
      `原始话单归档失败: ${summary.failures
        .map((failure) => `${failure.month.slice(0, 7)}（${failure.step}）`)
        .join('、')}`,
    );
  return summary;
}

export async function startRawArchive(
  boss: PgBoss,
  db: PoolDb,
  store: ArchiveStore,
  options: ArchiveOptions,
  logger: Logger,
) {
  await boss.work(ARCHIVE_QUEUE, async () => {
    try {
      await runRawArchiveJob(db, store, options, logger);
    } catch (error) {
      logger.error({ err: error }, '原始话单归档失败');
      throw error;
    }
  });
  // cron 默认不补发停机期间错过的触发；missed: 'once' 在恢复后补发最近一次（同账单任务）。
  await boss.schedule(ARCHIVE_QUEUE, ARCHIVE_CRON, null, {
    tz: ARCHIVE_TIMEZONE,
    missed: 'once',
  });
}
