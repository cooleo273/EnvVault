export interface SecurityHeaderOptions {
  apiOrigin: string;
  isDevelopment: boolean;
}

/**
 * Baseline Content-Security-Policy. Next.js injects inline bootstrap scripts,
 * so 'unsafe-inline' is required until a nonce-based CSP (via proxy) is
 * introduced together with authenticated pages. 'unsafe-eval' is only allowed
 * in development for React Refresh.
 */
export function buildContentSecurityPolicy({ apiOrigin, isDevelopment }: SecurityHeaderOptions) {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(isDevelopment ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", apiOrigin, ...(isDevelopment ? ['ws:'] : [])],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  const policy = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
  return isDevelopment ? policy : `${policy}; upgrade-insecure-requests`;
}

export function buildSecurityHeaders(options: SecurityHeaderOptions) {
  return [
    { key: 'Content-Security-Policy', value: buildContentSecurityPolicy(options) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ...(options.isDevelopment
      ? []
      : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
  ];
}
