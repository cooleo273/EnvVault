import { expect, test } from '@playwright/test';

test.describe('API reference', () => {
  test('lists, searches, filters and deep links endpoints from the live API', async ({ page }) => {
    await page.goto('/developers/api');
    await expect(page.getByRole('heading', { level: 1, name: 'API reference' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Endpoints' });
    await nav.getByRole('searchbox', { name: 'Search endpoints' }).fill('runtime');
    await expect(nav.getByText(/^\d+ of \d+ endpoints$/)).toBeVisible();
    await nav.getByRole('button', { name: /Values for the calling process/ }).click();
    const detail = page.getByRole('article');
    await expect(detail.getByText('/machine/environments/{environmentId}/runtime')).toBeVisible();
    await expect(detail.getByText('secret:runtime', { exact: true })).toBeVisible();
    await expect(detail.getByText('Machines', { exact: true })).toBeVisible();
    await detail.getByRole('tab', { name: 'Python' }).click();
    await expect(detail.getByRole('tabpanel')).toContainText('get_runtime_config');
    await expect(page).toHaveURL(/#postMachineEnvironmentsRuntime$/);

    await nav.getByRole('searchbox', { name: 'Search endpoints' }).fill('');
    await nav.getByRole('combobox', { name: 'Who can call it' }).selectOption('cli');
    await expect(nav.getByRole('button', { name: /Create a workspace/i })).toHaveCount(0);

    await page.goto('/developers/api#getMachineIdentity');
    await expect(
      page.getByRole('article').getByText('/machine/identity', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Error codes' })).toBeVisible();
    await expect(page.getByText('MACHINE_TOKEN_REQUIRED')).toBeVisible();
    // Read only: no request console, no token field.
    await expect(
      page.getByRole('textbox', { name: /token|credential|authorization/i }),
    ).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 800 } });

    test('stacks the endpoint list above the detail without overflowing', async ({ page }) => {
      await page.goto('/developers/api');
      await expect(page.getByRole('navigation', { name: 'Endpoints' })).toBeVisible();
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(375);
    });
  });
});
