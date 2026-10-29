import {
  AlertKeys,
  ensureCdrPartitions,
  recoverAlert,
  withSystem,
  type PoolDb,
} from '@fs-billing/db';
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
    await recordAlert(db, {
      kind: 'partition_failed',
      subjectKey: AlertKeys.partitionMaintenance,
      description: `话单分区维护失败: ${postgresError(error)?.message ?? '数据库连接或维护失败'}`,
      calls: 1,
    });
    throw error;
  }
  // 分区维护成功：只恢复维护失败那一条。partition-missing 不随维护恢复——维护只建当月和下一个月，
  // 缺的若是被归档分离的旧月或更远的将来月，维护成功而入库仍 23514，恢复会和下一条话单的告警来回开关；
  // 它走静默窗口（recoverQuietAlerts）。
  await withSystem(db, (tx) =>
    recoverAlert(tx, {
      kind: 'partition_failed',
      subjectKey: AlertKeys.partitionMaintenance,
    }),
  );
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
