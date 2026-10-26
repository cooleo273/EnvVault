import { ChevronRight, Workflow } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ErrorState } from '@/components/feedback/states';
import { getProject, projectPath } from '@/lib/projects/server';

export const metadata: Metadata = { title: 'Integrations' };

export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const project = await getProject(workspaceId, projectId);
  if (!project.permissions.includes('service_identity:read')) {
    return (
      <ErrorState
        title="You cannot view integrations"
        description="Integrations are managed by people who can see this project's machine identities."
      />
    );
  }
  return (
    <section aria-labelledby="integrations-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="integrations-heading" className="text-base font-semibold">
          Integrations
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Connect delivery systems to this project. Each one authenticates as a machine identity and
          reaches only the environments granted to it.
        </p>
      </div>
      <ul className="divide-y rounded-md border" aria-label="Integrations">
        <li>
          <Link
            href={`${projectPath(workspaceId, projectId)}/integrations/github-actions`}
            className="focus-ring flex items-center gap-3 px-3 py-3 hover:bg-muted"
          >
            <Workflow aria-hidden="true" className="size-5 shrink-0" />
            <span className="flex flex-1 flex-col">
              <span className="text-sm font-medium">GitHub Actions</span>
              <span className="text-xs text-muted-foreground">
                Workflows authenticate with GitHub OIDC tokens; no credential stored in GitHub.
              </span>
            </span>
            <ChevronRight aria-hidden="true" className="size-4" />
          </Link>
        </li>
      </ul>
    </section>
  );
}
