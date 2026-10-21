import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { completeOnboarding, newAccount, signUpAndVerify } from './support/helpers';

// Synthetic values only.
const TOKEN = `synthetic-token-${randomUUID().slice(0, 8)}`;
const ROTATED = `synthetic-rotated-${randomUUID().slice(0, 8)}`;

function row(page: Page, key: string) {
  return page
    .getByRole('table', { name: 'Environment variables' })
    .getByRole('row', { name: new RegExp(`\\b${key}\\b`) });
}

test('variables: import, history and rollback, bulk edit, export, bulk delete and restore', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = newAccount('xfer');
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await signUpAndVerify(page, owner);
  const workspaceId = await completeOnboarding(page, 'Transfers Team');
  await page.goto(`/workspaces/${workspaceId}/projects/new`);
  await page.getByLabel('Project name').fill('Transfers');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });
  await page
    .getByRole('link', { name: /^Development/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/environments\/[0-9a-f-]{36}$/);
  const environmentUrl = page.url();

  // Import: paste, review, choose, import.
  await page.getByRole('button', { name: 'Import' }).click();
  const wizard = page.getByRole('dialog', { name: 'Import into Development' });
  await wizard
    .getByLabel(/\.env content/)
    .fill(
      [
        '# synthetic import',
        `API_TOKEN=${TOKEN}`,
        'LOG_LEVEL=info',
        'CERT="-----BEGIN-----\\nabc\\n-----END-----"',
        'not valid',
      ].join('\n'),
    );
  await wizard.getByRole('button', { name: 'Review changes' }).click();
  await expect(wizard.getByTestId('import-entry')).toHaveCount(3);
  await expect(wizard.getByText(/1 line was not understood/)).toBeVisible();
  await expect(wizard.getByText(TOKEN)).toHaveCount(0);
  await wizard.getByRole('button', { name: 'Import 3 variables' }).click();
  await expect(wizard.getByText('Import complete')).toBeVisible();
  await wizard.getByRole('button', { name: 'Done' }).click();
  await expect(row(page, 'API_TOKEN').getByLabel('Value hidden')).toBeVisible();
  await expect(page.getByTestId('variable-count')).toHaveText('3 variables');

  // New value, then history: reveal v1 and roll back to it.
  await row(page, 'API_TOKEN').getByRole('button', { name: 'Actions for API_TOKEN' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit API_TOKEN' });
  await edit.getByRole('switch', { name: /Replace the value/ }).click();
  await edit.getByLabel(/^Value/).fill(ROTATED);
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();
  await expect(row(page, 'API_TOKEN').getByTestId('secret-version')).toHaveText('v2');

  await row(page, 'API_TOKEN').getByRole('button', { name: 'Actions for API_TOKEN' }).click();
  await page.getByRole('menuitem', { name: 'History' }).click();
  const drawer = page.getByRole('dialog', { name: 'History of API_TOKEN' });
  await expect(drawer.getByTestId('version-row')).toHaveCount(2);
  await drawer.getByRole('button', { name: 'Reveal version 1' }).click();
  await expect(drawer.getByTestId('version-value')).toHaveText(TOKEN);
  await drawer.getByRole('button', { name: 'Restore' }).click();
  await page
    .getByRole('alertdialog', { name: 'Restore v1?' })
    .getByRole('button', { name: 'Restore as new version' })
    .click();
  await expect(drawer.getByTestId('version-row')).toHaveCount(3);
  await expect(drawer.getByText('Rolled back')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(page, 'API_TOKEN').getByTestId('secret-version')).toHaveText('v3');
  await row(page, 'API_TOKEN').getByRole('button', { name: 'Reveal API_TOKEN' }).click();
  await expect(row(page, 'API_TOKEN').getByTestId('secret-value')).toHaveText(TOKEN);
  await row(page, 'API_TOKEN').getByRole('button', { name: 'Hide API_TOKEN' }).click();

  // Bulk edit every visible variable.
  await page.getByLabel('Select all visible variables').check();
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected');
  await page.getByRole('button', { name: 'Edit details' }).click();
  const bulkEdit = page.getByRole('dialog', { name: 'Edit 3 variables' });
  await bulkEdit.getByLabel('Category').selectOption('set');
  await bulkEdit.getByLabel('New category').fill('Imported');
  await bulkEdit.getByRole('button', { name: 'Apply' }).click();
  await expect(bulkEdit).toBeHidden();
  await expect(row(page, 'LOG_LEVEL').getByText('Imported')).toBeVisible();

  // Export: requires the acknowledgement, downloads a parsable .env file.
  await page.getByRole('button', { name: 'Export' }).first().click();
  const exportDialog = page.getByRole('dialog', { name: 'Export variables' });
  await expect(exportDialog.getByRole('button', { name: 'Download' })).toBeDisabled();
  await exportDialog.getByLabel(/I understand the file contains plaintext secrets/).check();
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('development.env');
  const file = await readFile(await download.path(), 'utf8');
  expect(file).toContain(`API_TOKEN=${TOKEN}`);
  expect(file).toContain('LOG_LEVEL=info');
  await download.delete();

  // Bulk delete with typed confirmation, then restore from Deleted.
  await page.getByLabel('Select all visible variables').check();
  await page
    .getByRole('region', { name: 'Bulk actions' })
    .getByRole('button', { name: 'Delete' })
    .click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete 3 variables?' });
  await expect(confirm.getByRole('button', { name: 'Delete 3' })).toBeDisabled();
  await confirm.getByRole('textbox').fill('delete 3');
  await confirm.getByRole('button', { name: 'Delete 3' }).click();
  await expect(page.getByText('No variables yet')).toBeVisible();
  await page.getByRole('button', { name: 'Deleted', exact: true }).click();
  await expect(page).toHaveURL(/status=deleted/);
  await page.getByLabel('Select all visible variables').check();
  await page
    .getByRole('region', { name: 'Bulk actions' })
    .getByRole('button', { name: 'Restore' })
    .click();
  await page
    .getByRole('alertdialog', { name: 'Restore 3 variables?' })
    .getByRole('button', { name: 'Restore 3' })
    .click();
  await expect(page.getByText('No deleted variables')).toBeVisible();

  await page.goto(environmentUrl);
  await expect(page.getByTestId('variable-count')).toHaveText('3 variables');
  await context.close();
});
