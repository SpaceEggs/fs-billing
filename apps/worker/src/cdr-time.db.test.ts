import type {} from '../../../packages/db/test/global-setup.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  createRateVersion,
  ensureCdrPartitions,
  withSystem,
} from '@fs-billing/db';
import { rate } from '@fs-billing/rating';
import type { ChargeJob } from '@fs-billing/shared';
import {
  connections,
  createTenant,
} from '../../../packages/db/test/support.js';
import { chargeCdr } from './charge.js';
import { ingestCdr } from './ingest.js';

const { app, owner } = connections();
const second = Date.parse('2026-10-12T02:00:09Z') / 1000;

beforeAll(() =>
  ensureCdrPartitions(app.db, { moment: new Date(second * 1000) }),
);

it('stores the newer rate and uses the .900 answer timestamp for the ledger charge', async () => {
  const tenant = await createTenant(app, 'CNY');
  for (const [offset, amount] of [
    [0, '0.1'],
    [500, '0.2'],
  ] as const) {
    await withSystem(app.db, (tx) =>
      createRateVersion(
        tx,
        tenant.id,
        [
          {
            iso: '',
            description: '',
            prefix: '447',
            country: 'UK',
            perMinute: rate('CNY', amount),
          },
        ],
        { effectiveFrom: new Date(second * 1000 + offset) },
      ),
    );
  }
  const uuid = randomUUID();
  const jobs: ChargeJob[] = [];
  const result = await ingestCdr(
    app.db,
    {
      enqueue(_tx, job) {
        jobs.push(job);
        return Promise.resolve();
      },
    },
    JSON.stringify({
      variables: {
        uuid,
        billing_tenant: tenant.code,
        destination_number: '+447700900123',
        billing_dialed_number: '+447700900123',
        billing_number: '447700900123',
        start_epoch: second - 9,
        start_uepoch: (second - 9) * 1e6 + 100123,
        answer_epoch: second,
        answer_uepoch: second * 1e6 + 900123,
        end_epoch: second + 60,
        end_uepoch: (second + 60) * 1e6 + 950123,
        billsec: 60,
        duration: 69,
      },
    }),
  );
  expect(result.status).toBe('queued');
  expect(jobs).toEqual([{ tenantId: tenant.id, callUuid: uuid }]);
  await chargeCdr(app.db, jobs[0]);
  const { rows } = await owner.pool.query(
    `select c.rate::text, c.started_at, c.answered_at, c.ended_at,
      l.amount::text, l.occurred_at, l.occurred_at = c.answered_at as same_time
      from cdrs c join ledger_entries l on l.idempotency_key = 'call:' || c.call_uuid::text
      where c.call_uuid = $1`,
    [uuid],
  );
  expect(rows).toEqual([
    {
      rate: '0.2',
      started_at: new Date('2026-10-12T02:00:00.100Z'),
      answered_at: new Date('2026-10-12T02:00:09.900Z'),
      ended_at: new Date('2026-10-12T02:01:09.950Z'),
      amount: '-0.2',
      occurred_at: new Date('2026-10-12T02:00:09.900Z'),
      same_time: true,
    },
  ]);
});
