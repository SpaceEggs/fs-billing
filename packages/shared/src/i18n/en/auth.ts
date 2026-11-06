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
    mobileTitle: {
      portal: 'Sign in to the customer portal',
      admin: 'Sign in to admin',
    },
    title: {
      portal: 'Sign in',
      admin: 'Sign in to admin',
    },
    subtitle: {
      portal: 'Use the email and password provided for your account',
      admin: 'Internal administrators only',
    },
    emailPlaceholder: {
      portal: 'name@company.com',
      admin: 'name@fs-billing.com',
    },
    forgotHint: {
      portal: 'Contact customer service to reset your password',
      admin:
        'Ask another administrator to reset your password on the Admins page',
    },
    expired: {
      title: 'Session expired. Sign in again',
      body: 'You will return to the previous page after signing in',
    },
    forgot: 'Forgot password?',
    email: 'Email',
    password: 'Password',
    passwordPlaceholder: 'Enter your password',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    show: 'Show',
    hide: 'Hide',
    submit: 'Sign in',
    adminFooter: 'Customers sign in through the customer portal',
  },
  logout: {
    failed: 'Sign-out failed. Check your connection and try again',
  },
  changePassword: {
    validation: {
      currentRequired: 'Enter your current password',
      tooShort: 'The new password must be at least 8 characters',
      tooLong: 'The new password must be at most 128 characters',
      mismatch: 'The new passwords do not match',
      wrongCurrent: 'Current password is incorrect',
    },
    showLabel: 'Show {{label}}',
    hideLabel: 'Hide {{label}}',
    show: 'Show',
    hide: 'Hide',
    formLabel: 'Change password',
    success: {
      title: 'Password changed',
      body: 'Sign-ins on other devices will be signed out',
    },
    locked: {
      title: 'Too many attempts. Temporarily locked',
      retry: 'Try again in {{duration}}',
    },
    unavailable: {
      title: 'Cannot change the password now',
      body: 'The service is temporarily unavailable. Try again later',
    },
    current: 'Current password',
    currentForcedHint: 'Temporary password from an administrator',
    next: 'New password',
    nextHint: 'At least 8 characters',
    confirm: 'Confirm new password',
    submit: 'Change password',
    title: {
      forced: 'Set a new password',
      normal: 'Change password',
    },
    description: {
      forced:
        'After the first sign-in or a password reset, set a new password to continue. Sign-ins on other devices will be signed out',
      normal: 'Sign-ins on other devices will be signed out',
    },
    back: 'Back',
  },
} as const;
