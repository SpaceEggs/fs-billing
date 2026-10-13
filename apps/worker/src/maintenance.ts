import { ensureCdrPartitions, type PoolDb } from '@fs-billing/db';
import type { FastifyBaseLogger } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { postgresError, recordAlert } from './ingest.js';
import { PARTITION_QUEUE } from './queue.js';

/** 启动与每日任务共用；维护自成事务，失败告警后让调用方看到错误。 */
export async function maintainPartitions(
  db: PoolDb,
  logger: FastifyBaseLogger,
) {
  try {
    await ensureCdrPartitions(db);
  } catch (error) {
    logger.error({ err: error }, '话单分区维护失败');
    await recordAlert(
      db,
      'partition_failed',
      `话单分区维护失败: ${postgresError(error)?.message ?? '数据库连接或维护失败'}`,
    );
    throw error;
  }
}

export async function startPartitionMaintenance(
  boss: PgBoss,
  db: PoolDb,
  logger: FastifyBaseLogger,
) {
  await maintainPartitions(db, logger);
  await boss.work(PARTITION_QUEUE, async () => {
    await maintainPartitions(db, logger);
  });
  await boss.schedule(PARTITION_QUEUE, '0 0 * * *', null, {
    tz: 'Asia/Shanghai',
  });
}
