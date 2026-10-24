import type { Metadata } from 'next';
import Link from 'next/link';
import { MachineIdentityDetail } from '@/features/machines/machine-detail';
import { when } from '@/features/machines/format';
import { IdentityStatus } from '@/features/machines/shared';
import { withApi } from '@/lib/api/server-api';
import { getProject, projectPath } from '@/lib/projects/server';
import { handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Machine identity' };

export default async function MachineIdentityPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string; identityId: string }>;
}) {
  const { workspaceId, projectId, identityId } = await params;
  const project = await getProject(workspaceId, projectId);
  const canManage =
    project.permissions.includes('service_identity:manage') && project.status === 'ACTIVE';
  const base = `${projectPath(workspaceId, projectId)}/machines`;
  const [identity, credentials, activity, environments, list] = await withApi((api) =>
    Promise.all([
      api.machineIdentity(workspaceId, projectId, identityId),
      api.serviceCredentials(workspaceId, projectId, identityId),
      api.machineIdentityActivity(workspaceId, projectId, identityId),
      api.listEnvironments(workspaceId, projectId, { pageSize: 200 }),
      api.listMachineIdentities(workspaceId, projectId),
    ]),
  ).catch((error: unknown) => handleApiFailure(error, `${base}/${identityId}`));
  return (
    <section aria-labelledby="machine-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link href={base} className="text-xs text-muted-foreground hover:underline">
          Machine identities
        </Link>
        <h2 id="machine-heading" className="flex items-center gap-2 text-base font-semibold">
          {identity.name}
          <IdentityStatus status={identity.status} />
        </h2>
        {identity.description ? (
          <p className="text-sm text-muted-foreground">{identity.description}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Created by {identity.createdBy?.email ?? 'a removed user'} on {when(identity.createdAt)} ·
          last authenticated {when(identity.lastAuthenticatedAt)} · last used{' '}
          {when(identity.lastUsedAt)}
          {identity.expiresAt ? ` · expires ${when(identity.expiresAt)}` : ''}
          {identity.disabledReason ? ` · disabled: ${identity.disabledReason}` : ''}
        </p>
      </div>
      <MachineIdentityDetail
        workspaceId={workspaceId}
        projectId={projectId}
        identity={identity}
        credentials={credentials}
        activity={activity}
        environments={environments.items}
        roles={list.roles}
        canManage={canManage}
      />
    </section>
  );
}
