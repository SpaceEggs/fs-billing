import { createHash } from 'node:crypto';
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
export const RECONCILE_QUEUE = 'reconcile-cdr-charges';
export const PARTITION_QUEUE = 'maintain-cdr-partitions';
// 原始 JSON 归档（阶段 8）：每天 04:00，一次运行推进一个月。exclusive：同一时刻只允许一个任务排队、重试或执行，
// 重复触发和多实例都不会并发归档；导出一个月分区要读完整个分区，给足执行期限。
export const ARCHIVE_QUEUE = 'archive-raw-cdrs';
export const ARCHIVE_QUEUE_POLICY = 'exclusive';
export const ARCHIVE_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 300,
  retryBackoff: true,
  expireInSeconds: 6 * 3600,
} as const;
// 通知：每分钟一次的 notify-tick（阶段 9）：告警恢复，故障告警的开始/汇总/恢复邮件入队，邮件分发。exclusive：上一轮还在发送时下一分钟的触发被丢掉，
// 分发始终单实例串行；重试靠下一分钟的 tick 自己认领到期的邮件，所以任务本身不重试。
export const NOTIFY_QUEUE = 'notify-tick';
export const NOTIFY_QUEUE_POLICY = 'exclusive';
export const NOTIFY_QUEUE_OPTIONS = {
  retryLimit: 0,
  expireInSeconds: 600,
} as const;
// 月账单：每日父任务扇出成每个 (租户, 月份) 一个子任务；核对任务每日一次。
export const GENERATE_STATEMENTS_QUEUE = 'generate-statements';
export const GENERATE_STATEMENT_QUEUE = 'generate-statement';
export const RECONCILE_STATEMENTS_QUEUE = 'reconcile-statements';
// 子任务失败抛出，由 pg-boss 退避重试；仍失败则进入 failed，次日父任务再补一次。
export const STATEMENT_QUEUES = {
  [GENERATE_STATEMENTS_QUEUE]: { retryLimit: 3, retryDelay: 60 },
  [GENERATE_STATEMENT_QUEUE]: {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  },
  // 全库核对随流水总量增长，给比默认 15 分钟更长的执行期限。
  [RECONCILE_STATEMENTS_QUEUE]: {
    retryLimit: 3,
    retryDelay: 60,
    expireInSeconds: 3600,
  },
} as const;
export interface ChargeQueue {
  enqueue(tx: Tx, job: ChargeJob, attempt?: number): Promise<void>;
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

// 每轮补投有稳定任务 ID；同一轮事务重跑也不能产生第二个任务。
export function chargeJobId(callUuid: string, attempt = 0): string {
  const hex = createHash('sha256')
    .update(`${callUuid}:${attempt}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function chargeQueue(boss: PgBoss): ChargeQueue {
  return {
    async enqueue(tx, job, attempt = 0) {
      const id = await boss.send(CHARGE_QUEUE, job, {
        db: fromDrizzle(tx, sql),
        singletonKey: job.callUuid,
        id: chargeJobId(job.callUuid, attempt),
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
    await boss.createQueue(CHARGE_QUEUE, {
      retryLimit: 3,
      retryDelay: 0,
    });
    await boss.updateQueue(CHARGE_QUEUE, {
      retryLimit: 3,
      retryDelay: 0,
    });
    await boss.createQueue(RECONCILE_QUEUE, { retryLimit: 3 });
    await boss.createQueue(PARTITION_QUEUE, { retryLimit: 3 });
    // 账单队列选项变化时重复执行本脚本即可生效（createQueue 对已有队列不改选项）。
    for (const [name, options] of Object.entries(STATEMENT_QUEUES)) {
      await boss.createQueue(name, options);
      await boss.updateQueue(name, options);
    }
    // 归档队列的策略（exclusive）只能在建队列时设定；其余选项变化时重复执行本脚本即可生效。
    await boss.createQueue(ARCHIVE_QUEUE, {
      policy: ARCHIVE_QUEUE_POLICY,
      ...ARCHIVE_QUEUE_OPTIONS,
    });
    await boss.updateQueue(ARCHIVE_QUEUE, ARCHIVE_QUEUE_OPTIONS);
    // 通知队列同归档：策略（exclusive）只能在建队列时设定，其余选项变化时重复执行本脚本即可生效。
    await boss.createQueue(NOTIFY_QUEUE, {
      policy: NOTIFY_QUEUE_POLICY,
      ...NOTIFY_QUEUE_OPTIONS,
    });
    await boss.updateQueue(NOTIFY_QUEUE, NOTIFY_QUEUE_OPTIONS);
    await boss.createQueue('__pgboss__send-it');
  } finally {
    await boss.stop();
  }
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${APP_ROLE}`,
  );
}
