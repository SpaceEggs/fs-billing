import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  apiContract,
  type ApiOperationId,
  type RouteAccess,
} from '@fs-billing/shared';
import type { Db } from '@fs-billing/db';
import type { AuthGateway } from '../auth/gateway.js';
import { resolvePrincipal } from '../identity.js';
import { ApiFailure } from '../errors.js';
import type { RequestContext } from '../types.js';

export type RouteHandler = (
  context: RequestContext,
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;
export type RouteHandlers = { [Id in ApiOperationId]: RouteHandler };
export function requestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value))
      for (const item of value) headers.append(key, item);
  }
  return headers;
}
async function authorize(
  access: RouteAccess,
  headers: Headers,
  deps: { businessDb: Db; auth: AuthGateway },
): Promise<RequestContext> {
  if (access === 'public') return { kind: 'public' };
  const session = await deps.auth.session(headers);
  if (access === 'session') return { kind: 'session', session };
  const resolved = await resolvePrincipal(deps.businessDb, session);
  if ((access === 'admin' || access === 'customer') && access !== resolved.kind)
    throw new ApiFailure('FORBIDDEN');
  return { ...resolved, session };
}
export function registerRoutes(
  app: FastifyInstance,
  deps: {
    businessDb: Db;
    auth: AuthGateway;
    trustedOrigins: readonly string[];
    rateLimit: { max: number; timeWindow: number };
  },
  handlers: RouteHandlers,
) {
  const router = app;
  const credentialRateLimit = app.rateLimit(deps.rateLimit);
  for (const operation of Object.values(apiContract)) {
    const credential =
      operation.operationId === 'login' ||
      operation.operationId === 'changePassword';
    router.route({
      method: operation.method,
      url: operation.path.replaceAll(/\{([^}]+)\}/g, ':$1'),
      schema: {
        operationId: operation.operationId,
        'x-access': operation.access,
        'x-isolation-case': operation.isolationCase,
        params: operation.request.params,
        querystring: operation.request.query,
        ...(operation.request.body.isOptional()
          ? {}
          : { body: operation.request.body }),
        response: operation.responses,
      },
      config: { rateLimit: false },
      ...(credential ? { onRequest: credentialRateLimit } : {}),
      preValidation: (request, _reply, done) => {
        if (operation.method === 'POST') {
          const origin = request.headers.origin;
          const fetchSite = request.headers['sec-fetch-site'];
          if (
            (origin !== undefined && !deps.trustedOrigins.includes(origin)) ||
            (origin === undefined &&
              (fetchSite === 'cross-site' || fetchSite === 'same-site'))
          )
            return done(new ApiFailure('FORBIDDEN'));
        }
        const body = operation.request.body.safeParse(request.body);
        if (!body.success)
          return done(
            new ApiFailure(
              'VALIDATION_ERROR',
              undefined,
              body.error.issues.map((issue) => ({
                path: issue.path.map((part) =>
                  typeof part === 'number' ? part : String(part),
                ),
                message: '请求字段格式错误',
              })),
            ),
          );
        done();
      },
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        // Logout validates its own session so expired cookies can still be cleared.
        const context =
          operation.operationId === 'logout'
            ? { kind: 'public' as const }
            : await authorize(operation.access, requestHeaders(request), deps);
        return handlers[operation.operationId](context, request, reply);
      },
    });
  }
}
