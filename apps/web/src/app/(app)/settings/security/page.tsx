import type { Metadata } from 'next';
import { ErrorState } from '@/components/feedback/states';
import { SettingsRow, SettingsSection } from '@/components/layout/settings-section';
import { Button } from '@/components/ui/button';
import { signOutEverywhereAction } from '@/features/auth/actions';
import { ChangePasswordForm } from '@/features/account/profile-form';
import { SessionsList } from '@/features/account/sessions-list';
import { listSessions } from '@/features/account/sessions';
import { CliSessionsList } from '@/features/cli/cli-sessions';
import { withApi } from '@/lib/api/server-api';

export const metadata: Metadata = { title: 'Security' };

export default async function SecuritySettingsPage() {
  const [sessions, cliSessions] = await Promise.all([
    listSessions().catch(() => null),
    withApi((api) => api.cliSessions()).catch(() => null),
  ]);
  return (
    <>
      <ChangePasswordForm />

      <SettingsSection
        id="sessions"
        title="Active sessions"
        description="Devices signed in to your account. Signing out a session also revokes its EnvVault API access."
      >
        {sessions ? (
          <SessionsList sessions={sessions} />
        ) : (
          <ErrorState
            title="Sessions could not be loaded"
            description="The sign-in service is unavailable. Try again shortly."
            className="py-6"
          />
        )}
      </SettingsSection>

      <SettingsSection
        id="cli-sessions"
        title="CLI sessions"
        description="Computers where the EnvVault CLI is signed in to your account (envvault login)."
      >
        {cliSessions ? (
          <CliSessionsList sessions={cliSessions} />
        ) : (
          <ErrorState title="CLI sessions could not be loaded" className="py-6" />
        )}
      </SettingsSection>

      <SettingsSection id="everywhere" title="Sign out everywhere" tone="danger">
        <SettingsRow
          title="Sign out of all devices"
          description="Ends every session, including this one and every CLI session, and immediately revokes API access tokens issued before now."
          action={
            <form action={signOutEverywhereAction}>
              <Button type="submit" variant="outline">
                Sign out everywhere
              </Button>
            </form>
          }
        />
      </SettingsSection>
    </>
  );
}
