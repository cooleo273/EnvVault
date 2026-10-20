import { expect, type Page, test } from '@playwright/test';

const APP_ROUTES = [
  '/dashboard',
  '/workspaces',
  '/projects',
  '/members',
  '/audit-logs',
  '/integrations',
  '/notifications',
  '/settings/profile',
  '/settings/security',
  '/design-system',
];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // The dashboard's live status check runs server-side; nothing should log in the browser.
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test.describe('app shell', () => {
  for (const route of APP_ROUTES) {
    test(`${route} renders inside the shell without errors`, async ({ page }) => {
      const errors = collectErrors(page);
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await expect(page.getByRole('banner')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      expect(errors).toEqual([]);
    });
  }

  test('labels live and preview content distinctly', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(
      page.getByRole('region', { name: 'System status' }).getByText('Live'),
    ).toBeVisible();
    await page.goto('/integrations');
    await expect(page.getByText('Preview', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Not available yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add integration' })).toBeDisabled();
  });

  test('Team Members shows the active workspace members on its own page', async ({ page }) => {
    await page.goto('/dashboard');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: /Team Members/ }).click();
    await expect(page).toHaveURL(/\/members$/);
    await expect(nav.getByRole('link', { name: /Team Members/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Team Members' })).toBeVisible();
    await expect(
      page.getByRole('main').getByText('Shared Workspace', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('table', { name: 'Workspace members' })).toContainText('Owner');
  });

  test('marks the current page in the sidebar and navigates by keyboard', async ({ page }) => {
    await page.goto('/dashboard');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: /Overview/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await nav.getByRole('link', { name: /Projects/ }).focus();
    await page.keyboard.press('Enter');
    // The shortcut opens the active workspace's projects; the entry stays highlighted.
    await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}\/projects$/);
    await expect(nav.getByRole('link', { name: /Projects/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('offers a skip link to the main content', async ({ page }) => {
    await page.goto('/settings/profile');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await skip.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });

  test('opens global search with Ctrl+K and closes with Escape', async ({ page }) => {
    await page.goto('/dashboard');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('searchbox')).toBeFocused();
    await expect(dialog.getByText('Search is not connected yet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('switches theme and remembers the choice', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Change theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.goto('/settings');
    await page.getByText('Light', { exact: true }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });

  test('applies the table density preference', async ({ page }) => {
    await page.goto('/settings');
    await page.getByText('Compact', { exact: true }).click();
    await page.goto('/design-system');
    await expect(page.getByRole('region', { name: 'Example variables' })).toHaveAttribute(
      'data-density',
      'compact',
    );
  });

  test('sorts and paginates the example table', async ({ page }) => {
    await page.goto('/design-system');
    const table = page.getByRole('table', { name: 'Example variables' });
    await expect(table.getByRole('row')).toHaveCount(21);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(table.getByRole('rowheader').first()).toHaveText('EXAMPLE_VAR_021');
    await table.getByRole('button', { name: 'Key' }).click();
    await table.getByRole('button', { name: 'Key' }).click();
    await expect(table.getByRole('rowheader').first()).toHaveText('EXAMPLE_VAR_240');
  });
});

test.describe('app shell on mobile', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('uses a navigation drawer instead of the fixed sidebar', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('link', { name: /Settings/ }).click();
    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(drawer).toBeHidden();
  });

  test('closes the drawer with Escape', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
  });

  for (const route of APP_ROUTES) {
    test(`${route} has no horizontal overflow`, async ({ page }) => {
      await page.goto(route);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(375);
    });
  }
});
