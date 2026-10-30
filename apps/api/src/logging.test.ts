import { DrizzleQueryError } from 'drizzle-orm/errors';
import Fastify from 'fastify';
import { expect, test } from 'vitest';
import { createApiLogger } from './logging.js';

test('api logger masks phone numbers in the logged request url', async () => {
  const lines: string[] = [];
  // 与 app.ts 不同，这里不关闭请求日志：要验证的正是 Fastify 写出请求 URL 的那一行。
  const app = Fastify({
    loggerInstance: createApiLogger({ write: (line) => lines.push(line) }),
  });
  app.get('/api/admin/tenants/:id/cdrs', () => ({ ok: true }));
  try {
    await app.inject({
      method: 'GET',
      url: '/api/admin/tenants/t1/cdrs?callee=8613800138000&page=2&search=%2B447700900123',
      headers: { cookie: 'session=secret' },
    });
  } finally {
    await app.close();
  }
  const text = lines.join('');
  const request = lines
    .map((line) => JSON.parse(line) as { req?: { url?: string } })
    .find((entry) => entry.req?.url);
  expect(request?.req?.url).toBe(
    '/api/admin/tenants/t1/cdrs?callee=8613*******00(13)&page=2&search=+4477******23(12)',
  );
  expect(text).not.toMatch(/8613800138000|447700900123|13800138|7700900/);
  expect(text).not.toContain('session=secret');
});

test('api logger keeps a url without numbers as it is', () => {
  const lines: string[] = [];
  const logger = createApiLogger({ write: (line) => lines.push(line) });
  logger.info(
    { req: { method: 'GET', url: '/api/admin/cdrs?page=3&status=all' } },
    'incoming request',
  );
  const logged = JSON.parse(lines.join('')) as { req: { url: string } };
  expect(logged.req.url).toBe('/api/admin/cdrs?page=3&status=all');
});

test('api logger drops the bound parameters of a drizzle query error', () => {
  const lines: string[] = [];
  const logger = createApiLogger({ write: (line) => lines.push(line) });
  logger.error(
    {
      err: new DrizzleQueryError(
        'select 1 from cdrs where callee = $1',
        ['8613800138000'],
        Object.assign(
          new Error('canceling statement due to statement timeout'),
          {
            code: '57014',
          },
        ),
      ),
    },
    'API request failed',
  );
  const text = lines.join('');
  expect(text).toContain('DrizzleQueryError');
  expect(text).toContain('select 1 from cdrs where callee = $1');
  expect(text).not.toMatch(/8613800138000|params/);
});
