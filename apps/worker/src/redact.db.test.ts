import type {} from '../../../packages/db/test/global-setup.js';
import { Writable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { expect, it } from 'vitest';
import { postgresErrorFields } from '@fs-billing/db';
import { connections } from '../../../packages/db/test/support.js';
import { createWorkerLogger } from './redact.js';

const { app } = connections();

it('a real failing drizzle query bound to phone numbers logs none of the digits', async () => {
  const callee = '8613800138000';
  const body = JSON.stringify({ callee: '8613900139000' });
  const error = await app.db
    .execute(sql`select ${callee}::text, ${body}::text from no_such_table_p9`)
    .then(
      () => undefined,
      (caught: unknown) => caught,
    );
  expect(error).toBeInstanceOf(DrizzleQueryError);
  // 前提：未脱敏时，号码确实在 message / stack / 自有属性里（否则这个测试什么也没证明）。
  const raw = error as DrizzleQueryError;
  expect(raw.message).toContain(callee);
  expect(raw.params).toContain(callee);

  let text = '';
  const logger = createWorkerLogger(
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        text += chunk.toString('utf8');
        callback();
      },
    }),
  );
  logger.error({ err: error, pg: postgresErrorFields(error) }, '话单入库失败');
  expect(text).not.toMatch(/8613800138000|8613900139000|params/);
  expect(text).toContain('DrizzleQueryError');
  expect(text).toContain('no_such_table_p9');
  // 结构化的 PostgreSQL 字段：未定义的表。
  expect(JSON.parse(text)).toMatchObject({ pg: { code: '42P01' } });
});
