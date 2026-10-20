import { PERMISSIONS, type PermissionKey } from '@envvault/shared';
import { KeyRound } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { getEnvironment } from '@/lib/projects/server';

export const metadata: Metadata = { title: 'Environment' };

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

/**
 * Environment details. The variables area is where the Phase 3 secrets table
 * will live; until then it states plainly that no values exist yet.
 */
export default async function EnvironmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string; environmentId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const [{ workspaceId, projectId, environmentId }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const environment = await getEnvironment(workspaceId, projectId, environmentId);
  const secretPermissions = environment.permissions.filter((p) => p.startsWith('secret:'));

  return (
    <div className="flex flex-col gap-4">
      {query.created ? (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success"
        >
          Environment created.
        </p>
      ) : null}

      <section aria-labelledby="variables-heading" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 id="variables-heading" className="text-sm font-semibold">
            Variables
          </h3>
          <StatusBadge tone="neutral" label="Coming in the next phase" dot={false} />
        </div>
        <div className="rounded-lg border bg-surface">
          <EmptyState
            icon={KeyRound}
            title="No variables have been configured yet"
            description="Secrets management (encrypted values, versions and history) arrives in the next phase. Nothing is stored for this environment today."
          />
          {environment.expectedKeys.length > 0 ? (
            <div className="border-t px-4 py-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Expected keys from the template ({environment.expectedKeys.length}) — names only, no
                values
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {environment.expectedKeys.map((k) => (
                  <li
                    key={k.key}
                    title={k.description}
                    className="rounded-sm border bg-surface-muted px-1.5 py-0.5 font-mono text-xs"
                  >
                    {k.key}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="details-heading" className="rounded-lg border bg-surface">
          <h3 id="details-heading" className="border-b px-4 py-2.5 text-sm font-semibold">
            Details
          </h3>
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2 px-4 py-3 text-sm">
            <dt className="text-muted-foreground">Environment ID</dt>
            <dd className="font-mono text-xs break-all">{environment.id}</dd>
            <dt className="text-muted-foreground">Protection</dt>
            <dd>
              {environment.isProtected
                ? `Protected${environment.requiredApprovals > 0 ? ` · ${String(environment.requiredApprovals)} approval(s) planned` : ''}`
                : 'Not protected'}
            </dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>
              {dateFormat.format(new Date(environment.createdAt))}
              {environment.createdBy
                ? ` by ${environment.createdBy.displayName ?? environment.createdBy.email}`
                : ''}
            </dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{dateFormat.format(new Date(environment.updatedAt))}</dd>
          </dl>
        </section>

        <section aria-labelledby="access-heading" className="rounded-lg border bg-surface">
          <h3 id="access-heading" className="border-b px-4 py-2.5 text-sm font-semibold">
            Your access here
          </h3>
          <div className="flex flex-col gap-2 px-4 py-3">
            <ul className="flex flex-wrap gap-1.5" aria-label="Your effective permissions">
              {environment.permissions.map((p) => (
                <li
                  key={p}
                  title={PERMISSIONS[p as PermissionKey]}
                  className="rounded-sm border px-1.5 py-0.5 font-mono text-2xs"
                >
                  {p}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {environment.isProtected && !secretPermissions.some((p) => p !== 'secret:list')
                ? 'This environment is protected: secret access is never inherited and must be granted explicitly.'
                : 'Effective permissions combine your project role and any grants on this environment.'}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
