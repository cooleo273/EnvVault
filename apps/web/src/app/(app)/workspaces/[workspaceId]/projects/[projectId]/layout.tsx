import { ProjectHeader } from '@/features/projects/project-header';
import { withApi } from '@/lib/api/server-api';
import { getProject } from '@/lib/projects/server';
import { getWorkspace } from '@/lib/workspaces/server';

/**
 * Frame for every project page. The API returns 404 for projects the caller
 * cannot see (including ids from other workspaces), which renders not-found.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const [workspace, project] = await Promise.all([
    getWorkspace(workspaceId),
    getProject(workspaceId, projectId),
  ]);
  // "Recently opened" bookkeeping; never blocks or fails the page.
  void withApi((api) => api.recordProjectVisit(workspaceId, projectId)).catch(() => undefined);
  return (
    <>
      <ProjectHeader workspace={workspace} project={project} />
      {children}
    </>
  );
}
