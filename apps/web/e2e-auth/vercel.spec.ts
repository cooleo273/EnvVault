import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { completeOnboarding, newAccount, signUpAndVerify } from './support/helpers';

// Synthetic values; the API talks to e2e/support/vercel-standin.mjs, never to Vercel.
const TOKEN = 'e2e-synthetic-vercel-token-000111222333';
const VALUE = 'synthetic-e2e-vercel-value-31c9';

async function confirmPasswordIfAsked(page: Page, password: string, expected: Locator) {
  const stepUp = page.getByRole('dialog', { name: 'Confirm your password' });
  await expect(stepUp.or(expected).first()).toBeVisible({ timeout: 30_000 });
  if (await stepUp.isVisible()) {
    await stepUp.getByLabel('Password').fill(password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
  }
  await expect(expected).toBeVisible({ timeout: 30_000 });
}

test.describe('Vercel integration', () => {
  test('connects, links, maps and synchronises after a preview', async ({ page }) => {
    test.setTimeout(240_000);
    const account = newAccount('vercel');
    await signUpAndVerify(page, account);
    const workspaceId = await completeOnboarding(page, 'Deploy Team');
    await page.goto(`/workspaces/${workspaceId}/projects/new`);
    await page.getByLabel('Project name').fill(`Site ${randomUUID().slice(0, 6)}`);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });
    const projectUrl = page.url().replace('?created=1', '');

    await page
      .getByRole('link', { name: /^Development/ })
      .first()
      .click();
    await expect(page.getByText('No variables yet')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Add variable' }).first().click();
    const add = page.getByRole('dialog', { name: 'Add variable' });
    await add.getByLabel(/^Name/).fill('API_TOKEN');
    await add.getByLabel(/^Value/).fill(VALUE);
    await add.getByRole('button', { name: 'Add variable' }).click();
    await expect(add).toBeHidden({ timeout: 30_000 });

    await page.goto(`${projectUrl}/integrations`);
    await page.getByRole('link', { name: /Vercel/ }).click();
    await expect(page.getByText('Vercel is not connected')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Connect Vercel' }).click();
    const connect = page.getByRole('dialog', { name: 'Connect Vercel' });
    await connect.getByLabel(/^Access token/).fill(TOKEN);
    await connect.getByLabel(/^Team id/).fill('team_e2e');
    await connect.getByRole('button', { name: 'Connect' }).click();
    const card = page.getByRole('article', { name: /Vercel connection/ });
    await confirmPasswordIfAsked(page, account.password, card);
    await expect(card.getByText('active', { exact: true })).toBeVisible();
    // The token is never shown again.
    expect(await page.content()).not.toContain(TOKEN);

    await card.getByRole('button', { name: 'Search' }).click();
    await card
      .getByRole('list', { name: 'Vercel projects' })
      .getByRole('button', { name: 'Link' })
      .click();
    await confirmPasswordIfAsked(page, account.password, card.getByText(/project e2e-web/));

    const mappingForm = card.getByRole('form', { name: 'Add a mapping' });
    await mappingForm.getByRole('button', { name: 'Add mapping' }).click();
    const mappings = card.getByRole('list', { name: 'Environment mappings' });
    await confirmPasswordIfAsked(
      page,
      account.password,
      mappings.getByText(/Development → Vercel Preview/),
    );

    await mappings.getByRole('button', { name: 'Preview sync' }).click();
    const dialog = page.getByRole('dialog', { name: 'Synchronise to Vercel' });
    await expect(dialog.getByRole('list', { name: 'Planned changes' })).toContainText('API_TOKEN', {
      timeout: 30_000,
    });
    await expect(dialog).not.toContainText(VALUE);
    await dialog.getByRole('button', { name: 'Write 1 changes to Vercel' }).click();
    const result = page.getByTestId('sync-result');
    await confirmPasswordIfAsked(page, account.password, result);
    await expect(result).toContainText('succeeded');
    await expect(result).toContainText('Redeploy in Vercel');
    expect(await page.content()).not.toContain(VALUE);

    await page.setViewportSize({ width: 375, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
  });
});
