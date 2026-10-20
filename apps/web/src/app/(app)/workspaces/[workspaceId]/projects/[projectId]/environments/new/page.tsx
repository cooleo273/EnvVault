import { DEFAULT_ENVIRONMENT_COLORS } from '@envvault/shared';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/feedback/states';
import { formatExpectedKeys } from '@/features/projects/expected-keys';
import { EnvironmentForm, type EnvironmentFormValues } from '@/features/projects/environment-form';
import { templateChoices } from '@/features/projects/templates';
import { withApi } from '@/lib/api/server-api';
import { getProject, projectPath } from '@/lib/projects/server';
import { handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'New environment' };

export default async function NewEnvironmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{ template?: string }>;
}) {
  const [{ workspaceId, projectId }, query] = await Promise.all([params, searchParams]);
  const project = await getProject(workspaceId, projectId);
  if (!project.permissions.includes('environment:create') || project.status !== 'ACTIVE') {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState
          title="You cannot create environments here"
          description="Ask a project admin."
        />
      </div>
    );
  }
  const templates = await withApi((api) => api.environmentTemplates(workspaceId)).catch(
    (error: unknown) =>
      handleApiFailure(error, `${projectPath(workspaceId, projectId)}/environments/new`),
  );
  const choice = templateChoices(templates).find((c) => c.id === query.template);
  const entry = choice?.entry;
  const initial: EnvironmentFormValues = entry
    ? {
        name: entry.name,
        ...(entry.slug ? { slug: entry.slug } : {}),
        kind: entry.kind,
        description: entry.description ?? '',
        color: entry.color ?? DEFAULT_ENVIRONMENT_COLORS[entry.kind],
        icon: entry.icon ?? null,
        isProtected: entry.isProtected,
        expectedKeys: formatExpectedKeys(entry.expectedKeys),
        templateId: choice.id,
      }
    : {
        name: '',
        kind: 'OTHER',
        description: '',
        color: 'slate',
        icon: null,
        isProtected: false,
        expectedKeys: '',
      };
  return (
    <section aria-labelledby="new-environment" className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 id="new-environment" className="text-base font-semibold">
          New environment{choice ? ` from “${choice.template.name}”` : ''}
        </h2>
        <p className="text-sm text-muted-foreground">Templates never copy secret values.</p>
      </div>
      <div className="rounded-lg border bg-surface p-5">
        <EnvironmentForm
          mode="create"
          workspaceId={workspaceId}
          projectId={projectId}
          initial={initial}
          canProtect={project.permissions.includes('environment:protect')}
        />
      </div>
    </section>
  );
}
