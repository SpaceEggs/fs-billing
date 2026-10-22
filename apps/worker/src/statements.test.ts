import { describe, expect, it } from 'vitest';
import { workerEnvironmentSchema } from './config.js';
import {
  GENERATE_STATEMENTS_QUEUE,
  GENERATE_STATEMENT_QUEUE,
  RECONCILE_STATEMENTS_QUEUE,
  STATEMENT_QUEUES,
} from './queue.js';
import {
  GENERATE_STATEMENTS_CRON,
  RECONCILE_STATEMENTS_CRON,
  STATEMENT_TIMEZONE,
  statementJobData,
  statementJobId,
  statementSingletonKey,
} from './statements.js';

const tenant = '3f1c0a5e-6a0e-4b0c-9d57-0c2b0a1f7d11';
const environment = {
  APP_DATABASE_URL:
    'postgresql://fs_billing_app:local@127.0.0.1:5432/fs_billing',
  WORKER_SHARED_KEY: 'test-worker-key-123456',
  WORKER_ALLOWED_IPS: '127.0.0.1',
};

describe('月账单任务的纯逻辑', () => {
  it('derives a deterministic child id from tenant, month and run day', () => {
    const id = statementJobId(tenant, '2026-09-01', '2026-10-02');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(statementJobId(tenant, '2026-09-01', '2026-10-02')).toBe(id);
    expect(statementJobId(tenant, '2026-09-01', '2026-10-03')).not.toBe(id);
    expect(statementJobId(tenant, '2026-08-01', '2026-10-02')).not.toBe(id);
    expect(
      statementJobId(
        '3f1c0a5e-6a0e-4b0c-9d57-0c2b0a1f7d12',
        '2026-09-01',
        '2026-10-02',
      ),
    ).not.toBe(id);
    expect(statementSingletonKey(tenant, '2026-09-01')).toBe(
      `${tenant}:2026-09-01`,
    );
  });

  it('accepts only a tenant uuid and a first-of-month date as child data', () => {
    expect(
      statementJobData.parse({ tenantId: tenant, month: '2026-09-01' }),
    ).toEqual({ tenantId: tenant, month: '2026-09-01' });
    for (const bad of [
      { tenantId: 'x', month: '2026-09-01' },
      { tenantId: tenant, month: '2026-09-15' },
      { tenantId: tenant, month: '2026-13-01' },
      { tenantId: tenant },
    ])
      expect(() => statementJobData.parse(bad)).toThrow();
  });

  it('schedules generation at 02:00 and reconciliation at 03:00 Beijing time', () => {
    expect(GENERATE_STATEMENTS_CRON).toBe('0 2 * * *');
    expect(RECONCILE_STATEMENTS_CRON).toBe('0 3 * * *');
    expect(STATEMENT_TIMEZONE).toBe('Asia/Shanghai');
  });

  it('provisions all three statement queues with retries', () => {
    expect(Object.keys(STATEMENT_QUEUES).sort()).toEqual(
      [
        GENERATE_STATEMENTS_QUEUE,
        GENERATE_STATEMENT_QUEUE,
        RECONCILE_STATEMENTS_QUEUE,
      ].sort(),
    );
    for (const options of Object.values(STATEMENT_QUEUES))
      expect(options.retryLimit).toBe(3);
  });

  it('configures backfill months and child concurrency with defaults', () => {
    expect(workerEnvironmentSchema.parse(environment)).toMatchObject({
      STATEMENT_BACKFILL_MONTHS: 24,
      WORKER_STATEMENT_CONCURRENCY: 2,
    });
    expect(
      workerEnvironmentSchema.parse({
        ...environment,
        STATEMENT_BACKFILL_MONTHS: '36',
        WORKER_STATEMENT_CONCURRENCY: '4',
      }),
    ).toMatchObject({
      STATEMENT_BACKFILL_MONTHS: 36,
      WORKER_STATEMENT_CONCURRENCY: 4,
    });
    for (const bad of [
      { STATEMENT_BACKFILL_MONTHS: '0' },
      { STATEMENT_BACKFILL_MONTHS: '121' },
      { WORKER_STATEMENT_CONCURRENCY: '0' },
      { WORKER_STATEMENT_CONCURRENCY: '1.5' },
    ])
      expect(() =>
        workerEnvironmentSchema.parse({ ...environment, ...bad }),
      ).toThrow();
  });
});
