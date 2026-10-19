import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ErrorState } from '@/components/feedback/states';
import { OnboardingWizard } from '@/features/workspaces/onboarding-wizard';
import { withApi } from '@/lib/api/server-api';
import { getMe } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Get started' };

/** First-run flow. Users who already belong to a workspace go to the dashboard. */
export default async function OnboardingPage() {
  const me = await getMe();
  if (!me) {
    return (
      <div className="rounded-lg border bg-surface">
        <ErrorState
          title="EnvVault is unavailable"
          description="Your account could not be loaded. Try again shortly."
        />
      </div>
    );
  }
  if (me.workspaces.length > 0) redirect('/dashboard');
  const invitations =
    me.pendingInvitationCount > 0
      ? await withApi((api) => api.myInvitations()).catch(() => [])
      : [];
  return <OnboardingWizard name={me.user.displayName} invitations={invitations} />;
}
