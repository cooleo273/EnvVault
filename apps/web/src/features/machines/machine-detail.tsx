'use client';

import type {
  EnvironmentSummary,
  IssuedServiceCredential,
  MachineActivityPage,
  MachineIdentityList,
  MachineIdentitySummary,
  ServiceCredential,
} from '@envvault/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { SettingsSection } from '@/components/layout/settings-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/textarea';
import {
  grantMachineAccessAction,
  issueServiceCredentialAction,
  machineActivityAction,
  removeMachineGrantAction,
  retireMachineIdentityAction,
  revokeServiceCredentialAction,
  rotateServiceCredentialAction,
  setMachineIdentityEnabledAction,
  updateMachineIdentityAction,
} from './actions';
import {
  CredentialReveal,
  CredentialStatus,
  effectiveAccess,
  SCOPE_LABELS,
  useStepUp,
  when,
} from './shared';

interface Props {
  workspaceId: string;
  projectId: string;
  identity: MachineIdentitySummary;
  credentials: ServiceCredential[];
  activity: MachineActivityPage;
  environments: EnvironmentSummary[];
  roles: MachineIdentityList['roles'];
  canManage: boolean;
}

/** One machine identity: what it can reach, its credentials, and what it did. */
export function MachineIdentityDetail(props: Props) {
  const { identity, canManage } = props;
  const live = identity.status !== 'RETIRED';
  return (
    <div className="flex flex-col gap-4">
      <AccessSection {...props} canManage={canManage && live} />
      <CredentialSection {...props} canManage={canManage && live} />
      <ActivitySection {...props} />
      {canManage && live ? <LifecycleSection {...props} /> : null}
    </div>
  );
}

function AccessSection({
  workspaceId,
  projectId,
  identity,
  environments,
  roles,
  canManage,
}: Props) {
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [environmentId, setEnvironmentId] = useState('');
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? '');
  const [effect, setEffect] = useState<'ALLOW' | 'DENY'>('ALLOW');
  const [pending, setPending] = useState(false);
  const access = effectiveAccess(identity.grants);

  async function add() {
    setPending(true);
    try {
      await run(
        () =>
          grantMachineAccessAction(workspaceId, projectId, identity.id, {
            environmentId,
            roleKey,
            effect,
          }),
        (_data, message) => {
          notify.success(message ?? 'Access updated.');
          setEnvironmentId('');
          router.refresh();
        },
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsSection
      id="machine-access"
      title="Environment access"
      description="Exactly what this identity can do, per environment. It inherits nothing from project roles or from the person who created it."
    >
      <div className="flex flex-col gap-4">
        {access.length === 0 ? (
          <EmptyState title="No environment access" className="py-4" />
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Effective access</caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Environment</th>
                <th className="py-1 font-medium">Allowed operations</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {access.map((a) => (
                <tr key={a.environment.id}>
                  <td className="py-2">
                    {a.environment.name}
                    {a.environment.isProtected ? (
                      <StatusBadge tone="warning" label="protected" className="ml-2" dot={false} />
                    ) : null}
                  </td>
                  <td className="py-2">
                    {a.permissions.length === 0
                      ? 'Nothing (denied)'
                      : a.permissions.map((p) => SCOPE_LABELS[p] ?? p).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {identity.grants.length > 0 ? (
          <ul className="divide-y rounded-md border" aria-label="Grants">
            {identity.grants.map((g) => (
              <li key={g.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center">
                <span className="flex-1 text-sm">
                  <StatusBadge
                    tone={g.effect === 'DENY' ? 'danger' : 'success'}
                    label={g.effect.toLowerCase()}
                    dot={false}
                    className="mr-2"
                  />
                  {g.role.name} on {g.environment.name}
                  <span className="block text-xs text-muted-foreground">
                    by {g.createdBy?.email ?? 'a removed user'}, {when(g.createdAt)}
                    {g.expiresAt ? `, until ${when(g.expiresAt)}` : ''}
                  </span>
                </span>
                {canManage ? (
                  <ConfirmDialog
                    title="Remove this grant?"
                    description={
                      g.effect === 'DENY'
                        ? 'Lifting a DENY widens access, so it asks for your password.'
                        : 'The identity loses this access on its next request.'
                    }
                    confirmLabel="Remove"
                    destructive={g.effect === 'ALLOW'}
                    trigger={
                      <Button variant="ghost" size="sm">
                        Remove
                      </Button>
                    }
                    onConfirm={async () => {
                      await run(
                        () => removeMachineGrantAction(workspaceId, projectId, identity.id, g.id),
                        (_data, message) => {
                          notify.success(message ?? 'Removed.');
                          router.refresh();
                        },
                      );
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {canManage ? (
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <FormField label="Environment">
              {(control) => (
                <NativeSelect
                  {...control}
                  value={environmentId}
                  onChange={(e) => {
                    setEnvironmentId(e.target.value);
                  }}
                >
                  <option value="">Choose…</option>
                  {environments
                    .filter((env) => env.status === 'ACTIVE')
                    .map((env) => (
                      <option key={env.id} value={env.id}>
                        {env.name}
                        {env.isProtected ? ' (protected)' : ''}
                      </option>
                    ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Role">
              {(control) => (
                <NativeSelect
                  {...control}
                  value={roleKey}
                  onChange={(e) => {
                    setRoleKey(e.target.value);
                  }}
                >
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Effect">
              {(control) => (
                <NativeSelect
                  {...control}
                  value={effect}
                  onChange={(e) => {
                    setEffect(e.target.value === 'DENY' ? 'DENY' : 'ALLOW');
                  }}
                >
                  <option value="ALLOW">Allow</option>
                  <option value="DENY">Deny</option>
                </NativeSelect>
              )}
            </FormField>
            <Button type="submit" disabled={pending || environmentId === '' || roleKey === ''}>
              Add
            </Button>
          </form>
        ) : null}
        {dialog}
      </div>
    </SettingsSection>
  );
}

function CredentialSection({ workspaceId, projectId, identity, credentials, canManage }: Props) {
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedServiceCredential | null>(null);
  const [rotating, setRotating] = useState<ServiceCredential | null>(null);
  const [overlap, setOverlap] = useState('24');
  const [name, setName] = useState('ci');
  const [scopes, setScopes] = useState<string[]>([
    'environment:read',
    'secret:list',
    'secret:runtime',
  ]);
  const [days, setDays] = useState(String(Math.min(30, identity.credentialMaxLifetimeDays)));
  const [pending, setPending] = useState(false);
  const usable = identity.status === 'ACTIVE';

  async function act(action: () => Promise<unknown>) {
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsSection
      id="machine-credentials"
      title="Credentials"
      description="A credential is shown once, when it is created or rotated. EnvVault stores only a keyed digest of it."
    >
      <div className="flex flex-col gap-3">
        {credentials.length === 0 ? (
          <EmptyState title="No credentials" className="py-4" />
        ) : (
          <ul className="divide-y rounded-md border" aria-label="Credentials">
            {credentials.map((c) => {
              const working = c.status === 'ACTIVE' || c.status === 'EXPIRING';
              return (
                <li
                  key={c.id}
                  className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {c.name}
                      <CredentialStatus status={c.status} />
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {c.displayPrefix}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {c.scopes.map((s) => SCOPE_LABELS[s] ?? s).join(', ')} · expires{' '}
                      {when(c.expiresAt)} · last used {when(c.lastUsedAt)}
                      {c.revocationReason ? ` · revoked: ${c.revocationReason}` : ''}
                    </span>
                  </div>
                  {canManage && working ? (
                    <div className="flex gap-1">
                      {c.status === 'ACTIVE' && usable ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setRotating(c);
                          }}
                        >
                          Rotate
                        </Button>
                      ) : null}
                      <ConfirmDialog
                        title={`Revoke ${c.name}?`}
                        description="Every pipeline using it fails on its next request. This cannot be undone."
                        confirmLabel="Revoke"
                        destructive
                        trigger={
                          <Button variant="ghost" size="sm">
                            Revoke
                          </Button>
                        }
                        onConfirm={async () => {
                          await run(
                            () =>
                              revokeServiceCredentialAction(
                                workspaceId,
                                projectId,
                                identity.id,
                                c.id,
                                undefined,
                              ),
                            (_data, message) => {
                              notify.success(message ?? 'Revoked.');
                              router.refresh();
                            },
                          );
                        }}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {canManage ? (
          <div>
            <Button
              disabled={!usable}
              onClick={() => {
                setIssuing(true);
              }}
            >
              New credential
            </Button>
            {!usable ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Enable the identity to issue credentials.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <ResponsiveModal
        open={issuing || issued !== null}
        onOpenChange={(next) => {
          if (!next && !issued && !pending) setIssuing(false);
        }}
        title={issued ? 'Store the credential' : 'New credential'}
      >
        {issued ? (
          <CredentialReveal
            issued={issued}
            onDone={() => {
              setIssued(null);
              setIssuing(false);
              router.refresh();
            }}
          />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() =>
                run(
                  () =>
                    issueServiceCredentialAction(workspaceId, projectId, identity.id, {
                      name,
                      scopes,
                      expiresInDays: Number(days),
                    }),
                  (data) => {
                    setIssued(data);
                  },
                ),
              );
            }}
          >
            <FormField label="Name" required>
              {(control) => (
                <Input
                  {...control}
                  value={name}
                  maxLength={100}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                />
              )}
            </FormField>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Scopes</legend>
              {Object.entries(SCOPE_LABELS).map(([scope, label]) => (
                <label key={scope} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={scopes.includes(scope)}
                    onChange={(e) => {
                      setScopes((list) =>
                        e.target.checked ? [...list, scope] : list.filter((s) => s !== scope),
                      );
                    }}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <FormField
              label="Expires after (days)"
              description={`At most ${String(identity.credentialMaxLifetimeDays)} days for this identity.`}
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={1}
                  max={identity.credentialMaxLifetimeDays}
                  value={days}
                  onChange={(e) => {
                    setDays(e.target.value);
                  }}
                />
              )}
            </FormField>
            <div className="flex justify-end">
              <Button type="submit" disabled={pending || scopes.length === 0} aria-busy={pending}>
                Create credential
              </Button>
            </div>
          </form>
        )}
      </ResponsiveModal>

      <ResponsiveModal
        open={rotating !== null}
        onOpenChange={(next) => {
          if (!next && !pending) setRotating(null);
        }}
        title={`Rotate ${rotating?.name ?? ''}`}
        description="A replacement with the same scopes is issued. The old credential keeps working for the overlap, so you can update your pipelines without downtime."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const target = rotating;
            if (!target) return;
            void act(() =>
              run(
                () =>
                  rotateServiceCredentialAction(workspaceId, projectId, identity.id, target.id, {
                    overlapHours: Number(overlap),
                  }),
                (data) => {
                  setRotating(null);
                  setIssued(data);
                },
              ),
            );
          }}
        >
          <FormField label="Old credential keeps working for">
            {(control) => (
              <NativeSelect
                {...control}
                value={overlap}
                onChange={(e) => {
                  setOverlap(e.target.value);
                }}
              >
                <option value="0">No overlap (ends now)</option>
                <option value="1">1 hour</option>
                <option value="24">24 hours</option>
                <option value="72">3 days</option>
                <option value="168">7 days</option>
              </NativeSelect>
            )}
          </FormField>
          <div className="flex justify-end">
            <Button type="submit" disabled={pending} aria-busy={pending}>
              Rotate
            </Button>
          </div>
        </form>
      </ResponsiveModal>
      {dialog}
    </SettingsSection>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'machine_identity.created': 'Identity created',
  'machine_identity.updated': 'Identity changed',
  'machine_identity.disabled': 'Identity disabled',
  'machine_identity.enabled': 'Identity enabled',
  'machine_identity.retired': 'Identity retired',
  'machine_identity.grant_added': 'Access granted',
  'machine_identity.grant_removed': 'Access removed',
  'machine.grant_refused': 'Grant refused (beyond the granter’s access)',
  'service_credential.created': 'Credential issued',
  'service_credential.rotated': 'Credential rotated',
  'service_credential.revoked': 'Credential revoked',
  'machine.authenticated': 'Authenticated',
  'machine.authentication_failed': 'Authentication failed',
  'machine.token_rejected': 'Token rejected',
  'machine.token_revoked': 'Token ended',
  'machine.access_denied': 'Access denied',
  'secret.runtime_loaded': 'Values loaded at runtime',
  'security.rate_limited': 'Rate limited',
};

function ActivitySection({ workspaceId, projectId, identity, activity, environments }: Props) {
  const [items, setItems] = useState(activity.items);
  const [cursor, setCursor] = useState(activity.nextCursor);
  const [loading, setLoading] = useState(false);
  const envName = (id: string | null) => environments.find((e) => e.id === id)?.name;
  return (
    <SettingsSection
      id="machine-activity"
      title="Activity"
      description="Authentications, runtime loads and changes, newest first. Never values or tokens."
    >
      {items.length === 0 ? (
        <EmptyState title="No activity yet" className="py-4" />
      ) : (
        <ul className="divide-y rounded-md border" aria-label="Activity">
          {items.map((e) => (
            <li
              key={e.id}
              className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-center"
            >
              <span className="flex-1">
                {ACTION_LABELS[e.action] ?? e.action}
                {e.outcome !== 'SUCCESS' ? (
                  <StatusBadge
                    tone="danger"
                    label={e.outcome.toLowerCase()}
                    dot={false}
                    className="ml-2"
                  />
                ) : null}
                {envName(e.environmentId) ? (
                  <span className="text-muted-foreground"> · {envName(e.environmentId)}</span>
                ) : null}
                {typeof e.metadata.reason === 'string' ? (
                  <span className="text-muted-foreground">
                    {' '}
                    · {e.metadata.reason.replace(/_/g, ' ')}
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {e.actor.kind === 'user'
                  ? e.actor.email
                  : e.actor.kind === 'machine'
                    ? identity.name
                    : 'system'}{' '}
                · {when(e.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void machineActivityAction(workspaceId, projectId, identity.id, cursor)
              .then((result) => {
                if (result.ok) {
                  setItems((list) => [...list, ...result.data.items]);
                  setCursor(result.data.nextCursor);
                } else notify.error(result.message);
              })
              .finally(() => {
                setLoading(false);
              });
          }}
        >
          Load more
        </Button>
      ) : null}
    </SettingsSection>
  );
}

function LifecycleSection({ workspaceId, projectId, identity }: Props) {
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [name, setName] = useState(identity.name);
  const [saving, setSaving] = useState(false);
  const base = `/workspaces/${workspaceId}/projects/${projectId}/machines`;
  return (
    <SettingsSection id="machine-lifecycle" title="Identity" tone="danger">
      <div className="flex flex-col gap-4">
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setSaving(true);
            void updateMachineIdentityAction(workspaceId, projectId, identity.id, { name })
              .then((result) => {
                if (result.ok) {
                  notify.success('Saved.');
                  router.refresh();
                } else notify.error(result.message);
              })
              .finally(() => {
                setSaving(false);
              });
          }}
        >
          <FormField label="Name">
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={100}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            )}
          </FormField>
          <Button
            type="submit"
            variant="outline"
            disabled={saving || name.trim() === identity.name}
          >
            Rename
          </Button>
        </form>
        <div className="flex flex-wrap gap-2">
          {identity.status === 'DISABLED' ? (
            <Button
              variant="outline"
              onClick={() =>
                void run(
                  () => setMachineIdentityEnabledAction(workspaceId, projectId, identity.id, true),
                  (_data, message) => {
                    notify.success(message ?? 'Enabled.');
                    router.refresh();
                  },
                )
              }
            >
              Enable
            </Button>
          ) : (
            <ConfirmDialog
              title={`Disable ${identity.name}?`}
              description="All of its access tokens stop working now and new ones cannot be obtained until it is enabled again."
              confirmLabel="Disable"
              trigger={<Button variant="outline">Disable</Button>}
              onConfirm={async () => {
                const result = await setMachineIdentityEnabledAction(
                  workspaceId,
                  projectId,
                  identity.id,
                  false,
                );
                if (!result.ok) {
                  notify.error(result.message);
                  throw new Error(result.message);
                }
                notify.success(result.message ?? 'Disabled.');
                router.refresh();
              }}
            />
          )}
          <ConfirmDialog
            title={`Retire ${identity.name}?`}
            description="Its credentials are revoked and its grants removed for good. Its history stays in the audit log."
            confirmLabel="Retire"
            destructive
            confirmationText={identity.name}
            trigger={<Button variant="destructive">Retire</Button>}
            onConfirm={async () => {
              const result = await retireMachineIdentityAction(workspaceId, projectId, identity.id);
              if (!result.ok) {
                notify.error(result.message);
                throw new Error(result.message);
              }
              notify.success(result.message ?? 'Retired.');
              router.push(base);
            }}
          />
        </div>
        {dialog}
      </div>
    </SettingsSection>
  );
}
