import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export const STANDIN = 'http://localhost:4410';

export interface TestAccount {
  name: string;
  email: string;
  password: string;
}

export function newAccount(label: string): TestAccount {
  return {
    name: `E2E ${label}`,
    email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
    password: `pw-${randomUUID()}`,
  };
}

interface MailboxEntry {
  to: string;
  kind: string;
  otp?: string;
  url?: string;
}

/** Reads the most recent captured email of `kind` sent to `to`. */
export async function latestMail(to: string, kind: string): Promise<MailboxEntry> {
  let entry: MailboxEntry | undefined;
  await expect
    .poll(async () => {
      const response = await fetch(`${STANDIN}/__test/mailbox?to=${encodeURIComponent(to)}`);
      const mails = (await response.json()) as MailboxEntry[];
      entry = mails.filter((m) => m.kind === kind).at(-1);
      return entry !== undefined;
    })
    .toBe(true);
  if (!entry) throw new Error(`No ${kind} email for ${to}`);
  return entry;
}

export async function liveSessions(email: string): Promise<number> {
  const response = await fetch(`${STANDIN}/__test/sessions?email=${encodeURIComponent(email)}`);
  return ((await response.json()) as { sessions: number }).sessions;
}

/**
 * Registers through the UI and completes email verification with the emailed
 * code. New users without a workspace continue to onboarding.
 */
export async function signUpAndVerify(
  page: Page,
  account: TestAccount,
  path = '/signup',
): Promise<void> {
  await page.goto(path);
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/verify-email$/);

  const mail = await latestMail(account.email, 'email-verification');
  await page.getByLabel('Verification code').fill(mail.otp ?? '');
  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page).not.toHaveURL(/\/verify-email/);
}

/** Completes the onboarding wizard; returns the new workspace's id. */
export async function completeOnboarding(
  page: Page,
  name: string,
  type: 'Personal' | 'Team' = 'Team',
): Promise<string> {
  await page.goto('/onboarding');
  await page.getByRole('button', { name: 'Create a workspace' }).click();
  await page.getByText(type, { exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Workspace name').fill(name);
  await page.getByRole('button', { name: 'Create workspace and continue' }).click();
  await expect(page).toHaveURL(/\/dashboard\?welcome=1$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const href = await page.getByRole('link', { name: 'Open workspace' }).getAttribute('href');
  const id = /\/workspaces\/([0-9a-f-]{36})$/.exec(href ?? '')?.[1];
  if (!id) throw new Error('workspace id not found');
  return id;
}

export async function signIn(page: Page, account: TestAccount, path = '/login'): Promise<void> {
  await page.goto(path);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu for/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login\?signedOut=1$/);
}
