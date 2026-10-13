import { connect } from '@fs-billing/db';
import { expect, test, vi } from 'vitest';
import { createWorker } from './app.js';

test('worker runs without an API or database process', async () => {
  const app = createWorker();
  try {
    const response = await app.inject('/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'worker' });
  } finally {
    await app.close();
  }
});

test.each([
  {
    url: '/cdr',
    payload: '{}',
    expectedError: '话单保存失败，请重推',
  },
  {
    url: '/authorize',
    payload: JSON.stringify({
      tenant: 'ABC01',
      callee: '447700900123',
      uuid: 'debf1234-1234-4234-8234-123456789abc',
    }),
    expectedError: '授权服务暂不可用',
  },
])(
  '$url returns a generic retryable response when the database is unavailable',
  async ({ url, payload, expectedError }) => {
    const connection = connect('postgresql://localhost/unused');
    const transaction = vi
      .spyOn(connection.db, 'transaction')
      .mockRejectedValueOnce(new Error('private database connection details'))
      .mockRejectedValue(new Error('private alert write details'));
    const app = createWorker({
      db: connection.db,
      queue: { enqueue: async () => {} },
      security: { secret: 'test-worker-key', allowedIps: ['127.0.0.1'] },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          'x-billing-key': 'test-worker-key',
        },
        payload,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: expectedError });
      expect(response.body).not.toContain('private');
    } finally {
      transaction.mockRestore();
      await app.close();
      await connection.pool.end();
    }
  },
);
