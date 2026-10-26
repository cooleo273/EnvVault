import type { Metadata } from 'next';
import { MachineIdentityListView } from '@/features/machines/machine-list';
import { withApi } from '@/lib/api/server-api';
import { getProject, projectPath } from '@/lib/projects/server';
import { handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Machine identities' };

export default async function MachineIdentitiesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const project = await getProject(workspaceId, projectId);
  const canManage =
    project.permissions.includes('service_identity:manage') && project.status === 'ACTIVE';
  const [list, environments] = await withApi((api) =>
    Promise.all([
      api.listMachineIdentities(workspaceId, projectId),
      api.listEnvironments(workspaceId, projectId, { pageSize: 200 }),
    ]),
  ).catch((error: unknown) =>
    handleApiFailure(error, `${projectPath(workspaceId, projectId)}/machines`),
  );
  return (
    <MachineIdentityListView
      workspaceId={workspaceId}
      projectId={projectId}
      list={list}
      environments={environments.items}
      canManage={canManage}
    />
  );
}
