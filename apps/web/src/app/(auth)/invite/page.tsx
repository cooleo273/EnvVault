import type { Metadata } from 'next';
import { AuthPageHeader } from '@/features/auth/page-shell';
import { InviteAcceptance } from '@/features/workspaces/invite-acceptance';

export const metadata: Metadata = {
  title: 'Workspace invitation',
  // The page never puts the token in a URL that could leak, but be strict anyway.
  referrer: 'no-referrer',
};

/** Public: anonymous visitors are asked to sign in, then return here. */
export default function InvitePage() {
  return (
    <>
      <AuthPageHeader
        title="Workspace invitation"
        description="You have been invited to join a workspace on EnvVault."
      />
      <InviteAcceptance />
    </>
  );
}
