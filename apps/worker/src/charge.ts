import type { FastifyBaseLogger } from 'fastify';
import type { Job, JobResult, WorkOptions } from 'pg-boss';
import { chargeCall, lockTenants, withSystem, type Db } from '@fs-billing/db';
import { chargeJobSchema } from '@fs-billing/shared';

/**
 * 接通时刻的费率由入库保存为快照；任务按该费率计价，流水与余额在同一事务提交。
 * 计价与写流水在 packages/db 的 chargeCall，未归属话单的分配与这里共用。
 */
export async function chargeCdr(db: Db, input: unknown): Promise<void> {
  const job = chargeJobSchema.parse(input);
  await withSystem(db, async (tx) => {
    await lockTenants(tx, [job.tenantId]);
    await chargeCall(tx, job);
  });
}

/**
 * 扣费任务的工作参数。pg-boss 默认每次只取 1 个任务、每 2 秒轮询一次，单实例上限约 0.5 个/秒；
 * 生产要求至少 10 个/秒。批内逐单结算（perJobResults）保证一个坏任务只重试自己，
 * burstWhenBatchFull 让取满一批时立即继续取，空队列仍按默认 2 秒轮询，不增加空闲开销。
 */
export function chargeWorkOptions(batchSize: number): WorkOptions {
  return {
    batchSize,
    burstWhenBatchFull: true,
    perJobResults: true,
  };
}

/**
 * 处理一批扣费任务。每个任务在自己的事务里扣费，失败只把该任务交回 pg-boss 重试/死信，
 * 已成功的同批任务照常确认，不会因为邻居失败而重复扣费。
 */
export async function chargeJobs(
  db: Db,
  jobs: readonly Job<unknown>[],
  logger: Pick<FastifyBaseLogger, 'error'>,
): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const job of jobs) {
    try {
      await chargeCdr(db, job.data);
      results.push({ id: job.id, status: 'completed' });
    } catch (error) {
      logger.error({ err: error, jobId: job.id }, '话单扣费失败');
      results.push({
        id: job.id,
        status: 'failed',
        output: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return results;
}
