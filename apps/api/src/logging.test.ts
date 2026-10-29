import { DrizzleQueryError } from 'drizzle-orm/errors';
import { expect, test } from 'vitest';
import { createApiLogger } from './logging.js';

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
