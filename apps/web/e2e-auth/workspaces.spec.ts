import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { TestAccount } from './support/helpers';

function sharedAccount(): TestAccount & { workspaceId: string } {
  return JSON.parse(readFileSync('e2e-auth/.auth/account.json', 'utf8')) as TestAccount & {
    workspaceId: string;
  };
}

// The app layout streams (loading.tsx), so Next.js answers 200 and renders
// the not-found UI in the stream; assert what the user actually sees.
async function expectNotFound(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
}

async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.goto('/workspaces/new');
  await page.getByText('Team', { exact: true }).click();
  await page.getByLabel('Workspace name').fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  // Generous: `next dev` may compile the workspace route on first use.
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return /\/workspaces\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
}

test.describe('workspaces (live, authorized by the API)', () => {
  test('restores the remembered workspace on the dashboard and switches between workspaces', async ({
    page,
  }) => {
    const { workspaceId } = sharedAccount();
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Shared Workspace' })).toBeVisible();

    const name = `Second ${randomUUID().slice(0, 6)}`;
    const second = await createWorkspace(page, name);
    // Creating a workspace selects it.
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

    // Switch back through the header switcher; the choice is remembered server-side.
    await page.getByRole('button', { name: /Switch workspace/ }).click();
    await page.getByRole('menuitem', { name: 'Shared Workspace' }).click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}$`));
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Shared Workspace' })).toBeVisible();
    expect(second).not.toBe(workspaceId);
  });

  test('generates a slug, edits settings, archives and restores', async ({ page }) => {
    const name = `Settings ${randomUUID().slice(0, 6)}`;
    const id = await createWorkspace(page, name);
    await expect(page.getByText(name.toLowerCase().replace(' ', '-'))).toBeVisible();

    await page.goto(`/workspaces/${id}/settings`);
    await page.getByRole('textbox', { name: /^Name/ }).fill(`${name} Renamed`);
    await page.getByLabel('Description').fill('Payments team');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Workspace settings saved.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: `${name} Renamed` })).toBeVisible();

    await page.getByRole('button', { name: 'Archive workspace' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('This workspace is archived and read-only.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Name/ })).toBeDisabled();
    // Hidden from the switcher, listed under Archived.
    await page.goto('/workspaces');
    await expect(page.getByRole('region', { name: 'Archived', exact: true })).toContainText(
      `${name} Renamed`,
    );

    await page.goto(`/workspaces/${id}/settings`);
    await page.getByRole('button', { name: 'Restore workspace' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('This workspace is archived and read-only.')).toBeHidden();
    await expect(page.getByRole('textbox', { name: /^Name/ })).toBeEnabled();
  });

  test('deletes a workspace only after typed confirmation and password re-verification', async ({
    page,
  }) => {
    const name = `Delete ${randomUUID().slice(0, 6)}`;
    const id = await createWorkspace(page, name);
    const slug =
      (await page
        .getByText(/^delete-/)
        .first()
        .textContent()) ?? '';

    await page.goto(`/workspaces/${id}/settings`);
    await page.getByRole('button', { name: 'Delete workspace' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete workspace?' });
    await confirm.getByLabel(`Type ${slug} to confirm`).fill(slug);
    await confirm.getByLabel('Confirm your password').fill('not-my-password');
    await confirm.getByRole('button', { name: 'Delete workspace' }).click();
    await expect(confirm.getByRole('alert')).toHaveText('Incorrect password.');
    // The typed confirmation survives the failed attempt; the password does not.
    await expect(confirm.getByLabel(`Type ${slug} to confirm`)).toHaveValue(slug);
    await expect(confirm.getByLabel('Confirm your password')).toHaveValue('');

    await confirm.getByLabel('Confirm your password').fill(sharedAccount().password);
    await confirm.getByRole('button', { name: 'Delete workspace' }).click();
    await expect(page).toHaveURL(/\/workspaces\?deleted=1$/);
    await expectNotFound(page, `/workspaces/${id}`);
  });

  test('cannot open a workspace it does not belong to', async ({ page }) => {
    for (const path of ['', '/members', '/invitations', '/settings']) {
      await expectNotFound(page, `/workspaces/${randomUUID()}${path}`);
    }
  });
});
