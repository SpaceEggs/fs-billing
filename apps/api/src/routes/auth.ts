import type { FastifyReply } from 'fastify';
import type { AuthSession } from '../auth/gateway.js';
import type { RequestContext } from '../types.js';
import { ApiFailure } from '../errors.js';

export function sessionContext(context: RequestContext) {
  if (context.kind === 'public') throw new ApiFailure('INTERNAL_ERROR');
  return context.session;
}
export function identityContext(context: RequestContext) {
  if (context.kind === 'public' || context.kind === 'session')
    throw new ApiFailure('INTERNAL_ERROR');
  return context;
}
export function sendCookies(reply: FastifyReply, cookies: readonly string[]) {
  if (cookies.length) reply.header('Set-Cookie', [...cookies]);
}
export function sessionResponse(
  context: ReturnType<typeof identityContext>,
  session: AuthSession,
) {
  return {
    identity: context.identity,
    expiresAt: session.expiresAt.toISOString(),
    passwordChangeRequired: session.passwordChangeRequired,
  };
}
