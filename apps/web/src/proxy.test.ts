import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const middleware = vi.hoisted(() => vi.fn<(request: NextRequest) => Promise<NextResponse>>());

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/server', () => ({
  getAuth: () => ({ middleware: () => middleware }),
}));

const { default: proxy, config } = await import('./proxy');

describe('proxy (route protection)', () => {
  it('remembers the requested page when Neon Auth redirects to sign-in', async () => {
    middleware.mockResolvedValue(NextResponse.redirect('http://localhost:3000/login'));
    const response = await proxy(new NextRequest('http://localhost:3000/workspaces/abc?tab=x'));
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('redirectTo')).toBe('/workspaces/abc?tab=x');
  });

  it('passes authenticated requests through untouched', async () => {
    const next = NextResponse.next();
    middleware.mockResolvedValue(next);
    await expect(proxy(new NextRequest('http://localhost:3000/dashboard'))).resolves.toBe(next);
  });

  it('protects every application area and leaves auth and landing pages public', () => {
    const matchers = config.matcher.join(' ');
    for (const area of [
      'dashboard',
      'workspaces',
      'projects',
      'members',
      'audit-logs',
      'integrations',
      'notifications',
      'settings',
    ]) {
      expect(matchers).toContain(`/${area}/:path*`);
    }
    expect(matchers).not.toMatch(/\/auth\b|\/api\b/);
  });
});
