import type { SnapshotSummary } from '@envvault/shared';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SnapshotDetails } from '@/features/intelligence/snapshot-details';
import { isApiError, withApi } from '@/lib/api/server-api';
import { environmentPath, getEnvironment } from '@/lib/projects/server';

export const metadata: Metadata = { title: 'Snapshot' };

export default async function SnapshotPage({
  params,
}: {
  params: Promise<{
    workspaceId: string;
    projectId: string;
    environmentId: string;
    snapshotId: string;
  }>;
}) {
  const { workspaceId, projectId, environmentId, snapshotId } = await params;
  const environment = await getEnvironment(workspaceId, projectId, environmentId);
  const snapshot = await withApi((api) =>
    api.getSnapshot(workspaceId, projectId, environmentId, snapshotId),
  ).catch((error: unknown) => {
    if (isApiError(error) && (error.statusCode === 404 || error.statusCode === 403)) notFound();
    throw error;
  });
  const [diff, others] = await Promise.all([
    withApi((api) => api.snapshotDiff(workspaceId, projectId, environmentId, snapshotId, {})).catch(
      () => null,
    ),
    withApi((api) => api.listSnapshots(workspaceId, projectId, environmentId, { pageSize: 50 }))
      .then((r) => r.items.filter((s) => s.id !== snapshotId))
      .catch(() => [] as SnapshotSummary[]),
  ]);
  const can = (p: string) => environment.permissions.includes(p);
  return (
    <section aria-labelledby="snapshot-heading" className="flex flex-col gap-3">
      <Link
        href={`${environmentPath(workspaceId, projectId, environmentId)}/snapshots`}
        className="focus-ring inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        All snapshots
      </Link>
      <h3 id="snapshot-heading" className="text-sm font-semibold">
        Snapshot
      </h3>
      <SnapshotDetails
        ids={{ workspaceId, projectId, environmentId }}
        snapshot={snapshot}
        others={others}
        initialDiff={diff}
        canCompareValues={can('secret:read')}
        canRestore={
          can('secret:write') && can('secret:rollback') && environment.status === 'ACTIVE'
        }
      />
    </section>
  );
}
