import {
  type EffectiveConfiguration,
  type EnvironmentSummary,
  PERMISSIONS,
  type PermissionKey,
  SECRET_SORTS,
  SECRET_TYPES,
  type SecretList,
  type SecretType,
} from '@envvault/shared';
import { EyeOff } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/feedback/states';
import { InheritedVariables } from '@/features/intelligence/inherited-variables';
import { VariablesPanel } from '@/features/secrets/variables-panel';
import { withApi } from '@/lib/api/server-api';
import { environmentPath, getEnvironment } from '@/lib/projects/server';

export const metadata: Metadata = { title: 'Environment' };

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

type SearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const list = (value: string | string[] | undefined) =>
  (one(value) ?? '').split(',').filter(Boolean);

/**
 * Environment overview: the variables table (one page of metadata from the
 * API; values are fetched one at a time on reveal) and environment details.
 */
export default async function EnvironmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string; environmentId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ workspaceId, projectId, environmentId }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const environment = await getEnvironment(workspaceId, projectId, environmentId);
  const secretPermissions = environment.permissions.filter((p) => p.startsWith('secret:'));
  const canList = environment.permissions.includes('secret:list');

  let secrets: SecretList | null = null;
  let missingKeys: string[] = [];
  let environments: EnvironmentSummary[] = [];
  let effective: EffectiveConfiguration | null = null;
  if (canList) {
    const page = Math.max(1, Number.parseInt(one(query.page) ?? '1', 10) || 1);
    const sort = SECRET_SORTS.find((s) => s === one(query.sort)) ?? 'name';
    const types = list(query.type).filter((t): t is SecretType =>
      (SECRET_TYPES as readonly string[]).includes(t),
    );
    const [current, live, siblings, resolved] = await Promise.all([
      withApi((api) =>
        api.listSecrets(workspaceId, projectId, environmentId, {
          page,
          pageSize: 50,
          sort,
          status: one(query.status) === 'deleted' ? 'deleted' : 'active',
          ...(one(query.q) ? { q: one(query.q) } : {}),
          ...(types.length ? { type: types } : {}),
          ...(list(query.category).length ? { category: list(query.category) } : {}),
          ...(one(query.tag) ? { tag: one(query.tag) } : {}),
        }),
      ).catch(() => null),
      // Template keys are compared with the live names, independent of the filters on screen.
      environment.expectedKeys.length > 0
        ? withApi((api) =>
            api.listSecrets(workspaceId, projectId, environmentId, { pageSize: 100 }),
          ).catch(() => null)
        : Promise.resolve(null),
      // Export can target another environment; the API decides which are allowed.
      withApi((api) => api.listEnvironments(workspaceId, projectId, { pageSize: 200 }))
        .then((r) => r.items)
        .catch(() => [] as EnvironmentSummary[]),
      environment.baseEnvironmentId
        ? withApi((api) => api.effectiveConfiguration(workspaceId, projectId, environmentId)).catch(
            () => null,
          )
        : Promise.resolve(null),
    ]);
    secrets = current;
    environments = siblings;
    effective = resolved;
    if (live && live.total <= live.items.length) {
      const names = new Set(live.items.map((s) => s.key));
      missingKeys = environment.expectedKeys.map((k) => k.key).filter((k) => !names.has(k));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {one(query.created) ? (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success"
        >
          Environment created.
        </p>
      ) : null}

      {canList ? (
        <VariablesPanel
          workspaceId={workspaceId}
          projectId={projectId}
          environmentId={environmentId}
          list={secrets}
          permissions={environment.permissions}
          isProtected={environment.isProtected}
          archived={environment.status === 'ARCHIVED'}
          missingKeys={missingKeys}
          environmentName={environment.name}
          environments={environments.map((e) => ({
            id: e.id,
            name: e.name,
            isProtected: e.isProtected,
          }))}
          {...(effective?.base
            ? {
                overrides: {
                  baseName:
                    effective.base.state === 'no_access'
                      ? 'Restricted environment'
                      : effective.base.name,
                  keys: effective.items.filter((i) => i.overridesInherited).map((i) => i.key),
                },
              }
            : {})}
        />
      ) : (
        <section aria-labelledby="variables-heading" className="flex flex-col gap-2">
          <h3 id="variables-heading" className="text-sm font-semibold">
            Variables
          </h3>
          <div className="rounded-lg border bg-surface">
            <EmptyState
              icon={EyeOff}
              title="You cannot see this environment's variables"
              description="Ask a project admin for a project role or an environment grant that includes secret:list."
            />
          </div>
        </section>
      )}

      {effective?.base ? (
        <InheritedVariables
          ids={{ workspaceId, projectId, environmentId }}
          configuration={effective}
          baseHref={environmentPath(workspaceId, projectId, effective.base.id)}
          canOverride={
            environment.permissions.includes('secret:write') && environment.status === 'ACTIVE'
          }
          knownKeys={effective.items.map((i) => i.key)}
        />
      ) : null}

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
