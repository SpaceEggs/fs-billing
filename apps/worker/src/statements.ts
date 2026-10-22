import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { z } from 'zod';
import {
  generateStatement,
  listMissingStatements,
  reconcileTenantStatements,
  withSystem,
  type Db,
  type GenerateOutcome,
} from '@fs-billing/db';
import {
  GENERATE_STATEMENTS_QUEUE,
  GENERATE_STATEMENT_QUEUE,
  RECONCILE_STATEMENTS_QUEUE,
} from './queue.js';

/** 账单的所有调度都按北京时间。 */
export const STATEMENT_TIMEZONE = 'Asia/Shanghai';
/** 每天 02:00 生成（设计稿「账单生成于 … 02:00:15」），在 00:00 的分区维护之后。 */
export const GENERATE_STATEMENTS_CRON = '0 2 * * *';
/** 每天 03:00 核对，在生成之后。 */
export const RECONCILE_STATEMENTS_CRON = '0 3 * * *';

export interface StatementJobOptions {
  /** 补缺的最大月数（STATEMENT_BACKFILL_MONTHS）。 */
  backfillMonths: number;
  /** 子任务并发（WORKER_STATEMENT_CONCURRENCY）。 */
  concurrency: number;
}

type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

const snapshot = { isolationLevel: 'repeatable read' } as const;

// 定时触发的任务没有数据；手动 send 可以带 tenantId 只处理一个租户（运维补建与测试）。
const parentData = z
  .object({ tenantId: z.uuid().optional() })
  .nullish()
  .transform((value) => value ?? {});
export const statementJobData = z.object({
  tenantId: z.uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/),
});
export type StatementJob = z.infer<typeof statementJobData>;

/**
 * 子任务 ID：由租户、月份与父任务运行的北京日算出。同一天重复触发的父任务得到同一个 ID，
 * pg-boss 的主键冲突让第二次入队不产生任务；失败耗尽的子任务不会永久占住 ID，次日父任务可以重新入队。
 */
export function statementJobId(
  tenantId: string,
  month: string,
  runDay: string,
): string {
  const hex = createHash('sha256')
    .update(`${tenantId}:${month}:${runDay}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const statementSingletonKey = (tenantId: string, month: string) =>
  `${tenantId}:${month}`;

export interface EnqueueOptions {
  backfillMonths: number;
  /** 只处理一个租户。 */
  tenantId?: string;
  /** 测试用的“现在”。 */
  asOf?: Date;
}

export interface EnqueueSummary {
  /** 应有而缺失的 (租户, 月份) 数。 */
  missing: number;
  enqueued: number;
  /** 同一天已入过队（父任务重复触发）。 */
  duplicates: number;
  /** 上一轮的子任务仍在排队、重试或执行。 */
  inFlight: number;
}

/**
 * 父任务：列出所有租户应有而缺失的已结束月份（每天运行，所以 Worker 停机多日后的第一次运行补出全部缺口，
 * 最多 backfillMonths 个月），在同一事务里逐个入队子任务。只入队缺失的月份：已有账单从不覆盖。
 */
export async function enqueueMissingStatements(
  db: Db,
  boss: PgBoss,
  options: EnqueueOptions,
): Promise<EnqueueSummary> {
  return withSystem(db, async (tx) => {
    const missing = await listMissingStatements(tx, {
      backfillMonths: options.backfillMonths,
      ...(options.tenantId && { tenantId: options.tenantId }),
      ...(options.asOf && { asOf: options.asOf }),
    });
    const { rows } = await tx.execute<{ day: string }>(sql`
      select to_char(coalesce(${options.asOf ?? null}::timestamptz, statement_timestamp())
        at time zone ${STATEMENT_TIMEZONE}, 'YYYY-MM-DD') as day`);
    const runDay = rows[0]!.day;
    const summary: EnqueueSummary = {
      missing: missing.length,
      enqueued: 0,
      duplicates: 0,
      inFlight: 0,
    };
    for (const entry of missing) {
      const singletonKey = statementSingletonKey(entry.tenantId, entry.month);
      const active = await tx.execute(sql`SELECT 1 FROM pgboss.job
        WHERE name = ${GENERATE_STATEMENT_QUEUE} AND singleton_key = ${singletonKey}
          AND state IN ('created', 'retry', 'active') LIMIT 1`);
      if (active.rows.length) {
        summary.inFlight++;
        continue;
      }
      const id = await boss.send(
        GENERATE_STATEMENT_QUEUE,
        { tenantId: entry.tenantId, month: entry.month } satisfies StatementJob,
        {
          singletonKey,
          id: statementJobId(entry.tenantId, entry.month, runDay),
          db: fromDrizzle(tx, sql),
        },
      );
      if (id === null) summary.duplicates++;
      else summary.enqueued++;
    }
    return summary;
  });
}

/** 子任务：一个租户一个月份。已有账单（含并发抢先）返回 exists，不写任何东西。 */
export async function generateOneStatement(
  db: Db,
  job: StatementJob,
): Promise<GenerateOutcome> {
  return withSystem(
    db,
    (tx) => generateStatement(tx, job.tenantId, job.month),
    snapshot,
  );
}

export interface ReconcileSummary {
  tenants: number;
  statements: number;
  stale: number;
  inconsistent: number;
  missing: number;
  alertsOpened: number;
  alertsUpdated: number;
  alertsRecovered: number;
}

/**
 * 核对任务：逐租户一个快照事务（状态写回头部、开 / 更新 / 恢复 statement_mismatch 告警都在 db 层）。
 * 单个租户失败记录日志并继续，末尾抛出汇总错误让 pg-boss 重试整个任务；重试是幂等的。
 */
export async function reconcileStatements(
  db: Db,
  options: { backfillMonths: number; tenantIds?: string[]; asOf?: Date },
  logger: Logger,
): Promise<ReconcileSummary> {
  const tenants = await withSystem(db, async (tx) => {
    const { rows } = await tx.execute<{ id: string; code: string }>(
      options.tenantIds
        ? sql`select id, code from tenants where id in (${sql.join(
            options.tenantIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) order by code`
        : sql`select id, code from tenants order by code`,
    );
    return rows;
  });
  const summary: ReconcileSummary = {
    tenants: tenants.length,
    statements: 0,
    stale: 0,
    inconsistent: 0,
    missing: 0,
    alertsOpened: 0,
    alertsUpdated: 0,
    alertsRecovered: 0,
  };
  const errors: unknown[] = [];
  for (const tenant of tenants) {
    try {
      const result = await withSystem(
        db,
        (tx) =>
          reconcileTenantStatements(tx, tenant.id, {
            backfillMonths: options.backfillMonths,
            ...(options.asOf && { asOf: options.asOf }),
          }),
        snapshot,
      );
      summary.statements += result.statements.length;
      summary.missing += result.missing.length;
      summary.alertsOpened += result.alertsOpened;
      summary.alertsUpdated += result.alertsUpdated;
      summary.alertsRecovered += result.alertsRecovered;
      for (const statement of result.statements) {
        if (statement.status === 'stale') summary.stale++;
        if (statement.status === 'inconsistent') summary.inconsistent++;
        if (statement.status !== 'ok')
          logger.warn(
            {
              tenantId: tenant.id,
              tenantCode: tenant.code,
              month: statement.month,
              status: statement.status,
              diff: statement.diff,
              lateEntries: statement.lateEntries,
            },
            '账单与流水不一致',
          );
      }
      if (result.missing.length)
        logger.warn(
          {
            tenantId: tenant.id,
            tenantCode: tenant.code,
            months: result.missing,
          },
          '账单缺失',
        );
    } catch (error) {
      logger.error(
        { err: error, tenantId: tenant.id, tenantCode: tenant.code },
        '账单核对失败',
      );
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, '账单核对未全部完成');
  return summary;
}

/** 注册三个队列的 worker 与两个每日调度。队列由 owner 的 queue:migrate 预先创建。 */
export async function startStatementJobs(
  boss: PgBoss,
  db: Db,
  options: StatementJobOptions,
  logger: Logger,
) {
  await boss.work(
    GENERATE_STATEMENT_QUEUE,
    {
      localConcurrency: options.concurrency,
    },
    async (jobs) => {
      for (const job of jobs) {
        const data = statementJobData.parse(job.data);
        try {
          const result = await generateOneStatement(db, data);
          logger.info(
            { jobId: job.id, ...data, outcome: result.outcome },
            result.outcome === 'created' ? '账单已生成' : '账单已存在，跳过',
          );
        } catch (error) {
          logger.error({ err: error, jobId: job.id, ...data }, '账单生成失败');
          throw error;
        }
      }
    },
  );
  await boss.work(GENERATE_STATEMENTS_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = parentData.parse(job.data);
      const summary = await enqueueMissingStatements(db, boss, {
        backfillMonths: options.backfillMonths,
        ...(data.tenantId && { tenantId: data.tenantId }),
      });
      logger.info({ jobId: job.id, ...summary }, '账单生成任务已扇出');
    }
  });
  await boss.work(RECONCILE_STATEMENTS_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = parentData.parse(job.data);
      const summary = await reconcileStatements(
        db,
        {
          backfillMonths: options.backfillMonths,
          ...(data.tenantId && { tenantIds: [data.tenantId] }),
        },
        logger,
      );
      logger.info({ jobId: job.id, ...summary }, '账单核对完成');
    }
  });
  // pg-boss 的 cron 默认不补发 Worker 停机时错过的触发；missed: 'once' 在恢复后补发最近一次，
  // 而父任务本身补齐全部缺失月份，所以停机多日也只需要一次触发。
  await boss.schedule(
    GENERATE_STATEMENTS_QUEUE,
    GENERATE_STATEMENTS_CRON,
    null,
    {
      tz: STATEMENT_TIMEZONE,
      missed: 'once',
    },
  );
  await boss.schedule(
    RECONCILE_STATEMENTS_QUEUE,
    RECONCILE_STATEMENTS_CRON,
    null,
    {
      tz: STATEMENT_TIMEZONE,
      missed: 'once',
    },
  );
}

/**
 * 启动时立即补一轮（cron 之外的兜底：首次部署、missed 记录丢失、停机跨过 02:00）。
 * 幂等：已有账单不覆盖，同一天重复触发不产生第二个子任务。
 */
export async function requestStatementCatchUp(boss: PgBoss): Promise<void> {
  await boss.send(GENERATE_STATEMENTS_QUEUE, {});
}
