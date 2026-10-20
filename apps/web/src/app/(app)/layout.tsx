import { AppShell } from '@/components/layout/app-shell';
import { signOutAction } from '@/features/auth/actions';
import { selectWorkspaceAction } from '@/features/workspaces/actions';
import { requireVerifiedUser } from '@/lib/auth/session';
import { getMe } from '@/lib/workspaces/server';

// Every page below depends on the signed-in user.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Defence in depth: the proxy already redirects anonymous visitors (with redirectTo).
  const user = await requireVerifiedUser('/dashboard');

  // The shell degrades gracefully if the API is unavailable (pages show errors).
  const me = await getMe();

  return (
    <AppShell
      user={{ name: me?.user.displayName ?? user.name, email: user.email }}
      // undefined = could not be loaded (shown as such, not as "no workspace").
      workspaces={me?.workspaces.map((w) => ({ id: w.id, name: w.name }))}
      activeWorkspaceId={me?.activeWorkspaceId ?? undefined}
      pendingInvitationCount={me?.pendingInvitationCount ?? 0}
      signOutAction={signOutAction}
      selectWorkspaceAction={selectWorkspaceAction}
    >
      {children}
    </AppShell>
  );
}
