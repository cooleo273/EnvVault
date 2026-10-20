import type { Metadata } from 'next';
import { EmptyState } from '@/components/feedback/states';
import { InvitationsPanel } from '@/features/workspaces/invitations-panel';
import { withApi } from '@/lib/api/server-api';
import { getWorkspace, handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Invitations' };

export default async function WorkspaceInvitationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const workspace = await getWorkspace(workspaceId);

  if (!workspace.permissions.includes('member:invite')) {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState
          title="You cannot manage invitations"
          description="Ask an owner or admin of this workspace to invite people."
        />
      </div>
    );
  }
  if (workspace.archivedAt) {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState
          title="Invitations are paused"
          description="Archived workspaces are read-only. Restore the workspace to invite people."
        />
      </div>
    );
  }

  const invitations = await withApi((api) => api.listInvitations(workspaceId)).catch(
    (error: unknown) => handleApiFailure(error, `/workspaces/${workspaceId}/invitations`),
  );
  // No outbound email provider exists yet (EMAIL_PROVIDER=none on the API).
  return (
    <InvitationsPanel workspaceId={workspaceId} invitations={invitations} emailConfigured={false} />
  );
}
