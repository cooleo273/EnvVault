import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, buildSecurityHeaders } from './security-headers';

const apiOrigin = 'https://api.example.com';

function headerKeys(isDevelopment: boolean): string[] {
  return buildSecurityHeaders({ apiOrigin, isDevelopment }).map((header) => header.key);
}

describe('security headers', () => {
  it('builds a strict production CSP', () => {
    const csp = buildContentSecurityPolicy({ apiOrigin, isDevelopment: false });
    expect(csp).toContain(`connect-src 'self' ${apiOrigin}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('allows eval and websockets only in development', () => {
    const csp = buildContentSecurityPolicy({ apiOrigin, isDevelopment: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain('ws:');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('sends HSTS only in production', () => {
    expect(headerKeys(false)).toContain('Strict-Transport-Security');
    expect(headerKeys(true)).not.toContain('Strict-Transport-Security');
    expect(headerKeys(true)).toEqual(
      expect.arrayContaining([
        'Content-Security-Policy',
        'X-Content-Type-Options',
        'X-Frame-Options',
      ]),
    );
  });
});
