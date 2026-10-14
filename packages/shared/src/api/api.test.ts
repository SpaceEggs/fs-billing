import { describe, expect, it } from 'vitest';
import {
  adminContextResponseSchema,
  apiContract,
  apiErrorSchema,
  apiErrorSchemas,
  apiErrorStatus,
  changePasswordRequestSchema,
  healthResponseSchema,
  identitySchema,
  loginRequestSchema,
  moneySchema,
  newPasswordSchema,
  portalContextResponseSchema,
  resetPasswordResponseSchema,
  sessionResponseSchema,
} from '../index.js';
import type { ApiOperation } from '../index.js';

const profileId = '00000000-0000-4000-8000-000000000001';
const tenantId = '00000000-0000-4000-8000-000000000002';
const customer = {
  kind: 'customer',
  profileId,
  email: 'customer@example.com',
  tenant: { id: tenantId, code: 'tenantA', name: '租户 A', currency: 'CNY' },
};
const admin = {
  kind: 'admin',
  profileId,
  name: '管理员',
  email: 'admin@example.com',
};
const errorFields = { message: '请求失败', requestId: 'request-123' };
const invalidCredentials = {
  error: { code: 'INVALID_CREDENTIALS', ...errorFields },
};

describe('browser identity and context', () => {
  it('preserves each identity and forbids internal identifiers or mixed roles', () => {
    expect(identitySchema.parse(customer)).toEqual(customer);
    expect(identitySchema.parse(admin)).toEqual(admin);
    for (const identity of [customer, admin]) {
      expect(
        identitySchema.safeParse({ ...identity, authUserId: 'auth-secret' })
          .success,
      ).toBe(false);
    }
    expect(
      identitySchema.safeParse({ ...admin, tenant: customer.tenant }).success,
    ).toBe(false);
    expect(
      identitySchema.safeParse({ ...customer, kind: 'admin' }).success,
    ).toBe(false);
    expect(
      identitySchema.safeParse({ ...customer, profileId: 'not-a-uuid' })
        .success,
    ).toBe(false);
  });

  it('parses sessions without accepting session tokens or malformed expiry', () => {
    const session = {
      identity: customer,
      expiresAt: '2026-10-14T00:00:00.000Z',
    };
    expect(sessionResponseSchema.parse(session)).toEqual(session);
    expect(
      sessionResponseSchema.safeParse({ ...session, token: 'secret' }).success,
    ).toBe(false);
    expect(
      sessionResponseSchema.safeParse({ ...session, expiresAt: 'tomorrow' })
        .success,
    ).toBe(false);
  });

  it('keeps each context in its audience and checks the balance currency', () => {
    const portal = {
      identity: customer,
      balance: { currency: 'CNY', amount: '-35.20' },
    };
    expect(portalContextResponseSchema.parse(portal)).toEqual(portal);
    expect(adminContextResponseSchema.parse({ identity: admin })).toEqual({
      identity: admin,
    });
    expect(
      adminContextResponseSchema.safeParse({ identity: customer }).success,
    ).toBe(false);
    expect(
      portalContextResponseSchema.safeParse({ ...portal, identity: admin })
        .success,
    ).toBe(false);
    expect(
      portalContextResponseSchema.safeParse({
        ...portal,
        balance: { currency: 'USD', amount: '1' },
      }).success,
    ).toBe(false);
  });
});

describe('money formatting inputs', () => {
  it.each([
    '0',
    '0.00',
    '-0.01',
    '-35.20',
    '1.2345',
    '9007199254740993.123456789',
    '1'.repeat(128),
  ])('preserves decimal %s exactly', (amount) => {
    expect(moneySchema.parse({ currency: 'CNY', amount })).toEqual({
      currency: 'CNY',
      amount,
    });
    expect(moneySchema.parse({ currency: 'USD', amount })).toEqual({
      currency: 'USD',
      amount,
    });
  });

  it.each([
    35.2,
    '',
    ' 1.00',
    '1.00 ',
    '1\n',
    '1e3',
    'NaN',
    'Infinity',
    '+1',
    '-0',
    '-0.00',
    '-0.000',
    '1'.repeat(129),
    '01.00',
    '.5',
    '1.',
    '1,000.00',
  ])('rejects non-decimal input %j', (amount) => {
    expect(moneySchema.safeParse({ currency: 'CNY', amount }).success).toBe(
      false,
    );
  });

  it('rejects unsupported currencies and extra fields', () => {
    expect(
      moneySchema.safeParse({ currency: 'EUR', amount: '1.00' }).success,
    ).toBe(false);
    expect(
      moneySchema.safeParse({ currency: 'CNY', amount: '1.00', number: 1 })
        .success,
    ).toBe(false);
  });
});

describe('credential request boundaries', () => {
  it('accepts existing short passwords verbatim but rejects identity overrides', () => {
    const login = { email: 'user@example.com', password: ' x ' };
    expect(loginRequestSchema.parse(login)).toEqual(login);
    for (const field of [
      'tenantId',
      'tenant_id',
      'tenant',
      'role',
      'authUserId',
    ]) {
      expect(
        loginRequestSchema.safeParse({ ...login, [field]: 'override' }).success,
      ).toBe(false);
    }
    expect(
      loginRequestSchema.safeParse({ ...login, password: '' }).success,
    ).toBe(false);
    expect(
      loginRequestSchema.safeParse({ ...login, email: 'invalid' }).success,
    ).toBe(false);
  });

  it('enforces new-password limits without trimming and uses the same reset policy', () => {
    const request = { currentPassword: 'old', newPassword: ' 123456 ' };
    expect(changePasswordRequestSchema.parse(request)).toEqual(request);
    expect(newPasswordSchema.parse('x'.repeat(128))).toBe('x'.repeat(128));
    expect(
      resetPasswordResponseSchema.parse({ temporaryPassword: 'Temp1234!' }),
    ).toEqual({ temporaryPassword: 'Temp1234!' });
    for (const password of ['1234567', 'x'.repeat(129)]) {
      expect(newPasswordSchema.safeParse(password).success).toBe(false);
      expect(
        changePasswordRequestSchema.safeParse({
          ...request,
          newPassword: password,
        }).success,
      ).toBe(false);
      expect(
        resetPasswordResponseSchema.safeParse({ temporaryPassword: password })
          .success,
      ).toBe(false);
    }
    expect(
      changePasswordRequestSchema.safeParse({
        ...request,
        confirmPassword: request.newPassword,
      }).success,
    ).toBe(false);
  });
});

describe('API error envelope', () => {
  it.each(['UNAUTHENTICATED', 'SESSION_EXPIRED'])(
    'requires redirect action for %s',
    (code) => {
      const envelope = {
        error: { code, ...errorFields, action: 'reauthenticate' },
      };
      expect(apiErrorSchema.parse(envelope)).toEqual(envelope);
      expect(
        apiErrorSchema.safeParse({ error: { code, ...errorFields } }).success,
      ).toBe(false);
      expect(
        apiErrorSchema.safeParse({
          error: { ...envelope.error, action: 'redirect-anywhere' },
        }).success,
      ).toBe(false);
    },
  );

  it('does not treat credential failures or forbidden access as session expiry', () => {
    expect(apiErrorSchema.parse(invalidCredentials)).toEqual(
      invalidCredentials,
    );
    expect(
      apiErrorSchema.safeParse({
        error: { ...invalidCredentials.error, action: 'reauthenticate' },
      }).success,
    ).toBe(false);
    const forbidden = { error: { code: 'FORBIDDEN', ...errorFields } };
    expect(apiErrorSchemas.FORBIDDEN.parse(forbidden)).toEqual(forbidden);
    expect(apiErrorSchemas.UNAUTHENTICATED.safeParse(forbidden).success).toBe(
      false,
    );
  });

  it('requires a positive integer retry delay for locked accounts', () => {
    const envelope = {
      error: { code: 'ACCOUNT_LOCKED', ...errorFields, retryAfterSeconds: 900 },
    };
    expect(apiErrorSchema.parse(envelope)).toEqual(envelope);
    for (const retryAfterSeconds of [undefined, 0, -1, 1.5, '900']) {
      expect(
        apiErrorSchema.safeParse({
          error: { ...envelope.error, retryAfterSeconds },
        }).success,
      ).toBe(false);
    }
  });

  it('parses validation issues but refuses values, unknown codes and diagnostics', () => {
    const envelope = {
      error: {
        code: 'VALIDATION_ERROR',
        ...errorFields,
        issues: [
          {
            path: ['body', 'accounts', 0, 'password'],
            message: '密码不能为空',
          },
        ],
      },
    };
    expect(apiErrorSchema.parse(envelope)).toEqual(envelope);
    expect(
      apiErrorSchema.safeParse({ error: { ...envelope.error, issues: [] } })
        .success,
    ).toBe(false);
    expect(
      apiErrorSchema.safeParse({
        error: {
          ...envelope.error,
          issues: [{ ...envelope.error.issues[0], value: 'secret' }],
        },
      }).success,
    ).toBe(false);
    expect(
      apiErrorSchema.safeParse({ error: { ...errorFields, code: 'UNKNOWN' } })
        .success,
    ).toBe(false);
    expect(
      apiErrorSchema.safeParse({
        error: { ...invalidCredentials.error, stack: 'driver error' },
      }).success,
    ).toBe(false);
  });

  it('associates parsed errors with their documented HTTP status', () => {
    const examples = [
      ['UNAUTHENTICATED', 401, { action: 'reauthenticate' }],
      ['SESSION_EXPIRED', 401, { action: 'reauthenticate' }],
      ['INVALID_CREDENTIALS', 401, {}],
      ['FORBIDDEN', 403, {}],
      ['ACCOUNT_DISABLED', 403, {}],
      ['IDENTITY_UNAVAILABLE', 403, {}],
      ['ACCOUNT_LOCKED', 429, { retryAfterSeconds: 900 }],
      [
        'VALIDATION_ERROR',
        400,
        { issues: [{ path: [], message: '请求无效' }] },
      ],
      ['NOT_FOUND', 404, {}],
      ['RATE_LIMITED', 429, { retryAfterSeconds: 60 }],
      ['SERVICE_UNAVAILABLE', 503, {}],
      ['INTERNAL_ERROR', 500, {}],
    ] as const;
    for (const [code, status, extra] of examples) {
      const parsed = apiErrorSchema.parse({
        error: { code, ...errorFields, ...extra },
      });
      expect(apiErrorStatus[parsed.error.code]).toBe(status);
    }
  });
});

describe('operation registry', () => {
  const operations: readonly ApiOperation[] = Object.values(apiContract);

  it('defines exactly the approved routes, with unique paths and operation IDs', () => {
    expect(operations.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/health',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'GET /api/auth/session',
      'POST /api/auth/change-password',
      'POST /api/auth/revoke-other-sessions',
      'GET /api/portal/context',
      'GET /api/admin/context',
      'POST /api/admin/portal-accounts/{id}/reset-password',
      'POST /api/admin/admins/{id}/reset-password',
    ]);
    expect(
      new Set(operations.map(({ method, path }) => `${method} ${path}`)).size,
    ).toBe(operations.length);
    expect(new Set(operations.map(({ operationId }) => operationId)).size).toBe(
      operations.length,
    );
    for (const [key, operation] of Object.entries(apiContract))
      expect(operation.operationId).toBe(key);
  });

  it('classifies every customer-callable operation, including shared session mutations', () => {
    expect(
      operations
        .filter(
          ({ access }) =>
            access === 'customer' ||
            access === 'session' ||
            access === 'authenticated',
        )
        .map(({ operationId }) => operationId),
    ).toEqual([
      'logout',
      'session',
      'changePassword',
      'revokeOtherSessions',
      'portalContext',
    ]);
    expect(
      operations
        .filter(({ access }) => access === 'public')
        .map(({ operationId }) => operationId),
    ).toEqual(['health', 'login']);
    expect(
      operations
        .filter(({ isolationCase }) => isolationCase === 'admin-only')
        .map(({ operationId }) => operationId),
    ).toEqual([
      'adminContext',
      'resetPortalAccountPassword',
      'resetAdminPassword',
    ]);
  });

  it('uses executable request and success schemas through the package index', () => {
    expect(
      apiContract.health.responses[200].parse({ status: 'ok', service: 'api' }),
    ).toEqual(healthResponseSchema.parse({ status: 'ok', service: 'api' }));
    const login = { email: 'user@example.com', password: 'old' };
    expect(apiContract.login.request.body.parse(login)).toEqual(login);
    for (const operation of operations) {
      expect(operation.request.query.parse({})).toEqual({});
      expect(operation.request.query.safeParse({ tenantId }).success).toBe(
        false,
      );
    }
    for (const operation of [
      apiContract.resetPortalAccountPassword,
      apiContract.resetAdminPassword,
    ]) {
      expect(operation.request.params.parse({ id: profileId })).toEqual({
        id: profileId,
      });
      expect(
        operation.request.params.safeParse({ id: 'invalid' }).success,
      ).toBe(false);
      expect(
        operation.request.body.safeParse({
          role: 'admin',
          password: 'override',
        }).success,
      ).toBe(false);
      expect(
        operation.responses[200].parse({ temporaryPassword: 'Temp1234!' }),
      ).toEqual({ temporaryPassword: 'Temp1234!' });
    }
    for (const operation of [
      apiContract.logout,
      apiContract.revokeOtherSessions,
    ]) {
      expect(operation.responses[204].safeParse(undefined).success).toBe(true);
      expect(
        operation.responses[204].safeParse({ success: true }).success,
      ).toBe(false);
    }
  });

  it('accepts absent bodies or empty objects for bodyless POSTs', () => {
    for (const operation of [
      apiContract.logout,
      apiContract.revokeOtherSessions,
      apiContract.resetPortalAccountPassword,
      apiContract.resetAdminPassword,
    ]) {
      expect(operation.request.body.parse(undefined)).toBeUndefined();
      expect(operation.request.body.parse({})).toEqual({});
      for (const body of [null, '', { tenantId }]) {
        expect(operation.request.body.safeParse(body).success).toBe(false);
      }
    }
  });

  it('returns the new session after changing a password', () => {
    const session = { identity: admin, expiresAt: '2026-10-14T00:00:00.000Z' };
    expect(apiContract.changePassword.responses[200].parse(session)).toEqual(
      session,
    );
    expect(apiContract.changePassword.responses).not.toHaveProperty('204');
  });

  it('keeps logout available when a protected route rejects a disabled account', () => {
    const disabled = { error: { code: 'ACCOUNT_DISABLED', ...errorFields } };
    expect(apiContract.session.responses[403].parse(disabled)).toEqual(
      disabled,
    );
    expect(apiContract.portalContext.responses[403].parse(disabled)).toEqual(
      disabled,
    );
    expect(apiContract.logout.access).toBe('session');
    expect(apiContract.logout.responses[403].safeParse(disabled).success).toBe(
      false,
    );
    expect(apiContract.logout.responses[204].parse(undefined)).toBeUndefined();
    expect(apiContract.logout.responses[401].safeParse(disabled).success).toBe(
      false,
    );
  });

  it('permits forbidden origin errors on login and forbidden admin self-reset errors', () => {
    const forbidden = { error: { code: 'FORBIDDEN', ...errorFields } };
    expect(apiContract.login.responses[403].safeParse(forbidden).success).toBe(
      true,
    );
    expect(
      apiContract.resetAdminPassword.responses[403].parse(forbidden),
    ).toEqual(forbidden);
  });

  it('requires retry delays for per-IP credential limits', () => {
    for (const operation of [apiContract.login, apiContract.changePassword]) {
      const limited = {
        error: { code: 'RATE_LIMITED', ...errorFields, retryAfterSeconds: 60 },
      };
      expect(operation.responses[429].parse(limited)).toEqual(limited);
      for (const retryAfterSeconds of [undefined, 0, -1, 1.5]) {
        expect(
          operation.responses[429].safeParse({
            error: { ...limited.error, retryAfterSeconds },
          }).success,
        ).toBe(false);
      }
    }
  });

  it('excludes rate limits from health responses', () => {
    expect(apiContract.health.responses).not.toHaveProperty('429');
  });

  it('rejects unexpected health response fields', () => {
    expect(
      healthResponseSchema.safeParse({
        status: 'ok',
        service: 'api',
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('narrows route errors to the correct status and operation', () => {
    expect(apiContract.login.responses[401].parse(invalidCredentials)).toEqual(
      invalidCredentials,
    );
    expect(
      apiContract.changePassword.responses[401].parse(invalidCredentials),
    ).toEqual(invalidCredentials);
    expect(
      apiContract.session.responses[401].safeParse(invalidCredentials).success,
    ).toBe(false);
    const expired = {
      error: {
        code: 'SESSION_EXPIRED',
        ...errorFields,
        action: 'reauthenticate',
      },
    };
    expect(apiContract.session.responses[401].parse(expired)).toEqual(expired);
    expect(apiContract.login.responses[401].safeParse(expired).success).toBe(
      false,
    );
    for (const code of ['ACCOUNT_DISABLED', 'IDENTITY_UNAVAILABLE']) {
      const envelope = { error: { code, ...errorFields } };
      expect(apiContract.login.responses[403].parse(envelope)).toEqual(
        envelope,
      );
      expect(apiContract.login.responses[401].safeParse(envelope).success).toBe(
        false,
      );
    }
    const locked = {
      error: { code: 'ACCOUNT_LOCKED', ...errorFields, retryAfterSeconds: 900 },
    };
    expect(apiContract.login.responses[429].parse(locked)).toEqual(locked);
    expect(apiContract.changePassword.responses[429].parse(locked)).toEqual(
      locked,
    );
    expect(
      apiContract.portalContext.responses[429].safeParse(locked).success,
    ).toBe(false);
  });
});
