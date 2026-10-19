import { expect, test } from '@playwright/test';
import { completeOnboarding, newAccount, signUpAndVerify } from './support/helpers';

/**
 * Two people, two browser contexts: invitation by link (email delivery is not
 * configured, so the link is shared manually), sign-up through the link,
 * joining, role changes, ownership transfer and replay protection.
 */
test('invites a teammate who signs up through the link, then hands over ownership', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = newAccount('owner');
  const guest = newAccount('guest');
  const ownerPage = await (await browser.newContext()).newPage();
  const guestPage = await (await browser.newContext()).newPage();

  await signUpAndVerify(ownerPage, owner);
  const workspaceId = await completeOnboarding(ownerPage, 'Team Collab');
  const base = `/workspaces/${workspaceId}`;

  // Invite: the UI says plainly that nothing was emailed and shows the link once.
  await ownerPage.goto(`${base}/invitations`);
  await expect(ownerPage.getByText('Email not configured')).toBeVisible();
  await ownerPage.getByLabel('Email address').fill(guest.email);
  await ownerPage.getByLabel('Role').selectOption('member');
  await ownerPage.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(ownerPage.getByText(/It was not emailed/)).toBeVisible();
  await expect(ownerPage.getByText(/Email delivery is not configured/)).toBeVisible();
  const link = await ownerPage.getByRole('textbox', { name: 'Invitation link' }).inputValue();
  expect(link).toMatch(/\/invite#token=[A-Za-z0-9_-]{43}$/);
  await expect(
    ownerPage.getByRole('table', { name: 'Workspace invitations' }).getByText('Pending'),
  ).toBeVisible();

  // The guest opens the link signed out, creates an account and comes back.
  await guestPage.goto(link);
  await expect(guestPage).toHaveURL(/\/invite$/); // token removed from the address bar
  await guestPage.getByRole('link', { name: 'Create an account' }).click();
  await expect(guestPage).toHaveURL(/\/signup\?redirectTo=%2Finvite$/);
  await signUpAndVerify(guestPage, guest, '/signup?redirectTo=%2Finvite');
  await expect(guestPage).toHaveURL(/\/invite$/);
  await expect(guestPage.getByText('Team Collab', { exact: true })).toBeVisible();
  await guestPage.getByRole('button', { name: 'Join Team Collab' }).click();
  await expect(guestPage).toHaveURL(new RegExp(`${base}\\?joined=1$`));
  await expect(guestPage.getByText('You joined Team Collab as Member.')).toBeVisible();
  // Members cannot administer: no settings or invitations tabs.
  const tabs = guestPage.getByRole('navigation', { name: 'Workspace sections' });
  await expect(tabs.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(tabs.getByRole('link', { name: 'Invitations' })).toHaveCount(0);

  // Replay: the same link cannot be used again.
  await guestPage.goto(link);
  await expect(guestPage.getByRole('main').getByRole('alert')).toContainText(
    'invalid, already used, or has expired',
  );

  // The owner promotes the guest to admin.
  await ownerPage.goto(`${base}/members`);
  await ownerPage.getByLabel(`Role for ${guest.name}`).selectOption('admin');
  await expect(ownerPage.getByText('Role updated.')).toBeVisible();
  await guestPage.goto(base);
  await expect(tabs.getByRole('link', { name: 'Settings' })).toBeVisible();

  // The final owner cannot leave.
  await ownerPage.reload();
  await expect(ownerPage.getByRole('button', { name: 'Leave' })).toBeDisabled();

  // Ownership transfer requires the password.
  await ownerPage.goto(`${base}/settings`);
  await ownerPage.getByRole('button', { name: 'Transfer ownership' }).click();
  const dialog = ownerPage.getByRole('dialog', { name: 'Transfer ownership' });
  await dialog
    .getByLabel('New owner')
    .selectOption({ label: `${guest.name} (${guest.email}) · Admin` });
  await dialog.getByLabel('Confirm your password').fill('wrong-password');
  await dialog.getByRole('button', { name: 'Transfer ownership' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Incorrect password');
  await dialog
    .getByLabel('New owner')
    .selectOption({ label: `${guest.name} (${guest.email}) · Admin` });
  await dialog.getByLabel('Confirm your password').fill(owner.password);
  await dialog.getByRole('button', { name: 'Transfer ownership' }).click();
  await expect(ownerPage).toHaveURL(new RegExp(`${base}/members\\?transferred=1$`));
  await expect(ownerPage.getByText('You are now an admin of this workspace.')).toBeVisible();

  // The former owner, now an admin, can leave; the new owner sees one member left.
  await ownerPage.getByRole('button', { name: 'Leave' }).click();
  await ownerPage.getByRole('alertdialog').getByRole('button', { name: 'Leave workspace' }).click();
  await expect(ownerPage).toHaveURL(/\/onboarding$/);
  await guestPage.goto(`${base}/members`);
  await expect(guestPage.getByText('1 member.')).toBeVisible();
});

test('pending invitations appear in-app and can be declined', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = newAccount('inviter');
  const guest = newAccount('decliner');
  const ownerPage = await (await browser.newContext()).newPage();
  const guestPage = await (await browser.newContext()).newPage();

  await signUpAndVerify(ownerPage, owner);
  const workspaceId = await completeOnboarding(ownerPage, 'Decline Me');
  await ownerPage.goto(`/workspaces/${workspaceId}/invitations`);
  await ownerPage.getByLabel('Email address').fill(guest.email);
  await ownerPage.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(ownerPage.getByText(/It was not emailed/)).toBeVisible();

  // Without the link: the invitee sees it on onboarding after signing up.
  await signUpAndVerify(guestPage, guest);
  await expect(guestPage).toHaveURL(/\/onboarding$/);
  const list = guestPage.getByRole('list', { name: 'Invitations for you' });
  await expect(list).toContainText('Decline Me');
  await list.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(guestPage.getByText('Invitation declined.')).toBeVisible();

  await ownerPage.reload();
  await expect(
    ownerPage.getByRole('table', { name: 'Workspace invitations' }).getByText('Declined'),
  ).toBeVisible();
});
