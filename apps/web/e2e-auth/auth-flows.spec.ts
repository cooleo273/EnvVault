import { expect, test } from '@playwright/test';
import { createPrismaClient } from '../../../packages/database/dist/index.js';
import {
  completeOnboarding,
  latestMail,
  liveSessions,
  newAccount,
  signIn,
  signOut,
  signUpAndVerify,
} from './support/helpers';

const PROTECTED = [
  '/dashboard',
  '/onboarding',
  '/workspaces',
  '/projects',
  '/settings',
  '/settings/security',
  '/audit-logs',
];

test.describe('registration and email verification', () => {
  test('registers, verifies the email with the emailed code and starts onboarding', async ({
    page,
  }) => {
    const account = newAccount('register');
    await signUpAndVerify(page, account);
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(
      page.getByRole('heading', { level: 1, name: `Welcome to EnvVault, ${account.name}` }),
    ).toBeVisible();
    await page.getByRole('button', { name: /^Account menu for/ }).click();
    await expect(page.getByText(account.email)).toBeVisible();
  });

  test('rejects a wrong verification code', async ({ page }) => {
    const account = newAccount('badcode');
    await page.goto('/signup');
    await page.getByLabel('Name').fill(account.name);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Verification code').fill('000000');
    await page.getByRole('button', { name: 'Verify email' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('invalid or has expired');
  });

  test('unverified accounts cannot sign in to the app', async ({ page }) => {
    const account = newAccount('unverified');
    await page.goto('/signup');
    await page.getByLabel('Name').fill(account.name);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/verify-email/);

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, account);
    await expect(page).toHaveURL(/\/verify-email$/);
  });

  test('keeps old /auth/* links working', async ({ page }) => {
    await page.goto('/auth/sign-in');
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/auth/forgot-password');
    await expect(page).toHaveURL(/\/forgot-password$/);
  });
});

test.describe('login', () => {
  let account: ReturnType<typeof newAccount>;

  test.beforeEach(async ({ browser }) => {
    account = newAccount('login');
    const page = await browser.newPage();
    await signUpAndVerify(page, account);
    await signOut(page);
    await page.close();
  });

  test('rejects invalid credentials with a generic message', async ({ page }) => {
    await signIn(page, { ...account, password: 'definitely-wrong-password' });
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      'Incorrect email or password.',
    );
    // The email is kept for the next attempt; the password is cleared.
    await expect(page.getByLabel('Email')).toHaveValue(account.email);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await signIn(page, { ...account, email: 'nobody-here@example.test' });
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      'Incorrect email or password.',
    );
  });

  test('redirects anonymous visitors to sign-in and back to the requested page', async ({
    page,
  }) => {
    for (const path of PROTECTED) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?redirectTo=${encodeURIComponent(path)}`));
    }
    await page.goto('/settings/security');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/settings\/security$/);
  });

  test('never follows an off-site redirectTo after login', async ({ page }) => {
    await signIn(page, account, '/login?redirectTo=https%3A%2F%2Fevil.example%2Fphish');
    // Default destination; without a workspace the dashboard continues to onboarding.
    await expect(page).toHaveURL(/\/onboarding$/);
  });

  test('keeps JWTs out of the browser: only HTTP-only cookies are set', async ({ page }) => {
    await signIn(page, account);
    await expect(page).toHaveURL(/\/onboarding$/);
    const cookies = await page.context().cookies();
    const authCookies = cookies.filter((c) => c.name.startsWith('__Secure-neon-auth'));
    expect(authCookies.length).toBeGreaterThan(0);
    for (const cookie of authCookies) {
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.secure).toBe(true);
    }
    expect(await page.evaluate(() => document.cookie)).toBe('');
  });
});

test.describe('onboarding redirects', () => {
  test('sends users without a workspace to onboarding and members to their workspace', async ({
    page,
  }) => {
    const account = newAccount('landing');
    await signUpAndVerify(page, account);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/onboarding$/);

    await completeOnboarding(page, 'Landing Personal', 'Personal');
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Landing Personal' })).toBeVisible();
    await expect(page.getByText('Personal', { exact: true })).toBeVisible();
  });
});

test.describe('logout and session revocation', () => {
  test('signs out, ends the Neon session and revokes API tokens', async ({ page }) => {
    const account = newAccount('logout');
    await signUpAndVerify(page, account);
    expect(await liveSessions(account.email)).toBe(1);

    await signOut(page);
    expect(await liveSessions(account.email)).toBe(0);

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);

    // The API recorded the revocation boundary for this user's access tokens.
    const db = createPrismaClient({ connectionString: process.env.E2E_DATABASE_URL ?? '' });
    try {
      const user = await db.user.findFirstOrThrow({ where: { email: account.email } });
      const revocation = await db.authTokenRevocation.findUnique({ where: { userId: user.id } });
      expect(revocation?.reason).toBe('LOGOUT');
    } finally {
      await db.$disconnect();
    }
  });

  test('signing out everywhere ends sessions on other devices', async ({ browser }) => {
    const account = newAccount('everywhere');
    const laptop = await browser.newPage();
    await signUpAndVerify(laptop, account);
    const phone = await (await browser.newContext()).newPage();
    await signIn(phone, account);
    await expect(phone).toHaveURL(/\/onboarding$/);
    expect(await liveSessions(account.email)).toBe(2);

    await laptop.goto('/settings/security');
    await laptop.getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(laptop).toHaveURL(/\/login\?signedOut=1$/);
    expect(await liveSessions(account.email)).toBe(0);

    // The other device's session no longer works.
    await phone.context().clearCookies({ name: '__Secure-neon-auth.local.session_data' });
    await phone.goto('/settings/profile');
    await expect(phone).toHaveURL(/\/login/);
  });
});

test.describe('password recovery', () => {
  test('resets the password through the emailed link', async ({ page }) => {
    const account = newAccount('reset');
    await signUpAndVerify(page, account);
    await signOut(page);

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(account.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('If an account exists');

    const mail = await latestMail(account.email, 'reset-password');
    await page.goto(mail.url ?? '');
    await expect(page).toHaveURL(/\/reset-password\?token=/);

    const newPassword = `new-${account.password}`;
    await page.getByLabel('New password', { exact: true }).fill(newPassword);
    await page.getByLabel('Confirm new password').fill(newPassword);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page).toHaveURL(/\/login\?reset=1$/);

    await signIn(page, account);
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      'Incorrect email or password.',
    );
    await signIn(page, { ...account, password: newPassword });
    await expect(page).toHaveURL(/\/onboarding$/);
  });

  test('does not reveal whether an account exists', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill('no-such-account@example.test');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('If an account exists');
  });

  test('rejects invalid reset links', async ({ page }) => {
    await page.goto('/reset-password?token=forged-token');
    await page.getByLabel('New password', { exact: true }).fill('another-long-password');
    await page.getByLabel('Confirm new password').fill('another-long-password');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('invalid or has expired');
  });
});

test.describe('account settings', () => {
  test('edits the profile name and changes the password', async ({ page }) => {
    const account = newAccount('profile');
    await signUpAndVerify(page, account);

    await page.goto('/settings/profile');
    await page.getByLabel('Name').fill('Renamed Person');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Profile updated.' })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Account menu for Renamed Person' }),
    ).toBeVisible();

    await page.goto('/settings/security');
    await expect(page.getByText('This device')).toBeVisible();
    const newPassword = `changed-${account.password}`;
    await page.locator('input[name="currentPassword"]').fill('not-the-password');
    await page.locator('input[name="newPassword"]').fill(newPassword);
    await page.locator('input[name="confirmPassword"]').fill(newPassword);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('main').getByRole('alert').first()).toContainText(
      'current password is incorrect',
    );

    await page.locator('input[name="currentPassword"]').fill(account.password);
    await page.locator('input[name="newPassword"]').fill(newPassword);
    await page.locator('input[name="confirmPassword"]').fill(newPassword);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Password changed. Other devices were signed out.')).toBeVisible();

    await signOut(page);
    await signIn(page, account);
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      'Incorrect email or password.',
    );
    await signIn(page, { ...account, password: newPassword });
    await expect(page).toHaveURL(/\/onboarding$/);
  });
});
