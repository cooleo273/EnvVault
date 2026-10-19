import { mkdirSync, writeFileSync } from 'node:fs';
import { test as setup } from '@playwright/test';
import { completeOnboarding, newAccount, signUpAndVerify } from './support/helpers';

/** Creates the shared signed-in user (with one workspace) for the "authenticated" project. */
setup('register, verify and onboard the shared test user', async ({ page }) => {
  const account = newAccount('shared');
  await signUpAndVerify(page, account);
  const workspaceId = await completeOnboarding(page, 'Shared Workspace');
  mkdirSync('e2e-auth/.auth', { recursive: true });
  writeFileSync('e2e-auth/.auth/account.json', JSON.stringify({ ...account, workspaceId }));
  await page.context().storageState({ path: 'e2e-auth/.auth/user.json' });
});
