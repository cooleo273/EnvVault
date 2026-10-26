import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { completeOnboarding, newAccount, signUpAndVerify } from './support/helpers';

async function createProject(page: Page, workspaceId: string, name: string): Promise<string> {
  await page.goto(`/workspaces/${workspaceId}/projects/new`);
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });
  return /\/projects\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
}

test.describe('machine identities', () => {
  test('creates an identity, grants an environment and shows its credential once', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // Its own account: password confirmations are rate limited per person, and the shared
    // account's budget belongs to the specs that use it.
    const account = newAccount('machines');
    await signUpAndVerify(page, account);
    const workspaceId = await completeOnboarding(page, 'Machine Team');
    const { password } = account;
    const projectId = await createProject(
      page,
      workspaceId,
      `Pipelines ${randomUUID().slice(0, 6)}`,
    );
    await page.getByRole('link', { name: 'Machine identities' }).click();
    // First visit compiles the route under next dev.
    await expect(page).toHaveURL(/\/machines$/, { timeout: 30_000 });
    await expect(page.getByText('No machine identities yet')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'New identity' }).first().click();
    const wizard = page.getByRole('dialog');
    await wizard.getByLabel(/^Name/).fill('GitHub Actions QA');
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByLabel('Access to Development').selectOption({ label: 'Runtime loader' });
    // Production stays without access: nothing is granted by default.
    await expect(wizard.getByLabel('Access to Production')).toHaveValue('');
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByRole('button', { name: 'Create identity' }).click();

    // Granting access asks for the password first.
    const stepUp = page.getByRole('dialog', { name: 'Confirm your password' });
    await stepUp.getByLabel('Password').fill(password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();

    const reveal = page.getByTestId('credential-reveal');
    await expect(reveal).toBeVisible({ timeout: 30_000 });
    const token = await reveal.getByRole('textbox', { name: 'Service credential' }).inputValue();
    expect(token).toMatch(/^evv_sk_[A-Za-z0-9]{16}_[A-Za-z0-9_-]{43}$/);
    const done = reveal.getByRole('button', { name: 'Done' });
    await expect(done).toBeDisabled();
    await reveal.getByLabel('I stored the credential somewhere safe').check();
    await done.click();

    await expect(page).toHaveURL(
      new RegExp(`/workspaces/${workspaceId}/projects/${projectId}/machines/[0-9a-f-]{36}$`),
    );
    const access = page.getByRole('region', { name: 'Environment access' });
    await expect(access.getByRole('cell', { name: 'Development' })).toBeVisible();
    await expect(
      access.getByText('Read environment metadata, List variable names, Load values at runtime'),
    ).toBeVisible();
    // The credential is never shown again, only its non secret start.
    await expect(page.getByText(token.slice(0, 15))).toBeVisible();
    expect(await page.content()).not.toContain(token);

    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('revoked', { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('link', { name: 'Machine identities', exact: true }).first().click();
    await expect(page.getByRole('link', { name: 'GitHub Actions QA' })).toBeVisible();
    await expect(page.getByText('Development: read, list, run')).toBeVisible();
  });
});
