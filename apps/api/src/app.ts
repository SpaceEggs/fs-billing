import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import swagger from '@fastify/swagger';
import rateLimit from '@fastify/rate-limit';
import {
  validatorCompiler,
  serializerCompiler,
  jsonSchemaTransform,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  resetPasswordParamsSchema,
  adminApiErrorStatus,
  createAdminRateRequestSchemas,
  createAdminAmountRequestSchemas,
  portalLedgerQuerySchema,
} from '@fs-billing/shared';
import {
  AdminServiceError,
  NotFoundError,
  withTenant,
  listPortalLedger,
  connect,
  type PoolDb,
} from '@fs-billing/db';
import { GatewayError, type AuthGateway } from './auth/gateway.js';
import { ApiFailure, isTransientServiceError, sendFailure } from './errors.js';
import { recordLogin, resolvePrincipal } from './identity.js';
import {
  registerRoutes,
  requestHeaders,
  type RouteHandlers,
} from './routes/register.js';
import {
  identityContext,
  sessionContext,
  sendCookies,
  sessionResponse,
} from './routes/auth.js';
import { readPortalBalance } from './routes/portal.js';
import { tenantHandlers } from './routes/admin/tenants.js';
import { balanceHandlers } from './routes/admin/balance.js';
import { receivableHandlers } from './routes/admin/receivables.js';
import { rateHandlers } from './routes/admin/rates.js';
import { createLiveApiContract } from './routes/contract.js';
import { accountHandlers } from './routes/admin/accounts.js';
import type { AdminAccountService } from './auth/admin-accounts.js';
import { createApiLogger } from './logging.js';
import { cdrHandlers } from './routes/cdrs.js';
import { homeHandlers } from './routes/home.js';
import { exportHandlers } from './routes/exports.js';

export type ApiDependencies = {
  businessDb: PoolDb;
  auth: AuthGateway;
  logger?: boolean;
  loggerInstance?: FastifyBaseLogger;
  trustedOrigins?: readonly string[];
  rateLimit?: { max: number; timeWindow: number };
  adminRates?: {
    horizonMs?: number;
    previewTtlMs?: number;
    cancelClockSkewMarginSeconds?: number;
  };
  adminAmountMaxIntegerDigits?: number;
  accountService?: AdminAccountService;
  exportPoolApplicationName?: string;
};
export function createApi(deps: ApiDependencies) {
  const rateRequests = createAdminRateRequestSchemas(
    deps.adminRates?.horizonMs,
  );
  const amountRequests = createAdminAmountRequestSchemas(
    deps.adminAmountMaxIntegerDigits,
  );
  const contract = createLiveApiContract(rateRequests, amountRequests);
  const exportConnectionString =
    deps.businessDb.$client.options.connectionString;
  if (!exportConnectionString)
    throw new Error('API business pool must have a connection string');
  const exportConnection = connect(exportConnectionString, {
    max: 4,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: deps.exportPoolApplicationName ?? 'fsbilling-api-export',
    poolName: 'api.export',
  });
  const app = Fastify({
    trustProxy: false,
    exposeHeadRoutes: false,
    logController: new LogController({ disableRequestLogging: true }),
    ...(deps.loggerInstance || deps.logger
      ? { loggerInstance: deps.loggerInstance ?? createApiLogger() }
      : { logger: false }),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, request, reply) => {
    if (
      error instanceof Error &&
      'statusCode' in error &&
      error.statusCode === 413 &&
      (request.routeOptions.url === '/api/admin/tenants' ||
        request.routeOptions.url?.endsWith('/rates/import/preview'))
    )
      error = new AdminServiceError('CSV_LIMIT_EXCEEDED', 'CSV 文件超限');
    if (error instanceof AdminServiceError) {
      reply.header('Cache-Control', 'no-store');
      return reply.code(adminApiErrorStatus[error.code]).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.code === 'CSV_INVALID' ? { rows: error.rows } : {}),
          ...(error.code === 'VALIDATION_ERROR'
            ? { issues: [{ path: [], message: error.message }] }
            : {}),
        },
      });
    }
    if (error instanceof NotFoundError)
      return sendFailure(request, reply, new ApiFailure('NOT_FOUND'));
    if (error instanceof ApiFailure) return sendFailure(request, reply, error);
    if (error instanceof GatewayError) {
      sendCookies(reply, error.setCookie);
      return sendFailure(
        request,
        reply,
        new ApiFailure(error.code, error.retryAfterSeconds),
      );
    }
    if (
      hasZodFastifySchemaValidationErrors(error) ||
      (error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500)
    )
      return sendFailure(request, reply, new ApiFailure('VALIDATION_ERROR'));
    app.log.error({ err: error, requestId: request.id }, 'API request failed');
    return sendFailure(
      request,
      reply,
      new ApiFailure(
        isTransientServiceError(error)
          ? 'SERVICE_UNAVAILABLE'
          : 'INTERNAL_ERROR',
      ),
    );
  });
  app.setNotFoundHandler((request, reply) =>
    sendFailure(request, reply, new ApiFailure('NOT_FOUND')),
  );
  const handlers: RouteHandlers = {
    ...tenantHandlers(deps.businessDb, amountRequests),
    ...balanceHandlers(deps.businessDb, amountRequests),
    ...receivableHandlers(deps.businessDb),
    ...rateHandlers(deps.businessDb, { ...deps.adminRates, rateRequests }),
    ...accountHandlers(deps.accountService),
    ...cdrHandlers(deps.businessDb),
    ...homeHandlers(deps.businessDb),
    ...exportHandlers({
      auditDb: exportConnection.db,
      pool: exportConnection.pool,
    }),
    health: () => Promise.resolve({ status: 'ok', service: 'api' }),
    login: async (_context, request, reply) => {
      const session = await deps.auth.login(
        loginRequestSchema.parse(request.body),
        requestHeaders(request),
      );
      try {
        const resolved = await resolvePrincipal(deps.businessDb, session);
        await recordLogin(deps.businessDb, resolved.principal);
        sendCookies(reply, session.setCookie);
        return sessionResponse({ ...resolved, session }, session);
      } catch (error) {
        await deps.auth.discardSession(session.token);
        throw error;
      }
    },
    logout: async (_context, request, reply) => {
      sendCookies(reply, await deps.auth.logout(requestHeaders(request)));
      return reply.code(204).send();
    },
    session: (context) =>
      Promise.resolve(
        sessionResponse(identityContext(context), sessionContext(context)),
      ),
    changePassword: async (context, request, reply) => {
      const session = await deps.auth.changePassword(
        sessionContext(context),
        changePasswordRequestSchema.parse(request.body),
        requestHeaders(request),
      );
      try {
        const resolved = await resolvePrincipal(deps.businessDb, session);
        sendCookies(reply, session.setCookie);
        return sessionResponse({ ...resolved, session }, session);
      } catch (error) {
        await deps.auth.discardSession(session.token);
        throw error;
      }
    },
    revokeOtherSessions: async (context, _request, reply) => {
      await deps.auth.revokeOtherSessions(sessionContext(context));
      return reply.code(204).send();
    },
    portalLedger: (context, request) => {
      if (context.kind !== 'customer') throw new ApiFailure('INTERNAL_ERROR');
      return listPortalLedger({
        db: deps.businessDb,
        tenantId: context.principal.tenantId,
        query: portalLedgerQuerySchema.parse(request.query),
      });
    },
    portalContext: async (context) => {
      if (context.kind !== 'customer') throw new ApiFailure('INTERNAL_ERROR');
      const amount = await withTenant(
        deps.businessDb,
        context.principal.tenantId,
        (tx) => readPortalBalance(tx, context.principal),
      );
      return {
        identity: context.identity,
        balance: { currency: context.identity.tenant.currency, amount },
      };
    },
    adminContext: (context) => {
      if (context.kind !== 'admin') throw new ApiFailure('INTERNAL_ERROR');
      return Promise.resolve({ identity: context.identity });
    },
    resetPortalAccountPassword: async (context, request) => {
      if (context.kind !== 'admin') throw new ApiFailure('INTERNAL_ERROR');
      if (!deps.accountService) throw new ApiFailure('SERVICE_UNAVAILABLE');
      return deps.accountService.resetPassword(
        context.principal,
        'portal',
        resetPasswordParamsSchema.parse(request.params).id,
      );
    },
    resetAdminPassword: async (context, request) => {
      if (context.kind !== 'admin') throw new ApiFailure('INTERNAL_ERROR');
      if (!deps.accountService) throw new ApiFailure('SERVICE_UNAVAILABLE');
      return deps.accountService.resetPassword(
        context.principal,
        'admin',
        resetPasswordParamsSchema.parse(request.params).id,
      );
    },
  };
  void app.register(swagger, {
    openapi: { info: { title: 'fs-billing API', version: '4.0.0' } },
    transform: jsonSchemaTransform,
  });
  void app.register(rateLimit, {
    global: false,
    hook: 'onRequest',
    errorResponseBuilder: (_request, context) =>
      new ApiFailure(
        'RATE_LIMITED',
        Math.max(1, Math.ceil(context.ttl / 1000)),
      ),
  });
  void app.register((instance, _options, done) => {
    registerRoutes(
      instance,
      {
        ...deps,
        trustedOrigins: deps.trustedOrigins ?? ['http://localhost:3000'],
        rateLimit: deps.rateLimit ?? { max: 30, timeWindow: 60_000 },
      },
      handlers,
      contract,
    );
    done();
  });
  app.addHook('onClose', async () => exportConnection.pool.end());
  return app;
}
