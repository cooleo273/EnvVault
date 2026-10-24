import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test as setup } from '@playwright/test';
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

/** Signed in routes compile on first visit too (see warmup.setup.ts); do that once here. */
setup('compile the signed in routes', async ({ browser }) => {
  setup.setTimeout(300_000);
  const context = await browser.newContext({ storageState: 'e2e-auth/.auth/user.json' });
  // Plain requests with the session cookies: some pages redirect in the browser, which would
  // abort a page navigation, and compiling needs only the server render.
  for (const path of [
    '/dashboard',
    '/projects',
    '/workspaces',
    '/members',
    '/settings/profile',
    '/settings/security',
    '/design-system',
  ]) {
    const response = await context.request.get(path, { timeout: 120_000 });
    expect(response.status(), path).toBeLessThan(500);
  }
  await context.close();
});
