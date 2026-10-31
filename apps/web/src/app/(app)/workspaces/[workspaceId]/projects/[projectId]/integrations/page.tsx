import { ChevronRight, Triangle, Workflow } from 'lucide-react';
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
  const can = (p: string) => project.permissions.includes(p);
  const base = `${projectPath(workspaceId, projectId)}/integrations`;
  const providers = [
    ...(can('service_identity:read')
      ? [
          {
            href: `${base}/github-actions`,
            icon: Workflow,
            name: 'GitHub Actions',
            detail:
              'Workflows authenticate with GitHub OIDC tokens; no credential stored in GitHub.',
          },
        ]
      : []),
    ...(can('integration:read')
      ? [
          {
            href: `${base}/vercel`,
            icon: Triangle,
            name: 'Vercel',
            detail:
              'Copy environments into Vercel environment variables after a previewed, confirmed sync.',
          },
        ]
      : []),
  ];
  if (providers.length === 0) {
    return (
      <ErrorState
        title="You cannot view integrations"
        description="Ask a project admin for access to this project's integrations."
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
          Connect delivery systems to this project. Connecting never grants access to values:
          copying values out of EnvVault needs export permission on each environment.
        </p>
      </div>
      <ul className="divide-y rounded-md border" aria-label="Integrations">
        {providers.map((p) => (
          <li key={p.href}>
            <Link
              href={p.href}
              className="focus-ring flex items-center gap-3 px-3 py-3 hover:bg-muted"
            >
              <p.icon aria-hidden="true" className="size-5 shrink-0" />
              <span className="flex flex-1 flex-col">
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.detail}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
