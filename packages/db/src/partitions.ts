import { sql } from 'drizzle-orm';
import { withSystem, type Db } from './client.js';

/**
 * 维护操作：建 cdrs 与 raw_cdrs 从 moment（默认数据库 now()）所在月起、往后 monthsAhead 个月的分区，返回分区名。
 * 传连接池，自成一个系统身份事务：建分区不能和写入、租户锁放进同一事务，持有租户锁时数据库报 55000
 * （见迁移里 ensure_month_partition 的注释）。pnpm db:migrate 与种子调用它，阶段 3 由 Worker 每日调度。
 */
export async function ensureCdrPartitions(
  db: Db,
  { moment, monthsAhead = 1 }: { moment?: Date; monthsAhead?: number } = {},
): Promise<string[]> {
  const { rows } = await withSystem(db, (tx) =>
    tx.execute<{ name: string }>(
      sql`select cdr_ensure_partitions(coalesce(${moment ?? null}::timestamptz, now()), ${monthsAhead}) as name`,
    ),
  );
  return rows.map((row) => row.name);
}
