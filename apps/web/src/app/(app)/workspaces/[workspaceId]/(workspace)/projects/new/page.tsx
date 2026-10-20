import type { Metadata } from 'next';
import { EmptyState } from '@/components/feedback/states';
import { CreateProjectForm } from '@/features/projects/create-project-form';
import { withApi } from '@/lib/api/server-api';
import { getWorkspace, handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'New project' };

export default async function NewProjectPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const workspace = await getWorkspace(workspaceId);
  if (!workspace.permissions.includes('project:create') || workspace.archivedAt) {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState title="You cannot create projects here" description="Ask a workspace admin." />
      </div>
    );
  }
  const templates = await withApi((api) => api.environmentTemplates(workspaceId)).catch(
    (error: unknown) => handleApiFailure(error, `/workspaces/${workspaceId}/projects/new`),
  );
  return (
    <>
      <h2 className="text-base font-semibold">New project</h2>
      <CreateProjectForm workspaceId={workspaceId} templates={templates} />
    </>
  );
}
