import { expect, test } from 'vitest';
import { apiEnvironmentSchema } from './config.js';

const environment = {
  APP_DATABASE_URL: 'postgresql://fs_billing_app@localhost/db',
  AUTH_DATABASE_URL: 'postgresql://fs_billing_auth@localhost/db',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://localhost:3000',
};

test.each(['development', 'test', 'production'])(
  'credential rate limit override is absent by default in %s',
  (NODE_ENV) => {
    expect(
      apiEnvironmentSchema.parse({ ...environment, NODE_ENV })
        .AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX,
    ).toBeUndefined();
  },
);

test.each(['development', 'test'])(
  'credential rate limit override is parsed in %s',
  (NODE_ENV) => {
    expect(
      apiEnvironmentSchema.parse({
        ...environment,
        NODE_ENV,
        AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX: '10000',
      }).AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX,
    ).toBe(10000);
  },
);

test.each(['1', '30', '10000'])(
  'production rejects a credential rate limit override of %s at startup',
  (AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX) => {
    const result = apiEnvironmentSchema.safeParse({
      ...environment,
      NODE_ENV: 'production',
      AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected startup config rejection');
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        path: ['AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX'],
        message:
          'AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX is test-only and forbidden in production',
      }),
    ]);
  },
);

test.each(['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', 'invalid'])(
  'credential rate limit override rejects %j',
  (AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX) => {
    expect(() =>
      apiEnvironmentSchema.parse({
        ...environment,
        NODE_ENV: 'test',
        AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX,
      }),
    ).toThrow();
  },
);
