import { expect, test } from '@playwright/test';

test.describe('landing page', () => {
  test('renders the main landmarks and heading', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      // The production CSP upgrades insecure requests; on this plain http test server an
      // upgraded prefetch cannot connect. Over https (every real deployment) it cannot happen.
      if (message.type() === 'error' && !message.text().includes('net::ERR_SSL_PROTOCOL_ERROR')) {
        errors.push(message.text());
      }
    });

    await page.goto('/');

    await expect(page).toHaveTitle(/EnvVault/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('exposes a keyboard-accessible skip link', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).toBeFocused();
    await skipLink.press('Enter');
    await expect(page).toHaveURL(/#main-content$/);
  });

  test('sends security headers', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-powered-by']).toBeUndefined();
  });

  test('has no horizontal overflow at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(375);
  });
});

test.describe('production build on a phone', () => {
  test.use({ viewport: { width: 375, height: 800 }, hasTouch: true, isMobile: true });

  // The signed in drawer test runs on next dev, where the dev tools badge can cover it.
  // This checks that the production build has no such overlay to intercept taps.
  test('renders no development overlay', async ({ page }) => {
    for (const path of ['/', '/login', '/signup']) {
      await page.goto(path);
      await expect(page.locator('nextjs-portal')).toHaveCount(0);
      await expect(page.locator('script[data-nextjs-dev-overlay]')).toHaveCount(0);
      const corner = await page.evaluate(() => document.elementFromPoint(24, 760)?.tagName ?? '');
      expect(corner.toLowerCase()).not.toBe('nextjs-portal');
    }
  });
});
