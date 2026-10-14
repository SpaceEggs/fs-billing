import { connect } from '@fs-billing/db';
import { expect, test, vi } from 'vitest';
import { createWorker } from './app.js';
import { invalidCdrIdentitySchema } from './invalid-cdr.js';

test('invalid new CDR retains the original dialed number for display', () => {
  const identity = invalidCdrIdentitySchema.parse({
    variables: {
      destination_number: 'billing-bridge',
      billing_dialed_number: '+447700900123',
      billing_number: 123,
    },
  });
  expect(identity.variables.destination_number).toBe('+447700900123');
});

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
    numbers: { callee: '+1234567890123456', dialedNumber: '+1234567890123456' },
    sipCode: 484,
  },
  { numbers: { callee: '138|evil', dialedNumber: '138|evil' }, sipCode: 484 },
  { numbers: { callee: '138,evil', dialedNumber: '138,evil' }, sipCode: 484 },
  { numbers: { callee: '123\n', dialedNumber: '123\n' }, sipCode: 484 },
  {
    numbers: { callee: '13800138000', dialedNumber: 13800138000 },
    sipCode: 484,
  },
  { numbers: { callee: '1234567890123456' }, sipCode: 400 },
  ...['0', '1', '+1', '0044', '075586001234'].map((callee) => ({
    numbers: { callee },
    sipCode: 400,
  })),
  ...['0', '1', '+1', '0044'].map((dialedNumber) => ({
    numbers: { callee: dialedNumber, dialedNumber },
    sipCode: 484,
  })),
])(
  'authorize rejects invalid number input before reading the DB %j',
  async ({ numbers, sipCode }) => {
    const connection = connect('postgresql://localhost/unused');
    const transaction = vi.spyOn(connection.db, 'transaction');
    const app = createWorker({
      db: connection.db,
      queue: { enqueue: async () => {} },
      security: { secret: 'test-worker-key', allowedIps: ['127.0.0.1'] },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/authorize',
        headers: { 'x-billing-key': 'test-worker-key' },
        payload: {
          tenant: 'ABC01',
          uuid: 'debf1234-1234-4234-8234-123456789abc',
          ...numbers,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        allowed: false,
        reason: '号码格式错误',
        sipCode,
      });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
      await app.close();
      await connection.pool.end();
    }
  },
);

test.each([
  { callee: '13800138000', billingNumber: '8613800138000' },
  { callee: '13800138000', dialedNumber: '13800138000' },
  {
    callee: '8613800138000',
    dialedNumber: '13800138000',
    billingNumber: '13055551234',
  },
])('authorize fails closed on projection mismatch %j', async (numbers) => {
  const connection = connect('postgresql://localhost/unused');
  const transaction = vi.spyOn(connection.db, 'transaction');
  const app = createWorker({
    db: connection.db,
    queue: { enqueue: async () => {} },
    security: { secret: 'test-worker-key', allowedIps: ['127.0.0.1'] },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/authorize',
      headers: { 'x-billing-key': 'test-worker-key' },
      payload: {
        tenant: 'ABC01',
        uuid: 'debf1234-1234-4234-8234-123456789abc',
        ...numbers,
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: '授权计费号码不一致' });
    expect(transaction).not.toHaveBeenCalled();
  } finally {
    transaction.mockRestore();
    await app.close();
    await connection.pool.end();
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
