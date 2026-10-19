import { describe, expect, it } from 'vitest';
import { DEFAULT_AFTER_SIGN_IN, safeRedirectPath } from './redirect';

describe('safeRedirectPath (open-redirect protection)', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/workspaces/abc?tab=members#danger', '/workspaces/abc?tab=members#danger'],
    ['/settings', '/settings'],
    ['/invite', '/invite'],
    // Only exact auth routes are excluded, not paths that merely start alike.
    ['/login-history', '/login-history'],
    // Percent-encoded CR/LF stays encoded in the Location header: no header injection.
    ['/%0d%0aSet-Cookie:x', '/%0d%0aSet-Cookie:x'],
  ])('keeps same-origin path %s', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });

  it.each([
    'https://evil.example/phish',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/dash\\board',
    'javascript:alert(1)',
    '/dashboard\n',
    'dashboard',
    '',
    '/login',
    '/login?redirectTo=/x',
    '/signup',
    '/verify-email',
    '/forgot-password',
    '/reset-password?token=abc',
    '/auth/sign-in',
    '/api/auth/sign-out',
    `/${'a'.repeat(3000)}`,
    undefined,
    42,
  ])('falls back for %j', (input) => {
    expect(safeRedirectPath(input)).toBe(DEFAULT_AFTER_SIGN_IN);
  });
});
