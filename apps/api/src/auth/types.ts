import type {
  ApiErrorCode,
  ChangePasswordRequest,
  LoginRequest,
} from '@fs-billing/shared';

export class GatewayError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'GatewayError';
  }
}

export interface AuthSession {
  authUserId: string;
  email: string;
  token: string;
  expiresAt: Date;
}
export interface IssuedSession extends AuthSession {
  setCookie: string[];
}
export interface AuthGateway {
  login(body: LoginRequest, headers: Headers): Promise<IssuedSession>;
  session(headers: Headers): Promise<AuthSession>;
  logout(headers: Headers): Promise<string[]>;
  changePassword(
    session: AuthSession,
    body: ChangePasswordRequest,
    headers: Headers,
  ): Promise<IssuedSession>;
  revokeOtherSessions(session: AuthSession): Promise<void>;
  resetPassword(input: {
    actorAuthUserId: string;
    targetAuthUserId: string;
  }): Promise<{ temporaryPassword: string }>;
  discardSession(token: string): Promise<void>;
  cleanupCounters(): Promise<number>;
}
export interface AuthLogger {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}
export interface AuthHooks {
  afterPasswordVerified?: () => Promise<void>;
  afterCredentialUpdated?: () => Promise<void>;
  beforeSessionDelete?: () => Promise<void>;
  afterLoginCreated?: () => Promise<void>;
}
