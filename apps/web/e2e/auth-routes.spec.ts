import { expect, test } from '@playwright/test';

// Production build, anonymous visitor. No Neon Auth backend is reachable.
const PROTECTED = [
  '/dashboard',
  '/onboarding',
  '/workspaces',
  '/workspaces/new',
  '/workspaces/0190f5a2-0000-7000-8000-000000000000',
  '/workspaces/0190f5a2-0000-7000-8000-000000000000/members',
  '/workspaces/0190f5a2-0000-7000-8000-000000000000/invitations',
  '/workspaces/0190f5a2-0000-7000-8000-000000000000/settings',
  '/projects',
  '/members',
  '/audit-logs',
  '/integrations',
  '/notifications',
  '/settings/profile',
  '/settings/security',
];

test.describe('route protection (signed out)', () => {
  for (const path of PROTECTED) {
    test(`redirects ${path} to sign-in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?redirectTo=${encodeURIComponent(path)}$`));
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    });
  }

  test('ignores forged session cookies', async ({ request }) => {
    const response = await request.get('/settings/security', {
      maxRedirects: 0,
      headers: {
        cookie: [
          '__Secure-neon-auth.session_token=forged.session.token',
          '__Secure-neon-auth.local.session_data=eyJ1c2VyIjp7ImlkIjoiYXR0YWNrZXIifX0.forged',
        ].join('; '),
      },
    });
    expect(response.status()).toBeGreaterThanOrEqual(300);
    expect(response.status()).toBeLessThan(400);
    expect(response.headers().location).toContain('/login');
  });
});

test.describe('auth pages (signed out)', () => {
  for (const [path, heading] of [
    ['/login', 'Sign in'],
    ['/signup', 'Create your account'],
    ['/forgot-password', 'Reset your password'],
    ['/invite', 'Workspace invitation'],
  ] as const) {
    test(`renders ${path}`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
    });
  }

  test('redirects legacy /auth/* URLs permanently, keeping the query', async ({ request }) => {
    const response = await request.get('/auth/reset-password?token=abc', { maxRedirects: 0 });
    expect([301, 308]).toContain(response.status());
    expect(response.headers().location).toBe('/reset-password?token=abc');
  });

  test('auth pages send security headers and are not cached', async ({ request }) => {
    const response = await request.get('/login');
    const headers = response.headers();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['cache-control']).not.toContain('public');
  });
});
