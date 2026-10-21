import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { completeOnboarding, newAccount, signUpAndVerify } from './support/helpers';

// Synthetic values only.
const TOKEN = `synthetic-intel-${randomUUID().slice(0, 8)}`;

function row(page: Page, key: string) {
  return page
    .getByRole('table', { name: 'Environment variables' })
    .getByRole('row', { name: new RegExp(`\\b${key}\\b`) });
}

async function addVariable(
  page: Page,
  input: { key: string; value: string; type?: string; inheritable?: boolean },
) {
  await page.getByRole('button', { name: 'Add variable' }).first().click();
  const add = page.getByRole('dialog', { name: 'Add variable' });
  await add.getByLabel(/^Name/).fill(input.key);
  if (input.type) await add.getByLabel(/^Type/).selectOption(input.type);
  await add.getByLabel(/^Value/).fill(input.value);
  if (input.inheritable) await add.getByRole('switch', { name: /Inheritable/ }).click();
  await add.getByRole('button', { name: 'Add variable' }).click();
  await expect(add).toBeHidden();
  await expect(row(page, input.key)).toBeVisible();
}

test('environments: compare, inherit, validate, snapshot and restore', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = newAccount('intel');
  const context = await browser.newContext();
  const page = await context.newPage();
  await signUpAndVerify(page, owner);
  const workspaceId = await completeOnboarding(page, 'Intelligence Team');
  await page.goto(`/workspaces/${workspaceId}/projects/new`);
  await page.getByLabel('Project name').fill('Intelligence');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\?created=1$/, { timeout: 30_000 });
  const projectUrl = page.url().replace('?created=1', '');

  // Development: one inheritable setting and one secret.
  await page
    .getByRole('link', { name: /^Development/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/environments\/[0-9a-f-]{36}$/);
  const developmentUrl = page.url();
  await addVariable(page, { key: 'LOG_LEVEL', value: 'info', type: 'STRING', inheritable: true });
  await addVariable(page, { key: 'API_TOKEN', value: TOKEN });
  await expect(row(page, 'LOG_LEVEL').getByText('Inheritable')).toBeVisible();

  // Staging inherits from Development: only the inheritable setting flows down.
  await page.goto(projectUrl);
  await page
    .getByRole('link', { name: /^Staging/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/environments\/[0-9a-f-]{36}$/);
  const stagingUrl = page.url();
  await page.goto(`${stagingUrl}/settings`);
  const inheritance = page.getByRole('region', { name: 'Inheritance' });
  await inheritance.getByLabel('Base environment').selectOption({ label: 'Development' });
  await inheritance.getByRole('button', { name: 'Save' }).click();
  await expect(inheritance.getByText('Base: Development')).toBeVisible();
  await page.goto(stagingUrl);
  const inherited = page.getByTestId('inherited-variables');
  await expect(inherited.getByTestId('inherited-row')).toHaveCount(1);
  await expect(inherited.getByText('LOG_LEVEL')).toBeVisible();
  await expect(inherited.getByText('Inherited from Development')).toBeVisible();
  await expect(inherited.getByText('API_TOKEN')).toHaveCount(0);

  // Comparison: metadata only by default, values compared on request without showing them.
  await page.goto(`${projectUrl}/compare`);
  await page.getByLabel('Source environment').selectOption({ label: 'Development' });
  await page.getByLabel('Target environment').selectOption({ label: 'Staging' });
  const tokenRow = page.getByTestId('comparison-row').filter({ hasText: 'API_TOKEN' });
  await expect(tokenRow.getByText('Missing from Staging')).toBeVisible();
  await page.getByRole('button', { name: 'Compare values' }).click();
  await expect(page.getByRole('button', { name: 'Hide value comparison' })).toBeVisible();
  await expect(page.getByText(TOKEN)).toHaveCount(0);

  // Validation rule: a required variable that is missing blocks readiness.
  await page.goto(`${developmentUrl}/settings`);
  const rules = page.getByRole('region', { name: 'Validation rules' });
  await rules.getByRole('button', { name: 'Add rule' }).click();
  const ruleDialog = page.getByRole('dialog', { name: 'Add rule' });
  await ruleDialog.getByLabel(/^Variable/).fill('API_URL');
  await ruleDialog.getByRole('button', { name: 'Apply' }).click();
  await rules.getByRole('button', { name: 'Save rules' }).click();
  await expect(rules.getByText('Unsaved changes.')).toBeHidden();
  await page.getByRole('link', { name: 'Readiness' }).click();
  await expect(page.getByTestId('readiness-status')).toHaveText('Blocked');
  await expect(page.getByTestId('readiness-issue').filter({ hasText: 'API_URL' })).toBeVisible();

  // Snapshot, change a value, see the drift, restore.
  await page.getByRole('link', { name: 'Snapshots' }).click();
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  const snap = page.getByRole('dialog', { name: 'Take snapshot' });
  await snap.getByLabel('Description').fill('Before log change');
  await snap.getByRole('button', { name: 'Save snapshot' }).click();
  await expect(page).toHaveURL(/\/snapshots\/[0-9a-f-]{36}$/);
  const snapshotUrl = page.url();
  await expect(page.getByTestId('snapshot-entry')).toHaveCount(2);

  await page.goto(developmentUrl);
  await row(page, 'LOG_LEVEL').getByRole('button', { name: 'Actions for LOG_LEVEL' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit LOG_LEVEL' });
  await edit.getByRole('switch', { name: /Replace the value/ }).click();
  await edit.getByLabel(/^Value/).fill('debug');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();
  await expect(row(page, 'LOG_LEVEL').getByTestId('secret-version')).toHaveText('v2');

  await page.goto(snapshotUrl);
  const drift = page.getByTestId('drift-row').filter({ hasText: 'LOG_LEVEL' });
  await expect(drift.getByText('Different version (value not compared)')).toBeVisible();
  await page.getByRole('button', { name: 'Restore…' }).click();
  const restore = page.getByRole('dialog', { name: 'Restore snapshot' });
  await expect(restore.getByTestId('restore-action')).toHaveCount(1);
  await restore.getByLabel('Reason').fill('Synthetic restore check');
  await restore.getByRole('button', { name: 'Restore 1 changes' }).click();
  await expect(restore).toBeHidden();

  await page.goto(developmentUrl);
  await expect(row(page, 'LOG_LEVEL').getByTestId('secret-version')).toHaveText('v3');
  await row(page, 'LOG_LEVEL').getByRole('button', { name: 'Reveal LOG_LEVEL' }).click();
  await expect(row(page, 'LOG_LEVEL').getByTestId('secret-value')).toHaveText('info');
  await context.close();
});
