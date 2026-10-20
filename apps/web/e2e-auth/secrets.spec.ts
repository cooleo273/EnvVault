import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { completeOnboarding, newAccount, signUpAndVerify } from './support/helpers';

// Synthetic values only; real credentials never go through automated tests.
const FIRST = `synthetic-first-${randomUUID().slice(0, 8)}`;
const SECOND = `synthetic-second-${randomUUID().slice(0, 8)}`;
const KEY = 'SYNTHETIC_DB_PASSWORD';

function row(page: Page, key = KEY) {
  return page
    .getByRole('table', { name: 'Environment variables' })
    .getByRole('row', { name: new RegExp(key) });
}

test('variables: add, mask, reveal, edit, revoke, delete and restore', async ({ browser }) => {
  test.setTimeout(240_000);
  const owner = newAccount('vowner');
  const dev = newAccount('vdev');
  const ownerPage = await (await browser.newContext()).newPage();
  const devPage = await (await browser.newContext()).newPage();

  await signUpAndVerify(ownerPage, owner);
  const workspaceId = await completeOnboarding(ownerPage, 'Vault Team');
  await ownerPage.goto(`/workspaces/${workspaceId}/invitations`);
  await ownerPage.getByLabel('Email address').fill(dev.email);
  await ownerPage.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(ownerPage.getByText(/It was not emailed/)).toBeVisible();
  await signUpAndVerify(devPage, dev);
  await devPage
    .getByRole('list', { name: 'Invitations for you' })
    .getByRole('button', { name: /Accept/ })
    .click();
  await expect(devPage).toHaveURL(new RegExp(`/workspaces/${workspaceId}\\?joined=1$`));

  // Project with the default environments; the owner is its Project Admin.
  await ownerPage.goto(`/workspaces/${workspaceId}/projects/new`);
  await ownerPage.getByLabel('Project name').fill('Vault Demo');
  await ownerPage.getByRole('button', { name: 'Create project' }).click();
  await expect(ownerPage).toHaveURL(/\/projects\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });
  const projectUrl = ownerPage.url().replace('?created=1', '');
  await ownerPage
    .getByRole('link', { name: /^Development/ })
    .first()
    .click();
  await expect(ownerPage).toHaveURL(/\/environments\/[0-9a-f-]{36}$/);
  const environmentUrl = ownerPage.url();
  await expect(ownerPage.getByText('No variables yet')).toBeVisible();

  // Add a synthetic secret.
  await ownerPage.getByRole('button', { name: 'Add variable' }).first().click();
  const add = ownerPage.getByRole('dialog', { name: 'Add variable' });
  await add.getByLabel(/^Name/).fill(KEY);
  await add.getByLabel(/^Value/).fill(FIRST);
  await add.getByLabel(/^Category/).fill('Database');
  await add.getByRole('button', { name: 'Add variable' }).click();
  await expect(add).toBeHidden();

  // Masked by default; the value is not in the page until revealed.
  await expect(row(ownerPage).getByLabel('Value hidden')).toHaveText('••••••••••••');
  await expect(ownerPage.getByText(FIRST)).toHaveCount(0);
  await expect(row(ownerPage).getByTestId('secret-version')).toHaveText('v1');

  await row(ownerPage)
    .getByRole('button', { name: `Reveal ${KEY}` })
    .click();
  await expect(row(ownerPage).getByTestId('secret-value')).toHaveText(FIRST);
  await row(ownerPage)
    .getByRole('button', { name: `Hide ${KEY}` })
    .click();
  await expect(ownerPage.getByText(FIRST)).toHaveCount(0);

  // Edit the value: a new version.
  await row(ownerPage)
    .getByRole('button', { name: `Actions for ${KEY}` })
    .click();
  await ownerPage.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = ownerPage.getByRole('dialog', { name: `Edit ${KEY}` });
  await edit.getByRole('switch', { name: /Replace the value/ }).click();
  await edit.getByLabel(/^Value/).fill(SECOND);
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();
  await expect(row(ownerPage).getByTestId('secret-version')).toHaveText('v2');

  // A developer of the project can reveal it.
  await ownerPage.goto(`${projectUrl}/members`);
  await ownerPage
    .getByLabel('Workspace member')
    .selectOption({ label: `${dev.name} (${dev.email})` });
  await ownerPage.getByLabel('Project role', { exact: true }).selectOption('project-developer');
  await ownerPage.getByRole('button', { name: 'Add to project' }).click();
  await expect(ownerPage.getByText('Member added.')).toBeVisible();

  await devPage.goto(environmentUrl);
  await row(devPage)
    .getByRole('button', { name: `Reveal ${KEY}` })
    .click();
  await expect(row(devPage).getByTestId('secret-value')).toHaveText(SECOND);
  await row(devPage)
    .getByRole('button', { name: `Hide ${KEY}` })
    .click();

  // Revoke: Viewer keeps the metadata, loses values. The stale page still
  // shows the control, and the API refuses the reveal.
  await ownerPage.getByLabel(`Project role for ${dev.name}`).selectOption('project-viewer');
  await expect(ownerPage.getByText('Project role updated.')).toBeVisible();
  await row(devPage)
    .getByRole('button', { name: `Reveal ${KEY}` })
    .click();
  await expect(devPage.getByText('You do not have permission to do that.')).toBeVisible();
  await expect(devPage.getByText(SECOND)).toHaveCount(0);
  await devPage.reload();
  await expect(row(devPage)).toBeVisible();
  await expect(row(devPage).getByRole('button', { name: /Reveal/ })).toHaveCount(0);

  // Delete and restore.
  await ownerPage.goto(environmentUrl);
  await row(ownerPage)
    .getByRole('button', { name: `Actions for ${KEY}` })
    .click();
  await ownerPage.getByRole('menuitem', { name: 'Delete' }).click();
  await ownerPage
    .getByRole('alertdialog', { name: `Delete ${KEY}?` })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(ownerPage.getByText('No variables yet')).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Deleted', exact: true }).click();
  await expect(row(ownerPage)).toBeVisible();
  await row(ownerPage)
    .getByRole('button', { name: `Actions for ${KEY}` })
    .click();
  await ownerPage.getByRole('menuitem', { name: 'Restore' }).click();
  await expect(ownerPage.getByText(`${KEY} restored.`)).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(ownerPage).not.toHaveURL(/status=deleted/);
  await expect(row(ownerPage).getByLabel('Value hidden')).toBeVisible();

  // Persisted: survives a full reload with its value and version.
  await ownerPage.reload();
  await expect(row(ownerPage).getByTestId('secret-version')).toHaveText('v2');
  await row(ownerPage)
    .getByRole('button', { name: `Reveal ${KEY}` })
    .click();
  await expect(row(ownerPage).getByTestId('secret-value')).toHaveText(SECOND);
});
