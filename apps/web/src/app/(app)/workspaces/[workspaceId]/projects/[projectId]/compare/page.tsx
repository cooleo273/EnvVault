import type { EnvironmentComparison as Comparison, EnvironmentSummary } from '@envvault/shared';
import { GitCompare } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/feedback/states';
import { EnvironmentComparison } from '@/features/intelligence/environment-comparison';
import { withApi } from '@/lib/api/server-api';

export const metadata: Metadata = { title: 'Compare environments' };

const one = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

/** Environment comparison. The first view is metadata only, rendered on the server. */
export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceId, projectId }, query] = await Promise.all([params, searchParams]);
  const environments = await withApi((api) =>
    api.listEnvironments(workspaceId, projectId, { status: 'all', pageSize: 200 }),
  )
    .then((r) => r.items)
    .catch(() => [] as EnvironmentSummary[]);
  if (environments.length < 2) {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState
          icon={GitCompare}
          title="Two environments are needed"
          description="Create another environment to compare them."
        />
      </div>
    );
  }
  const ids = environments.map((e) => e.id);
  const source = ids.find((id) => id === one(query.source)) ?? ids[0] ?? '';
  const target =
    ids.find((id) => id === one(query.target) && id !== source) ??
    ids.find((id) => id !== source) ??
    '';
  const initial: Comparison | null = await withApi((api) =>
    api.compareEnvironments(workspaceId, projectId, {
      sourceEnvironmentId: source,
      targetEnvironmentId: target,
      pageSize: 100,
    }),
  ).catch(() => null);

  return (
    <section aria-labelledby="compare-heading" className="flex flex-col gap-3">
      <h2 id="compare-heading" className="text-sm font-semibold">
        Compare environments
      </h2>
      <EnvironmentComparison
        key={`${source}:${target}`}
        workspaceId={workspaceId}
        projectId={projectId}
        environments={environments.map((e) => ({
          id: e.id,
          name: e.name,
          isProtected: e.isProtected,
        }))}
        initial={initial}
        sourceId={source}
        targetId={target}
      />
    </section>
  );
}
