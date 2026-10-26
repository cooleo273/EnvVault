import type { Metadata } from 'next';
import { EyeOff } from 'lucide-react';
import { EmptyState } from '@/components/feedback/states';
import { ReadinessReport } from '@/features/intelligence/readiness-report';
import { withApi } from '@/lib/api/server-api';
import { getEnvironment } from '@/lib/projects/server';

export const metadata: Metadata = { title: 'Readiness' };

/** Readiness dashboard. The first evaluation never decrypts values. */
export default async function ReadinessPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string; environmentId: string }>;
}) {
  const { workspaceId, projectId, environmentId } = await params;
  const environment = await getEnvironment(workspaceId, projectId, environmentId);
  if (!environment.permissions.includes('secret:list')) {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState
          icon={EyeOff}
          title="You cannot check this environment"
          description="Readiness needs secret:list on this environment."
        />
      </div>
    );
  }
  const initial = await withApi((api) =>
    api.evaluateReadiness(workspaceId, projectId, environmentId, { inspectValues: false }),
  ).catch(() => null);
  return (
    <section aria-labelledby="readiness-heading" className="flex flex-col gap-3">
      <h3 id="readiness-heading" className="text-sm font-semibold">
        Readiness
      </h3>
      <ReadinessReport
        workspaceId={workspaceId}
        projectId={projectId}
        environmentId={environmentId}
        initial={initial}
        canInspectValues={environment.permissions.includes('secret:read')}
      />
    </section>
  );
}
