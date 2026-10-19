import { NON_REDIRECTABLE_PREFIXES } from '@/config/routes';

export const DEFAULT_AFTER_SIGN_IN = '/dashboard';

/**
 * Returns `value` only if it is a same-origin absolute path; otherwise the
 * default. Prevents open redirects through `?redirectTo=` (e.g. `//evil.com`,
 * `https://evil.com`, `/\evil.com`, `javascript:`).
 */
export function safeRedirectPath(value: unknown, fallback = DEFAULT_AFTER_SIGN_IN): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  // Reject control characters and backslashes (some browsers normalise '\' to '/').
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\' || code < 0x20 || code === 0x7f) return fallback;
  }
  try {
    const parsed = new URL(value, 'https://envvault.invalid');
    if (parsed.origin !== 'https://envvault.invalid') return fallback;
    // Never bounce back into the auth flow.
    const path = parsed.pathname;
    if (
      NON_REDIRECTABLE_PREFIXES.some(
        (prefix) =>
          path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
      )
    )
      return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
