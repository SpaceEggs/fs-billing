import { Writable } from 'node:stream';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { connect } from '@fs-billing/db';
import { pino } from 'pino';
import { INVALID_NUMBER_REASON, modJsonCdrSchema } from '@fs-billing/shared';
import { expect, test, vi } from 'vitest';
import { createWorker } from './app.js';
import { invalidCdrIdentitySchema } from './invalid-cdr.js';
import { createWorkerLogger } from './redact.js';

test('invalid CDR retains the original dialed number for display', () => {
  const identity = invalidCdrIdentitySchema.parse({
    variables: {
      destination_number: 'billing-bridge',
      billing_dialed_number: '+447700900123',
      billing_number: 123,
    },
  });
  expect(identity.variables.destination_number).toBe('+447700900123');
});

test('old-format CDR is rejected even when its destination is a valid international number', () => {
  const result = modJsonCdrSchema.safeParse({
    variables: {
      uuid: 'debf1234-1234-4234-8234-123456789abc',
      destination_number: '447700900123',
      start_epoch: 1791770400,
      answer_epoch: 1791770409,
      end_epoch: 1791770599,
      billsec: 190,
      duration: 199,
    },
  });
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Old-format CDR was accepted');
  expect(result.error.issues).toMatchObject([
    { path: ['variables', 'billing_dialed_number'], code: 'invalid_type' },
  ]);
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

test('startup pool errors and worker logs share the supplied pino logger', async () => {
  const lines: string[] = [];
  const logger = pino({}, { write: (line) => lines.push(line) });
  const connection = connect(
    'postgres://user:private-password@localhost/billing',
    {
      poolName: 'worker.queue',
      logger,
    },
  );
  await Promise.resolve();
  expect(() =>
    connection.pool.emit(
      'error',
      Object.assign(
        new Error('postgres://user:private-password@localhost/billing'),
        {
          code: 'ETIMEDOUT',
        },
      ),
    ),
  ).not.toThrow();
  const app = createWorker({
    loggerInstance: logger,
    db: connection.db,
    queue: { enqueue: async () => {} },
    security: { secret: 'test-worker-key', allowedIps: ['127.0.0.1'] },
  });
  try {
    app.log.error({ event: 'application.error' }, 'Application error');
    const records = lines.map((line) => {
      const record: unknown = JSON.parse(line);
      return record;
    });
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toMatchObject({
        level: 50,
        pid: process.pid,
      });
      expect(record).toHaveProperty('time', expect.any(Number));
      expect(record).toHaveProperty('hostname', expect.any(String));
    }
    expect(records[0]).toMatchObject({
      event: 'database.idle_client_error',
      pool: 'worker.queue',
      code: 'ETIMEDOUT',
    });
    expect(lines.join('')).not.toContain('private-password');
    expect(lines.join('')).not.toContain('postgres://');
  } finally {
    await app.close();
    await connection.pool.end();
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
  { numbers: { callee: '447700900123' }, sipCode: 484 },
  {
    numbers: { callee: '447700900123', billingNumber: '447700900123' },
    sipCode: 484,
  },
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
        reason: INVALID_NUMBER_REASON,
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
    expect(response.statusCode).toBe(400);
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
      dialedNumber: '+447700900123',
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

async function authorizeLogs(numbers: Record<string, string>) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      callback();
    },
  });
  const connection = connect('postgresql://localhost/unused');
  const transaction = vi
    .spyOn(connection.db, 'transaction')
    .mockRejectedValue(new Error('database unavailable'));
  const app = createWorker({
    loggerInstance: createWorkerLogger(stream),
    db: connection.db,
    queue: { enqueue: async () => {} },
    security: { secret: 'test-worker-key', allowedIps: ['127.0.0.1'] },
  });
  try {
    await app.inject({
      method: 'POST',
      url: '/authorize',
      headers: { 'x-billing-key': 'test-worker-key' },
      payload: {
        tenant: 'abc01',
        uuid: 'debf1234-1234-4234-8234-123456789abc',
        ...numbers,
      },
    });
    return lines;
  } finally {
    transaction.mockRestore();
    await app.close();
    await connection.pool.end();
  }
}

test('the mismatch log masks every number and keeps the comparison fields', async () => {
  const lines = await authorizeLogs({
    callee: '13800138000',
    dialedNumber: '13800138000',
    billingNumber: '13055551234',
  });
  const entry = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((item) => item.msg === '授权计费号码不一致');
  expect(entry).toMatchObject({
    uuid: 'debf1234-1234-4234-8234-123456789abc',
    tenant: 'ABC01',
    dialedNumber: '1380*****00(11)',
    callee: '1380*****00(11)',
    luaBillingNumber: '1305*****34(11)',
    billingNumber: '8613*******00(13)',
    calleeEqualsWorker: false,
    luaEqualsWorker: false,
    reason: 'callee-differs',
    shapes: {
      dialedNumber: { length: 11, plus: false, doubleZero: false },
      billingNumber: { length: 13, plus: false, doubleZero: false },
    },
  });
  const text = lines.join('\n');
  for (const full of ['13800138000', '13055551234', '8613800138000'])
    expect(text).not.toContain(full);
});

test('a consistent request writes no mismatch log', async () => {
  const lines = await authorizeLogs({
    callee: '8613800138000',
    dialedNumber: '13800138000',
    billingNumber: '8613800138000',
  });
  const text = lines.join('\n');
  expect(text).not.toContain('授权计费号码不一致');
  // 一致的请求走到数据库（这里被替换成不可用），日志里也没有完整号码。
  expect(text).toContain('授权失败');
  expect(text).not.toContain('8613800138000');
});

test.each([
  { url: '/cdr', payload: '{}' },
  {
    url: '/authorize',
    payload: JSON.stringify({
      tenant: 'ABC01',
      callee: '8613800138000',
      dialedNumber: '13800138000',
      uuid: 'debf1234-1234-4234-8234-123456789abc',
    }),
  },
])(
  '$url failure logs never contain the bound phone numbers of a drizzle error',
  async ({ url, payload }) => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    });
    const connection = connect('postgresql://localhost/unused');
    const failure = new DrizzleQueryError(
      'select 1 from cdrs where callee = $1',
      ['8613800138000', '{"callee":"8613900139000"}'],
      Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
        detail: 'Failing row contains (8613800138000).',
      }),
    );
    const transaction = vi
      .spyOn(connection.db, 'transaction')
      .mockRejectedValue(failure);
    const app = createWorker({
      loggerInstance: createWorkerLogger(stream),
      db: connection.db,
      queue: { enqueue: async () => {} },
      security: { secret: 'test-worker-key', allowedIps: ['127.0.0.1'] },
    });
    try {
      await app.inject({
        method: 'POST',
        url,
        headers: {
          'x-billing-key': 'test-worker-key',
          'content-type': 'application/json',
        },
        payload,
      });
    } finally {
      transaction.mockRestore();
      await app.close();
      await connection.pool.end();
    }
    const text = lines.join('');
    expect(text).toContain('DrizzleQueryError');
    expect(text).toContain('"code":"57014"');
    expect(text).not.toMatch(/8613800138000|8613900139000|13800138000|params/);
  },
);
