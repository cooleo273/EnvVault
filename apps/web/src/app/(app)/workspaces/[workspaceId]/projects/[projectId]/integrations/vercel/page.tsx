import type { Metadata } from 'next';
import { ErrorState } from '@/components/feedback/states';
import { type ConnectionData, VercelView } from '@/features/integrations/vercel';
import { withApi } from '@/lib/api/server-api';
import { getProject, projectPath } from '@/lib/projects/server';
import { handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Vercel' };

export default async function VercelPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const project = await getProject(workspaceId, projectId);
  if (!project.permissions.includes('integration:read')) {
    return (
      <ErrorState
        title="You cannot view this integration"
        description="Ask a project admin for access to this project's integrations."
      />
    );
  }
  const canManage =
    project.permissions.includes('integration:manage') && project.status === 'ACTIVE';
  const { connections, environments } = await withApi(async (api) => {
    const [list, envs] = await Promise.all([
      api.listIntegrations(workspaceId, projectId),
      api.listEnvironments(workspaceId, projectId, { pageSize: 200 }),
    ]);
    const data: ConnectionData[] = await Promise.all(
      list.items
        .filter((c) => c.status !== 'DISCONNECTED')
        .map(async (connection) => {
          const [mappings, jobs] = await Promise.all([
            connection.linkedProject
              ? api.integrationMappings(workspaceId, projectId, connection.id)
              : Promise.resolve([]),
            api.syncJobs(workspaceId, projectId, connection.id),
          ]);
          return { connection, mappings, jobs: jobs.items };
        }),
    );
    return { connections: data, environments: envs.items.filter((e) => e.status === 'ACTIVE') };
  }).catch((error: unknown) =>
    handleApiFailure(error, `${projectPath(workspaceId, projectId)}/integrations/vercel`),
  );
  return (
    <VercelView
      workspaceId={workspaceId}
      projectId={projectId}
      connections={connections}
      environments={environments}
      canManage={canManage}
    />
  );
}
