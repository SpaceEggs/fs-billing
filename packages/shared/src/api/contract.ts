import { z } from 'zod';
import { healthResponseSchema } from '../health.js';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  resetPasswordParamsSchema,
  resetPasswordResponseSchema,
  sessionResponseSchema,
} from './auth.js';
import {
  adminContextResponseSchema,
  portalContextResponseSchema,
} from './context.js';
import { apiErrorSchemas } from './errors.js';

export type RouteAccess =
  'public' | 'session' | 'authenticated' | 'customer' | 'admin';
export type IsolationCase =
  | 'public'
  | 'tenant-read'
  | 'self-session'
  | 'self-credential'
  | 'self-session-mutation'
  | 'admin-only';

export type ApiOperation = {
  operationId: string;
  method: 'GET' | 'POST' | 'PUT';
  path: `/api/${string}`;
  access: RouteAccess;
  isolationCase: IsolationCase;
  request: { params: z.ZodType; query: z.ZodType; body: z.ZodType };
  responses: Readonly<Partial<Record<number, z.ZodType>>>;
};

export const emptyRequestSchema = z.strictObject({});
export const noContentResponseSchema = z.undefined();
const noInput = {
  params: emptyRequestSchema,
  query: emptyRequestSchema,
  body: emptyRequestSchema.optional(),
};
const commonErrors = {
  400: apiErrorSchemas.VALIDATION_ERROR,
  500: apiErrorSchemas.INTERNAL_ERROR,
  503: apiErrorSchemas.SERVICE_UNAVAILABLE,
};
const rateLimitedErrors = {
  ...commonErrors,
  429: apiErrorSchemas.RATE_LIMITED,
};
const identityErrors = z.union([
  apiErrorSchemas.ACCOUNT_DISABLED,
  apiErrorSchemas.IDENTITY_UNAVAILABLE,
  apiErrorSchemas.PASSWORD_CHANGE_REQUIRED,
]);
const sessionErrors = z.union([
  apiErrorSchemas.UNAUTHENTICATED,
  apiErrorSchemas.SESSION_EXPIRED,
]);
export const protectedErrors = {
  ...rateLimitedErrors,
  401: sessionErrors,
  403: z.union([apiErrorSchemas.FORBIDDEN, identityErrors]),
};
const credentialRateErrors = z.union([
  apiErrorSchemas.ACCOUNT_LOCKED,
  apiErrorSchemas.RATE_LIMITED,
]);
const resetOperation = {
  method: 'POST',
  access: 'admin',
  isolationCase: 'admin-only',
  request: { ...noInput, params: resetPasswordParamsSchema },
  responses: {
    ...protectedErrors,
    200: resetPasswordResponseSchema,
    404: apiErrorSchemas.NOT_FOUND,
  },
} as const;

export const apiContract = {
  health: {
    operationId: 'health',
    method: 'GET',
    path: '/api/health',
    access: 'public',
    isolationCase: 'public',
    request: noInput,
    responses: { ...commonErrors, 200: healthResponseSchema },
  },
  login: {
    operationId: 'login',
    method: 'POST',
    path: '/api/auth/login',
    access: 'public',
    isolationCase: 'public',
    request: { ...noInput, body: loginRequestSchema },
    responses: {
      ...rateLimitedErrors,
      200: sessionResponseSchema,
      401: apiErrorSchemas.INVALID_CREDENTIALS,
      403: z.union([apiErrorSchemas.FORBIDDEN, identityErrors]),
      429: credentialRateErrors,
    },
  },
  logout: {
    operationId: 'logout',
    method: 'POST',
    path: '/api/auth/logout',
    access: 'session',
    isolationCase: 'self-session-mutation',
    request: noInput,
    responses: {
      ...rateLimitedErrors,
      401: sessionErrors,
      403: apiErrorSchemas.FORBIDDEN,
      204: noContentResponseSchema,
    },
  },
  session: {
    operationId: 'session',
    method: 'GET',
    path: '/api/auth/session',
    access: 'authenticated',
    isolationCase: 'self-session',
    request: noInput,
    responses: { ...protectedErrors, 200: sessionResponseSchema },
  },
  changePassword: {
    operationId: 'changePassword',
    method: 'POST',
    path: '/api/auth/change-password',
    access: 'authenticated',
    isolationCase: 'self-credential',
    request: { ...noInput, body: changePasswordRequestSchema },
    responses: {
      ...protectedErrors,
      200: sessionResponseSchema,
      401: z.union([sessionErrors, apiErrorSchemas.INVALID_CREDENTIALS]),
      429: credentialRateErrors,
    },
  },
  revokeOtherSessions: {
    operationId: 'revokeOtherSessions',
    method: 'POST',
    path: '/api/auth/revoke-other-sessions',
    access: 'authenticated',
    isolationCase: 'self-session-mutation',
    request: noInput,
    responses: { ...protectedErrors, 204: noContentResponseSchema },
  },
  portalContext: {
    operationId: 'portalContext',
    method: 'GET',
    path: '/api/portal/context',
    access: 'customer',
    isolationCase: 'tenant-read',
    request: noInput,
    responses: { ...protectedErrors, 200: portalContextResponseSchema },
  },
  adminContext: {
    operationId: 'adminContext',
    method: 'GET',
    path: '/api/admin/context',
    access: 'admin',
    isolationCase: 'admin-only',
    request: noInput,
    responses: { ...protectedErrors, 200: adminContextResponseSchema },
  },
  resetPortalAccountPassword: {
    ...resetOperation,
    operationId: 'resetPortalAccountPassword',
    path: '/api/admin/portal-accounts/{id}/reset-password',
  },
  resetAdminPassword: {
    ...resetOperation,
    operationId: 'resetAdminPassword',
    path: '/api/admin/admins/{id}/reset-password',
  },
} as const satisfies Record<string, ApiOperation>;

export type ApiOperationId = keyof typeof apiContract;
