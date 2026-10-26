import type { Metadata } from 'next';
import { ErrorState } from '@/components/feedback/states';
import { GitHubActionsView } from '@/features/integrations/github-actions';
import { withApi } from '@/lib/api/server-api';
import { getProject, projectPath } from '@/lib/projects/server';
import { handleApiFailure } from '@/lib/workspaces/server';
import { serverEnv } from '@/server-env';

export const metadata: Metadata = { title: 'GitHub Actions' };

export default async function GitHubActionsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const project = await getProject(workspaceId, projectId);
  if (!project.permissions.includes('service_identity:read')) {
    return (
      <ErrorState
        title="You cannot view GitHub Actions bindings"
        description="Ask a project admin for access to machine identities."
      />
    );
  }
  const canManage =
    project.permissions.includes('service_identity:manage') && project.status === 'ACTIVE';
  const [list, identities] = await withApi((api) =>
    Promise.all([
      api.listOidcTrustBindings(workspaceId, projectId),
      api.listMachineIdentities(workspaceId, projectId),
    ]),
  ).catch((error: unknown) =>
    handleApiFailure(error, `${projectPath(workspaceId, projectId)}/integrations/github-actions`),
  );
  return (
    <GitHubActionsView
      workspaceId={workspaceId}
      projectId={projectId}
      list={list}
      identities={identities.items}
      apiUrl={serverEnv().NEXT_PUBLIC_API_URL}
      canManage={canManage}
    />
  );
}
