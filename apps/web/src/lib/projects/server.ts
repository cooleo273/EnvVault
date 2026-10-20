import 'server-only';
import type { EnvironmentDetail, ProjectDetail } from '@envvault/shared';
import { cache } from 'react';
import { withApi } from '@/lib/api/server-api';
import { handleApiFailure } from '@/lib/workspaces/server';

export function projectPath(workspaceId: string, projectId: string): string {
  return `/workspaces/${workspaceId}/projects/${projectId}`;
}

export function environmentPath(
  workspaceId: string,
  projectId: string,
  environmentId: string,
): string {
  return `${projectPath(workspaceId, projectId)}/environments/${environmentId}`;
}

/** Project detail for the caller, deduplicated per request (404 when not visible). */
export const getProject = cache(
  async (workspaceId: string, projectId: string): Promise<ProjectDetail> => {
    try {
      return await withApi((api) => api.getProject(workspaceId, projectId));
    } catch (error) {
      handleApiFailure(error, projectPath(workspaceId, projectId));
    }
  },
);

/** Environment detail with the caller's effective permissions (404 when not visible). */
export const getEnvironment = cache(
  async (
    workspaceId: string,
    projectId: string,
    environmentId: string,
  ): Promise<EnvironmentDetail> => {
    try {
      return await withApi((api) => api.getEnvironment(workspaceId, projectId, environmentId));
    } catch (error) {
      handleApiFailure(error, environmentPath(workspaceId, projectId, environmentId));
    }
  },
);
