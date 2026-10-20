import type { Metadata } from 'next';
import { ProjectMemberManager } from '@/features/projects/project-member-manager';
import { withApi } from '@/lib/api/server-api';
import { getProject, projectPath } from '@/lib/projects/server';
import { handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Project members' };

export default async function ProjectMembersPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const project = await getProject(workspaceId, projectId);
  const canManage =
    project.permissions.includes('project_member:manage') && project.status === 'ACTIVE';
  const [access, roles, workspaceMembers] = await withApi((api) =>
    Promise.all([
      api.projectMembers(workspaceId, projectId),
      api.projectRoles(workspaceId, projectId),
      canManage ? api.listMembers(workspaceId) : Promise.resolve([]),
    ]),
  ).catch((error: unknown) =>
    handleApiFailure(error, `${projectPath(workspaceId, projectId)}/members`),
  );
  return (
    <ProjectMemberManager
      workspaceId={workspaceId}
      projectId={projectId}
      access={access}
      roles={roles.projectRoles}
      workspaceMembers={workspaceMembers}
      canManage={canManage}
    />
  );
}
