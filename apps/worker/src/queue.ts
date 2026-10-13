import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss, getConstructionPlans } from 'pg-boss';
import {
  APP_ROLE,
  lockTenants,
  withSystem,
  type Connection,
  type Db,
  type Tx,
} from '@fs-billing/db';
import type { ChargeJob } from '@fs-billing/shared';

export const CHARGE_QUEUE = 'charge-cdr';
export const PARTITION_QUEUE = 'maintain-cdr-partitions';
export interface ChargeQueue {
  enqueue(tx: Tx, job: ChargeJob): Promise<void>;
}

// 队列数据库操作同样声明系统身份；入队使用调用方事务，避免话单已入库却丢任务。
export function createBoss(db: Db): PgBoss {
  return new PgBoss({
    db: {
      executeSql: (text, values) =>
        withSystem(db, async (tx) => {
          await lockTenants(tx, []);
          return fromDrizzle(tx, sql).executeSql(text, values);
        }),
    },
    supervise: true,
    schedule: true,
    // 应用角色不执行队列索引维护 DDL。
    reindex: false,
    // 沿用 Phase 2 租户锁规则；队列辅助维护不另拿 advisory 锁。
    noAdvisoryLocks: true,
    persistQueueStats: false,
    migrate: false,
    createSchema: false,
  });
}

export function chargeQueue(boss: PgBoss): ChargeQueue {
  return {
    async enqueue(tx, job) {
      const id = await boss.send(CHARGE_QUEUE, job, {
        db: fromDrizzle(tx, sql),
      });
      if (id === null) throw new Error('话单扣费任务未入队');
    },
  };
}

/** 仅部署时由 owner 安装；运行时应用角色不能创建 schema 或表。 */
export async function installQueue({ pool }: Connection): Promise<void> {
  const { rows } = await pool.query<{ exists: boolean }>(
    "select to_regclass('pgboss.version') is not null as exists",
  );
  if (!rows[0]!.exists) await pool.query(getConstructionPlans());
  await pool.query(`GRANT USAGE ON SCHEMA pgboss TO ${APP_ROLE}`);
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${APP_ROLE}`,
  );
  await pool.query(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ${APP_ROLE}`,
  );
  // 提前建队列，运行时只做 DML，避免应用角色需要建表权限。
  const boss = new PgBoss({
    db: { executeSql: (text, values) => pool.query(text, values) },
    supervise: false,
    schedule: false,
  });
  try {
    await boss.start();
    await boss.createQueue(CHARGE_QUEUE, { retryLimit: 3, retryDelay: 0 });
    await boss.updateQueue(CHARGE_QUEUE, { retryLimit: 3, retryDelay: 0 });
    await boss.createQueue(PARTITION_QUEUE, { retryLimit: 3 });
    await boss.createQueue('__pgboss__send-it');
  } finally {
    await boss.stop();
  }
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${APP_ROLE}`,
  );
}
