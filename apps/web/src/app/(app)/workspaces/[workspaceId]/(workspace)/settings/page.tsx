import type { WorkspaceMember } from '@envvault/shared';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/feedback/states';
import { SettingsSection } from '@/components/layout/settings-section';
import {
  ArchiveSettings,
  DeleteWorkspace,
  GeneralSettings,
  TransferOwnership,
} from '@/features/workspaces/workspace-settings';
import { withApi } from '@/lib/api/server-api';
import { getWorkspace, handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Workspace settings' };

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const workspace = await getWorkspace(workspaceId);
  const can = (permission: string) => workspace.permissions.includes(permission);

  if (!can('workspace:update') && !can('workspace:archive') && !can('workspace:delete')) {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState
          title="You cannot change workspace settings"
          description="Ask an owner or admin of this workspace."
        />
      </div>
    );
  }

  let candidates: WorkspaceMember[] = [];
  if (can('workspace:transfer')) {
    const members = await withApi((api) => api.listMembers(workspaceId)).catch((error: unknown) =>
      handleApiFailure(error, `/workspaces/${workspaceId}/settings`),
    );
    candidates = members.filter((m) => !m.isCurrentUser);
  }

  const ownerActions =
    can('workspace:transfer') || can('workspace:archive') || can('workspace:delete');

  return (
    <>
      {can('workspace:update') ? <GeneralSettings workspace={workspace} /> : null}

      {ownerActions ? (
        <SettingsSection
          id="danger-zone"
          title="Danger zone"
          description="Owner-only actions. Each one is recorded in the audit log."
          tone="danger"
        >
          <div className="flex flex-col divide-y [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
            {can('workspace:transfer') ? (
              <TransferOwnership workspace={workspace} candidates={candidates} />
            ) : null}
            {can('workspace:archive') ? <ArchiveSettings workspace={workspace} /> : null}
            {can('workspace:delete') ? <DeleteWorkspace workspace={workspace} /> : null}
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}
