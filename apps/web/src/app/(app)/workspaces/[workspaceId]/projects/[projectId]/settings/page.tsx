import type { Metadata } from 'next';
import { EmptyState } from '@/components/feedback/states';
import { ProjectGeneralSettings, ProjectLifecycle } from '@/features/projects/project-settings';
import { getProject } from '@/lib/projects/server';
import { getWorkspace } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Project settings' };

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const [workspace, project] = await Promise.all([
    getWorkspace(workspaceId),
    getProject(workspaceId, projectId),
  ]);
  const can = (p: string) => project.permissions.includes(p);
  if (!can('project:update') && !can('project:archive') && !can('project:delete')) {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState title="You cannot change project settings" description="Ask a project admin." />
      </div>
    );
  }
  return (
    <>
      <ProjectGeneralSettings workspaceId={workspaceId} project={project} />
      <ProjectLifecycle
        workspaceId={workspaceId}
        project={project}
        canDuplicate={workspace.permissions.includes('project:create') && !workspace.archivedAt}
      />
    </>
  );
}
