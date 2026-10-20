import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { TestAccount } from './support/helpers';

function shared(): TestAccount & { workspaceId: string } {
  return JSON.parse(readFileSync('e2e-auth/.auth/account.json', 'utf8')) as TestAccount & {
    workspaceId: string;
  };
}

/** Creates a project through the UI with the default template selection. */
async function createProject(page: Page, name: string): Promise<string> {
  const { workspaceId } = shared();
  await page.goto(`/workspaces/${workspaceId}/projects/new`);
  await page.getByLabel('Project name').fill(name);
  // Default selection: Development, Staging, Production.
  await expect(page.getByText('3 selected', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return /\/projects\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
}

test.describe('projects and environments', () => {
  test('creates a project from templates and manages custom environments', async ({ page }) => {
    test.setTimeout(180_000);
    const { workspaceId } = shared();
    const name = `Backend ${randomUUID().slice(0, 6)}`;
    const projectId = await createProject(page, name);
    const base = `/workspaces/${workspaceId}/projects/${projectId}`;

    // Overview shows real counts and the three environments.
    const overview = page.getByRole('region', { name: 'Environments' });
    for (const env of ['Development', 'Staging', 'Production']) {
      await expect(overview.getByRole('link', { name: new RegExp(`^${env}`) })).toBeVisible();
    }
    await expect(page.getByText('Project created. You are its Project Admin.')).toBeVisible();

    // Custom environment from the QA template.
    await page.goto(`${base}/environments`);
    await page.getByRole('button', { name: 'New environment' }).click();
    await page
      .getByRole('dialog', { name: 'New environment' })
      .getByRole('link', { name: /^QA/ })
      .click();
    await expect(page).toHaveURL(/environments\/new\?template=builtin%3Aqa$/);
    await expect(page.getByLabel('Name')).toHaveValue('QA');
    await page.getByLabel('Expected variables').fill('API_URL\nAPI_KEY - Payment provider key');
    await page.getByRole('button', { name: 'Create environment' }).click();
    await expect(page).toHaveURL(/environments\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });
    const qaUrl = page.url().replace('?created=1', '');
    await expect(page.getByText('No variables have been configured yet')).toBeVisible();
    await expect(page.getByText('coming in the next phase', { exact: false })).toBeVisible();
    await expect(page.getByRole('main').getByText('API_KEY', { exact: true })).toBeVisible();

    // Duplicate names are rejected.
    await page.goto(`${base}/environments/new`);
    await page.getByLabel('Name').fill('qa');
    await page.getByRole('button', { name: 'Create environment' }).click();
    await expect(page.getByText('Name already used')).toBeVisible();

    // Rename QA: same id and URL.
    await page.goto(`${qaUrl}/settings`);
    await page.getByRole('textbox', { name: /^Name/ }).fill('Quality Assurance');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Environment saved.')).toBeVisible();
    await page.goto(qaUrl);
    await expect(page.getByRole('heading', { level: 2, name: 'Quality Assurance' })).toBeVisible();
    await expect(page.getByText('qa', { exact: true }).first()).toBeVisible();

    // Switch environments with the selector.
    await page.getByRole('button', { name: /Switch environment/ }).click();
    await page.getByRole('menuitem', { name: /Production/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Production' })).toBeVisible();
    await expect(page.getByText('Protected', { exact: true }).first()).toBeVisible();

    // Archive and restore QA.
    await page.goto(`${qaUrl}/settings`);
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('This environment is archived and read-only.')).toBeVisible();
    await page.goto(`${base}/environments`);
    await expect(page.getByRole('list', { name: 'Environments' })).not.toContainText(
      'Quality Assurance',
    );
    await page.getByRole('combobox', { name: 'Status' }).selectOption('archived');
    await expect(page.getByRole('list', { name: 'Environments' })).toContainText(
      'Quality Assurance',
    );
    await page.goto(`${qaUrl}/settings`);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('This environment is archived and read-only.')).toBeHidden();

    // Reorder by keyboard-accessible buttons.
    await page.goto(`${base}/environments`);
    const list = page.getByRole('list', { name: 'Environments' });
    await page.getByRole('button', { name: 'Move Quality Assurance up' }).click();
    await expect(list.getByRole('listitem').nth(2)).toContainText('Quality Assurance');

    // Activity records the changes.
    await page.goto(`${base}/activity`);
    const activity = page.getByRole('list', { name: 'Activity' });
    await expect(activity).toContainText('created the project');
    await expect(activity).toContainText('QA → Quality Assurance');
    await expect(activity).toContainText('archived an environment');
  });

  test('searches, favorites and switches views in the project list', async ({ page }) => {
    test.setTimeout(120_000);
    const { workspaceId } = shared();
    const unique = `Findme ${randomUUID().slice(0, 6)}`;
    await createProject(page, unique);
    await page.getByRole('button', { name: `Add ${unique} to favorites` }).click();
    await expect(
      page.getByRole('button', { name: `Remove ${unique} from favorites` }),
    ).toBeVisible();

    await page.goto(`/workspaces/${workspaceId}/projects`);
    await expect(page.getByRole('region', { name: 'Recently opened' })).toContainText(unique);
    await page.getByRole('searchbox', { name: 'Search projects' }).fill(unique.split(' ')[1] ?? '');
    await expect(page).toHaveURL(/\?q=/);
    await expect(page.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveCount(1);
    await page.getByRole('button', { name: 'List view' }).click();
    await expect(page.getByRole('table', { name: 'Projects' })).toContainText(unique);
    await page.getByRole('searchbox', { name: 'Search projects' }).fill('');
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Projects' })).toContainText(unique);
  });

  test('protects production and deletes projects only with confirmation', async ({ page }) => {
    test.setTimeout(120_000);
    const { workspaceId, password } = shared();
    const projectId = await createProject(page, `Protected ${randomUUID().slice(0, 6)}`);
    const base = `/workspaces/${workspaceId}/projects/${projectId}`;
    await page.goto(`${base}/environments`);
    await page.getByRole('link', { name: /^Production/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Production' })).toBeVisible();
    await page.goto(`${page.url()}/settings`);

    // Removing protection asks for the password.
    await page.getByRole('button', { name: 'Edit protection' }).click();
    const dialog = page.getByRole('dialog', { name: 'Protection settings' });
    await dialog.getByLabel('Protected environment').uncheck();
    await dialog.getByRole('button', { name: 'Remove protection' }).click();
    await expect(dialog.getByRole('alert')).toContainText('requires your password');
    await dialog.getByLabel('Confirm your password').fill('wrong-password');
    await dialog.getByRole('button', { name: 'Remove protection' }).click();
    await expect(dialog.getByText('Incorrect password', { exact: true })).toBeVisible();
    await dialog.getByLabel('Confirm your password').fill(password);
    await dialog.getByRole('button', { name: 'Remove protection' }).click();
    await expect(page.getByText('Protection removed.')).toBeVisible();

    // Delete the whole project.
    await page.goto(`${base}/settings`);
    const slug = (await page.locator('span.font-mono').first().textContent()) ?? '';
    await page.getByRole('button', { name: 'Delete project' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete project?' });
    await confirm.getByLabel(`Type ${slug} to confirm`).fill(slug);
    await confirm.getByLabel('Confirm your password').fill(password);
    await confirm.getByRole('button', { name: 'Delete project' }).click();
    await expect(page).toHaveURL(/\/projects\?deleted=1$/, { timeout: 30_000 });
    await page.goto(base);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  });
});
