import type { MeResponse } from '@envvault/shared';

export type Landing =
  { kind: 'onboarding' } | { kind: 'workspace'; workspaceId: string; href: string };

/**
 * Where a signed-in user starts. The API already resolved
 * `activeWorkspaceId` against current memberships (a remembered workspace
 * whose access was revoked or archived is dropped), so this only decides
 * between onboarding and a workspace the user can still open.
 */
export function resolveLanding(me: Pick<MeResponse, 'workspaces' | 'activeWorkspaceId'>): Landing {
  const accessible = new Set(me.workspaces.map((w) => w.id));
  const workspaceId =
    me.activeWorkspaceId && accessible.has(me.activeWorkspaceId)
      ? me.activeWorkspaceId
      : me.workspaces[0]?.id;
  if (!workspaceId) return { kind: 'onboarding' };
  return { kind: 'workspace', workspaceId, href: `/workspaces/${workspaceId}` };
}

/** Workspace id from an app path such as `/workspaces/<id>/members`. */
const WORKSPACE_PATH =
  /^\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export function workspaceIdFromPath(pathname: string): string | undefined {
  return WORKSPACE_PATH.exec(pathname)?.[1];
}
