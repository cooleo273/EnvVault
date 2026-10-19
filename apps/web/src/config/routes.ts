/** Public authentication routes. */
export const AUTH_ROUTES = {
  login: '/login',
  signup: '/signup',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  verifyEmail: '/verify-email',
} as const;

/** Paths that must never be used as a post-login destination (loops, API). */
export const NON_REDIRECTABLE_PREFIXES = [
  ...Object.values(AUTH_ROUTES),
  '/auth/',
  '/api/',
] as const;
