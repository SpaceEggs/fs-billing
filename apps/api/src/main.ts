import { APP_ROLE, AUTH_ROLE, connect } from '@fs-billing/db';
import { createApi } from './app.js';
import {
  apiEnvironmentSchema,
  apiRateLimitOptions,
  mailEnabled,
} from './config.js';
import { createAuthGateway } from './auth/gateway.js';
import { assertEffectiveAuthOptions } from './auth/better-auth.js';
import { createAdminAccountService } from './auth/admin-accounts.js';
import { createApiLogger } from './logging.js';

const config = apiEnvironmentSchema.parse(process.env);
const logger = createApiLogger();
const business = connect(config.APP_DATABASE_URL, {
  poolName: 'api.business',
  logger,
});
const { pool: authPool } = connect(config.AUTH_DATABASE_URL, {
  poolName: 'api.auth',
  logger,
});
const trustedOrigins = config.BETTER_AUTH_TRUSTED_ORIGINS ?? [
  new URL(config.BETTER_AUTH_URL).origin,
];
const auth = createAuthGateway({
  pool: authPool,
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  secureCookies: config.NODE_ENV === 'production',
  trustedOrigins,
  temporaryPasswordTtlMs: config.ADMIN_TEMPORARY_PASSWORD_TTL_MS,
  logger,
});
const app = createApi({
  businessDb: business.db,
  auth,
  accountService: createAdminAccountService({
    businessDb: business.db,
    auth: auth.auth,
    logger,
  }),
  adminAmountMaxIntegerDigits: config.ADMIN_AMOUNT_MAX_INTEGER_DIGITS,
  mailEnabled: mailEnabled(config),
  adminRates: {
    horizonMs: config.ADMIN_RATE_SCHEDULE_HORIZON_MS,
    previewTtlMs: config.ADMIN_RATE_PREVIEW_TTL_MS,
    cancelClockSkewMarginSeconds:
      config.ADMIN_RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS,
  },
  loggerInstance: logger,
  trustedOrigins,
  ...apiRateLimitOptions(config),
});
const cleanup = setInterval(() => {
  void auth
    .cleanupCounters()
    .catch((error: unknown) =>
      app.log.error(
        { err: error, event: 'auth.counter_cleanup_failed' },
        'Auth counter cleanup failed',
      ),
    );
}, 60_000);
cleanup.unref();
app.addHook('onClose', async () => {
  clearInterval(cleanup);
  await Promise.all([business.pool.end(), authPool.end()]);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
try {
  await app.ready();
  await assertEffectiveAuthOptions(auth.auth);
  const [businessRole, authRole] = await Promise.all([
    business.pool.query<{ role: string }>('SELECT current_user AS role'),
    authPool.query<{ role: string }>('SELECT current_user AS role'),
  ]);
  if (
    businessRole.rows[0]?.role !== APP_ROLE ||
    authRole.rows[0]?.role !== AUTH_ROLE
  ) {
    throw new Error(
      'API runtime database roles must be fs_billing_app and fs_billing_auth',
    );
  }
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
