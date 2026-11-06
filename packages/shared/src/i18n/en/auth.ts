export const auth = {
  login: {
    invalidCredentials: {
      title: 'Incorrect email or password',
      body: 'Check your details and try again',
    },
    accountDisabled: {
      portalTitle: 'This account is disabled',
      adminTitle: 'This admin account is disabled',
      portalBody: 'Contact customer service to restore access',
      adminBody: 'Ask another administrator to enable it',
    },
    identityUnavailable: {
      title: 'This account is temporarily unavailable',
      portalBody: 'Contact customer service',
      adminBody: 'Contact another administrator',
    },
    locked: {
      title: 'Too many failed sign-in attempts. Temporarily locked',
    },
    rateLimited: {
      title: 'Too many requests',
    },
    retryAfter: 'Try again in {{duration}}',
    unavailable: {
      title: 'Unable to sign in right now',
      body: 'The service is temporarily unavailable. Try again later',
    },
  },
  logout: {
    failed: 'Sign-out failed. Check your connection and try again',
  },
} as const;
