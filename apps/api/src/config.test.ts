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

test.each(['1', '30', '10000'])(
  'credential rate limit override is parsed with explicit test opt-in: %s',
  (AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX) => {
    expect(
      apiEnvironmentSchema.parse({
        ...environment,
        NODE_ENV: 'test',
        FSB_ALLOW_TEST_OVERRIDES: '1',
        AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX,
      }).AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX,
    ).toBe(Number(AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX));
  },
);

test.each([undefined, 'development', 'production'])(
  'rejects a credential rate limit override at startup when NODE_ENV is %j',
  (NODE_ENV) => {
    const result = apiEnvironmentSchema.safeParse({
      ...environment,
      NODE_ENV,
      FSB_ALLOW_TEST_OVERRIDES: '1',
      AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX: '10000',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected startup config rejection');
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        path: ['AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX'],
        message:
          'AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX requires explicit NODE_ENV=test and FSB_ALLOW_TEST_OVERRIDES=1',
      }),
    ]);
  },
);

test.each([undefined, '', '0', 'true', 'yes', ' 1', '1 '])(
  'test mode rejects a credential rate limit override without exact opt-in: %j',
  (FSB_ALLOW_TEST_OVERRIDES) => {
    expect(() =>
      apiEnvironmentSchema.parse({
        ...environment,
        NODE_ENV: 'test',
        FSB_ALLOW_TEST_OVERRIDES,
        AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX: '10000',
      }),
    ).toThrow(
      'AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX requires explicit NODE_ENV=test and FSB_ALLOW_TEST_OVERRIDES=1',
    );
  },
);

test.each([undefined, '', '0', 'true', '1'])(
  'opt-in flag alone does not enable an override: %j',
  (FSB_ALLOW_TEST_OVERRIDES) => {
    expect(
      apiEnvironmentSchema.parse({ ...environment, FSB_ALLOW_TEST_OVERRIDES })
        .AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX,
    ).toBeUndefined();
  },
);

test.each([
  '',
  ' ',
  '0',
  '-1',
  '+1',
  '1.5',
  '0x10',
  '1e3',
  ' 30',
  '30 ',
  '\t30',
  '30\n',
  'NaN',
  'Infinity',
  'invalid',
  '9007199254740992',
  30,
])(
  'credential rate limit override rejects %j',
  (AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX) => {
    expect(() =>
      apiEnvironmentSchema.parse({
        ...environment,
        NODE_ENV: 'test',
        FSB_ALLOW_TEST_OVERRIDES: '1',
        AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX,
      }),
    ).toThrow();
  },
);
