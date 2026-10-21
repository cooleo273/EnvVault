import { EyeOff } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { SnapshotList } from '@/features/intelligence/snapshot-list';
import { withApi } from '@/lib/api/server-api';
import { getEnvironment } from '@/lib/projects/server';

export const metadata: Metadata = { title: 'Snapshots' };

export default async function SnapshotsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string; environmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceId, projectId, environmentId }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const environment = await getEnvironment(workspaceId, projectId, environmentId);
  if (!environment.permissions.includes('secret:list')) {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState
          icon={EyeOff}
          title="You cannot see snapshots here"
          description="Snapshots need secret:list on this environment."
        />
      </div>
    );
  }
  const page = Math.max(
    1,
    Number.parseInt(typeof query.page === 'string' ? query.page : '1', 10) || 1,
  );
  const snapshots = await withApi((api) =>
    api.listSnapshots(workspaceId, projectId, environmentId, { page, pageSize: 20 }),
  ).catch(() => null);
  return (
    <section aria-labelledby="snapshots-heading" className="flex flex-col gap-3">
      <h3 id="snapshots-heading" className="text-sm font-semibold">
        Snapshots
      </h3>
      {snapshots ? (
        <SnapshotList
          workspaceId={workspaceId}
          projectId={projectId}
          environmentId={environmentId}
          page={snapshots}
          canCreate={
            environment.permissions.includes('secret:write') && environment.status === 'ACTIVE'
          }
        />
      ) : (
        <div className="rounded-lg border bg-surface">
          <ErrorState
            title="Snapshots unavailable"
            description="The snapshots could not be loaded."
          />
        </div>
      )}
    </section>
  );
}
