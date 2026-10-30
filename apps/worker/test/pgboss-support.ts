import type { Job, PgBoss } from 'pg-boss';
import type { Connection } from '@fs-billing/db';

/**
 * 真实 cron / 多实例测试的公用部分（只被 *.db.test.ts 引用）。
 */

/**
 * 包一层 `PgBoss`，只给 `startNotifyJobs` 用到的 `work` 和 `schedule`：处理函数运行前把每个任务的 id 记下来。
 * 生产代码不为测试开口子；真实的处理函数照常运行，测试靠 id 核对「每个任务恰好执行一次」。
 */
export function recordingBoss(boss: PgBoss, handled: string[]): PgBoss {
  return {
    work: (name: string, handler: (jobs: Job<unknown>[]) => Promise<unknown>) =>
      boss.work(name, async (jobs: Job<unknown>[]) => {
        for (const job of jobs) handled.push(job.id);
        return handler(jobs);
      }),
    schedule: (...args: Parameters<PgBoss['schedule']>) =>
      boss.schedule(...args),
  } as unknown as PgBoss;
}

/**
 * 数一个连接池发出的、文本匹配 `pattern` 的 SQL 语句条数（在池建立新连接时包装 `client.query`）。
 * 必须在池第一次使用之前调用。用来证明「两个实例都参与了」：每个实例的池各数各的。
 */
export function countStatements(
  pool: Connection['pool'],
  pattern: RegExp,
): () => number {
  let count = 0;
  pool.on('connect', (client) => {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const first = args[0];
      const text =
        typeof first === 'string'
          ? first
          : ((first as { text?: string } | undefined)?.text ?? '');
      if (pattern.test(text)) count++;
      return original(...args);
    };
  });
  return () => count;
}
