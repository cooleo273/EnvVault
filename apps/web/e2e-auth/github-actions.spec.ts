import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { completeOnboarding, newAccount, signUpAndVerify } from './support/helpers';

/** Waits for either the password confirmation or the expected result, confirming when asked. */
async function confirmPasswordIfAsked(page: Page, password: string, expected: Locator) {
  const stepUp = page.getByRole('dialog', { name: 'Confirm your password' });
  await expect(stepUp.or(expected).first()).toBeVisible({ timeout: 30_000 });
  if (await stepUp.isVisible()) {
    await stepUp.getByLabel('Password').fill(password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
  }
  await expect(expected).toBeVisible({ timeout: 30_000 });
}

test.describe('GitHub Actions integration', () => {
  test('binds a repository workflow to a machine identity and manages it', async ({ page }) => {
    test.setTimeout(240_000);
    const account = newAccount('github-actions');
    await signUpAndVerify(page, account);
    const workspaceId = await completeOnboarding(page, 'Delivery Team');
    await page.goto(`/workspaces/${workspaceId}/projects/new`);
    await page.getByLabel('Project name').fill(`Service ${randomUUID().slice(0, 6)}`);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });

    // An identity with a Development grant (its credential is not needed with OIDC).
    await page.getByRole('link', { name: 'Machine identities' }).click();
    await expect(page.getByText('No machine identities yet')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'New identity' }).first().click();
    const wizard = page.getByRole('dialog');
    await wizard.getByLabel(/^Name/).fill('GitHub deploy');
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByLabel('Access to Development').selectOption({ label: 'Runtime loader' });
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByRole('button', { name: 'Create identity' }).click();
    const reveal = page.getByTestId('credential-reveal');
    await confirmPasswordIfAsked(page, account.password, reveal);
    await reveal.getByLabel('I stored the credential somewhere safe').check();
    await reveal.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    await page.getByRole('link', { name: /GitHub Actions/ }).click();
    await expect(page.getByText('No trust bindings yet')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'New trust binding' }).click();
    const form = page.getByRole('dialog', { name: 'New trust binding' });
    await form.getByLabel(/^Name/).fill('Deploy from main');
    await form.getByLabel(/^Repository(?! id)/).fill('octo-org/app');
    await form.getByLabel(/^Repository id/).fill('123456789');
    await form.getByLabel(/^Owner id/).fill('987654');
    await form.getByLabel('Development').check();
    await form.getByRole('button', { name: 'Create binding' }).click();
    const bindings = page.getByRole('list', { name: 'Trust bindings' });
    await confirmPasswordIfAsked(page, account.password, bindings.getByText('Deploy from main'));
    await expect(bindings.getByText('active', { exact: true })).toBeVisible();
    await expect(bindings.getByText('octo-org/app (id 123456789)')).toBeVisible();
    await expect(bindings.getByText('push, workflow_dispatch')).toBeVisible();

    await bindings.getByRole('button', { name: 'Workflow example' }).click();
    const example = page.getByTestId('workflow-example');
    await expect(example).toContainText('id-token: write');
    await expect(example).toContainText('branches: [main]');
    await expect(example).not.toContainText('evv_');
    await page.keyboard.press('Escape');

    await bindings.getByRole('button', { name: 'Recent attempts' }).click();
    await expect(page.getByText('No attempts yet.')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');

    await bindings.getByRole('button', { name: 'Disable' }).click();
    await expect(bindings.getByText('disabled', { exact: true })).toBeVisible({ timeout: 30_000 });
    await bindings.getByRole('button', { name: 'Enable' }).click();
    await confirmPasswordIfAsked(
      page,
      account.password,
      bindings.getByText('active', { exact: true }),
    );

    // Fits a phone screen.
    await page.setViewportSize({ width: 375, height: 800 });
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
  });
});
