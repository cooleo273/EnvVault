'use client';

import type {
  EnvironmentSummary,
  IntegrationConnection,
  IntegrationMapping,
  IntegrationTarget,
  ProviderProjectList,
  SyncJob,
  SyncPlan,
} from '@envvault/shared';
import { AlertTriangle, Plus, RefreshCw, Triangle } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/textarea';
import type { StatusTone } from '@/design/tokens';
import { useStepUp, when } from '@/features/machines/shared';
import {
  connectVercelAction,
  createMappingAction,
  customEnvironmentsAction,
  deleteMappingAction,
  disconnectVercelAction,
  linkVercelProjectAction,
  previewSyncAction,
  checkVercelAction,
  runSyncAction,
  setVercelEnabledAction,
  vercelProjectsAction,
} from './vercel-actions';

const STATUS_TONES: Record<IntegrationConnection['status'], StatusTone> = {
  ACTIVE: 'success',
  DISABLED: 'warning',
  ERROR: 'danger',
  DISCONNECTED: 'neutral',
};

const TARGET_LABELS: Record<IntegrationTarget, string> = {
  DEVELOPMENT: 'Development',
  PREVIEW: 'Preview',
  PRODUCTION: 'Production',
  CUSTOM: 'Custom environment',
};

const ACTION_LABELS: Record<string, string> = {
  create: 'Create',
  update: 'Update',
  unchanged: 'Unchanged',
  remove: 'Remove',
  conflict: 'Conflict',
};

const CONFLICT_LABELS: Record<string, string> = {
  unmanaged: 'exists in Vercel, not created by EnvVault',
  changed_externally: 'changed in Vercel since the last sync',
  shared_target: 'also used by other Vercel environments; never changed automatically',
};

const OUTCOME_TONES: Record<string, StatusTone> = {
  written: 'success',
  removed: 'success',
  unchanged: 'neutral',
  skipped: 'neutral',
  failed: 'danger',
  not_attempted: 'warning',
};

type Run = ReturnType<typeof useStepUp>['run'];

export interface ConnectionData {
  connection: IntegrationConnection;
  mappings: IntegrationMapping[];
  jobs: SyncJob[];
}

export function VercelView({
  workspaceId,
  projectId,
  connections,
  environments,
  canManage,
}: {
  workspaceId: string;
  projectId: string;
  connections: ConnectionData[];
  environments: EnvironmentSummary[];
  canManage: boolean;
}) {
  const [connecting, setConnecting] = useState(false);
  const { run, dialog } = useStepUp();
  const live = connections.filter((c) => c.connection.status !== 'DISCONNECTED');
  return (
    <section aria-labelledby="vercel-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 id="vercel-heading" className="text-base font-semibold">
            Vercel
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Copies an EnvVault environment into a Vercel project&apos;s environment variables.
            Copies in Vercel are outside EnvVault&apos;s encryption: Vercel and everyone with access
            to the Vercel project can use them. Nothing is copied until you preview and confirm, and
            deployments pick up changes only when they are deployed again.
          </p>
        </div>
        {canManage ? (
          <Button
            onClick={() => {
              setConnecting(true);
            }}
          >
            <Plus aria-hidden="true" />
            Connect Vercel
          </Button>
        ) : null}
      </div>

      {live.length === 0 ? (
        <EmptyState
          icon={Triangle}
          title="Vercel is not connected"
          description="Connect with a Vercel access token scoped to the team that owns the project."
        />
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Vercel connections">
          {live.map((data) => (
            <li key={data.connection.id}>
              <ConnectionCard
                workspaceId={workspaceId}
                projectId={projectId}
                data={data}
                environments={environments}
                canManage={canManage}
                run={run}
              />
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <ConnectForm
          open={connecting}
          onOpenChange={setConnecting}
          workspaceId={workspaceId}
          projectId={projectId}
          run={run}
        />
      ) : null}
      {dialog}
    </section>
  );
}

function ConnectForm({
  open,
  onOpenChange,
  workspaceId,
  projectId,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  projectId: string;
  run: Run;
}) {
  const [name, setName] = useState('Vercel');
  const [token, setToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  async function submit() {
    setPending(true);
    try {
      await run(
        async () => {
          const result = await connectVercelAction(workspaceId, projectId, {
            name,
            token,
            ...(teamId.trim() ? { teamId: teamId.trim() } : {}),
          });
          setErrors(result.ok ? {} : (result.fieldErrors ?? {}));
          return result;
        },
        (_data, message) => {
          if (message) notify.success(message);
          setToken('');
          onOpenChange(false);
        },
        () => void submit(),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          if (!next) setToken('');
          onOpenChange(next);
        }
      }}
      title="Connect Vercel"
      description="Create a token in Vercel (Account Settings, Tokens) scoped to one team, with the shortest expiry you can manage. EnvVault stores it encrypted and never shows it again."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <FormField label="Name" required error={errors.name}>
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
        <FormField label="Access token" required error={errors.token}>
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
              }}
            />
          )}
        </FormField>
        <FormField
          label="Team id"
          description="The team_… id from the team's settings. Leave empty for a personal account."
          error={errors.teamId}
        >
          {(control) => (
            <Input
              {...control}
              value={teamId}
              onChange={(e) => {
                setTeamId(e.target.value);
              }}
            />
          )}
        </FormField>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setToken('');
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending || token.length === 0}>
            Connect
          </Button>
        </div>
      </form>
    </ResponsiveModal>
  );
}

function ConnectionCard({
  workspaceId,
  projectId,
  data,
  environments,
  canManage,
  run,
}: {
  workspaceId: string;
  projectId: string;
  data: ConnectionData;
  environments: EnvironmentSummary[];
  canManage: boolean;
  run: Run;
}) {
  const { connection, mappings, jobs } = data;
  const [syncing, setSyncing] = useState<PreviewState | null>(null);
  const [opened, setOpened] = useState(0);

  async function openSync(mapping: IntegrationMapping) {
    setOpened((n) => n + 1);
    setSyncing({ mapping, plan: null, error: null });
    const result = await previewSyncAction(workspaceId, projectId, connection.id, mapping.id);
    setSyncing((current) =>
      current?.mapping.id === mapping.id
        ? {
            mapping,
            plan: result.ok ? result.data : null,
            error: result.ok ? null : result.message,
          }
        : current,
    );
  }
  const done = (_data: unknown, message?: string) => {
    if (message) notify.success(message);
  };
  return (
    <article
      className="flex flex-col gap-4 rounded-md border p-4"
      aria-label={`Vercel connection ${connection.name}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{connection.name}</span>
            <StatusBadge
              tone={STATUS_TONES[connection.status]}
              label={connection.status.toLowerCase()}
            />
          </span>
          <span className="text-xs text-muted-foreground">
            {connection.account.type === 'team' ? 'Team' : 'Account'} {connection.account.name} ·{' '}
            {connection.linkedProject
              ? `project ${connection.linkedProject.name}`
              : 'no project linked'}
          </span>
          <span className="text-xs text-muted-foreground">
            Checked {when(connection.lastCheckedAt)}
            {connection.lastErrorCode ? ` · last error ${connection.lastErrorCode}` : ''} · synced{' '}
            {when(connection.lastSyncedAt)}
          </span>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void run(() => checkVercelAction(workspaceId, projectId, connection.id), done)
              }
            >
              <RefreshCw aria-hidden="true" />
              Check
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void run(
                  () =>
                    setVercelEnabledAction(
                      workspaceId,
                      projectId,
                      connection.id,
                      connection.status === 'DISABLED',
                    ),
                  done,
                )
              }
            >
              {connection.status === 'DISABLED' ? 'Enable' : 'Disable'}
            </Button>
            <ConfirmDialog
              title={`Disconnect ${connection.name}?`}
              description="The token and mappings are erased from EnvVault. Variables EnvVault already wrote stay in Vercel; remove them there if they should go."
              confirmLabel="Disconnect"
              destructive
              onConfirm={async () => {
                await run(
                  () => disconnectVercelAction(workspaceId, projectId, connection.id),
                  done,
                );
              }}
              trigger={
                <Button variant="outline" size="sm">
                  Disconnect
                </Button>
              }
            />
          </div>
        ) : null}
      </div>

      {connection.status === 'ERROR' ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-subtle p-3 text-sm"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <p>
            Vercel refused the stored token ({connection.lastErrorCode ?? 'error'}). Create a new
            token in Vercel, then disconnect and connect again.
          </p>
        </div>
      ) : null}

      {!connection.linkedProject && canManage ? (
        <LinkProject
          workspaceId={workspaceId}
          projectId={projectId}
          connection={connection}
          run={run}
        />
      ) : null}

      {connection.linkedProject ? (
        <Mappings
          workspaceId={workspaceId}
          projectId={projectId}
          connection={connection}
          mappings={mappings}
          environments={environments}
          canManage={canManage}
          run={run}
          onSync={(m) => void openSync(m)}
        />
      ) : null}

      <Activity jobs={jobs} mappings={mappings} />

      <SyncDialog
        key={opened}
        workspaceId={workspaceId}
        projectId={projectId}
        connectionId={connection.id}
        state={syncing}
        canManage={canManage}
        run={run}
        onClose={() => {
          setSyncing(null);
        }}
      />
    </article>
  );
}

function LinkProject({
  workspaceId,
  projectId,
  connection,
  run,
}: {
  workspaceId: string;
  projectId: string;
  connection: IntegrationConnection;
  run: Run;
}) {
  const [search, setSearch] = useState('');
  const [projects, setProjects] = useState<ProviderProjectList['items'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function find() {
    setError(null);
    const result = await vercelProjectsAction(workspaceId, projectId, connection.id, search);
    if (result.ok) setProjects(result.data.items);
    else setError(result.message);
  }
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <FormField label="Find a Vercel project" className="flex-1">
          {(control) => (
            <Input
              {...control}
              value={search}
              placeholder="Project name"
              onChange={(e) => {
                setSearch(e.target.value);
              }}
            />
          )}
        </FormField>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {projects ? (
        projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No project found.</p>
        ) : (
          <ul
            className="flex flex-col divide-y rounded-md border bg-background"
            aria-label="Vercel projects"
          >
            {projects.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="truncate">
                  {p.name}
                  {p.framework ? (
                    <span className="text-xs text-muted-foreground"> · {p.framework}</span>
                  ) : null}
                </span>
                <Button
                  size="sm"
                  onClick={() =>
                    void run(
                      () => linkVercelProjectAction(workspaceId, projectId, connection.id, p.id),
                      (_d, message) => {
                        if (message) notify.success(message);
                      },
                    )
                  }
                >
                  Link
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function Mappings({
  workspaceId,
  projectId,
  connection,
  mappings,
  environments,
  canManage,
  run,
  onSync,
}: {
  workspaceId: string;
  projectId: string;
  connection: IntegrationConnection;
  mappings: IntegrationMapping[];
  environments: EnvironmentSummary[];
  canManage: boolean;
  run: Run;
  onSync: (mapping: IntegrationMapping) => void;
}) {
  const [environmentId, setEnvironmentId] = useState(environments[0]?.id ?? '');
  const [target, setTarget] = useState<IntegrationTarget>('PREVIEW');
  const [gitBranch, setGitBranch] = useState('');
  const [custom, setCustom] = useState<{ id: string; slug: string }[] | null>(null);
  const [customId, setCustomId] = useState('');

  async function chooseTarget(next: IntegrationTarget) {
    setTarget(next);
    if (next === 'CUSTOM' && custom === null) {
      const result = await customEnvironmentsAction(workspaceId, projectId, connection.id);
      if (result.ok) {
        setCustom(result.data.items);
        setCustomId(result.data.items[0]?.id ?? '');
      } else notify.error(result.message);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Environment mappings</h3>
      {mappings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No mapping yet. Map an EnvVault environment to a Vercel environment.
        </p>
      ) : (
        <ul className="divide-y rounded-md border" aria-label="Environment mappings">
          {mappings.map((m) => (
            <li
              key={m.id}
              className="flex flex-col gap-2 px-3 py-2 text-sm sm:flex-row sm:items-center"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span>
                  {m.environment.name}
                  {m.environment.isProtected ? ' (protected)' : ''} → Vercel{' '}
                  {m.customEnvironment
                    ? `custom ${m.customEnvironment.slug ?? m.customEnvironment.id}`
                    : TARGET_LABELS[m.target]}
                  {m.gitBranch ? ` on branch ${m.gitBranch}` : ''}
                </span>
                <span className="text-xs text-muted-foreground">
                  {m.managedVariables} managed variables · synced {when(m.lastSyncedAt)}
                </span>
              </span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    onSync(m);
                  }}
                >
                  Preview sync
                </Button>
                {canManage ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void run(
                        () => deleteMappingAction(workspaceId, projectId, connection.id, m.id),
                        (_d, message) => {
                          if (message) notify.success(message);
                        },
                      )
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
          aria-label="Add a mapping"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                createMappingAction(workspaceId, projectId, connection.id, {
                  environmentId,
                  target,
                  ...(target === 'PREVIEW' && gitBranch.trim()
                    ? { gitBranch: gitBranch.trim() }
                    : {}),
                  ...(target === 'CUSTOM' ? { customEnvironmentId: customId } : {}),
                }),
              (_d, message) => {
                if (message) notify.success(message);
                setGitBranch('');
              },
            );
          }}
        >
          <FormField label="EnvVault environment">
            {(control) => (
              <NativeSelect
                {...control}
                value={environmentId}
                onChange={(e) => {
                  setEnvironmentId(e.target.value);
                }}
              >
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                    {env.isProtected ? ' (protected)' : ''}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField label="Vercel environment">
            {(control) => (
              <NativeSelect
                {...control}
                value={target}
                onChange={(e) => void chooseTarget(e.target.value as IntegrationTarget)}
              >
                {Object.entries(TARGET_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          {target === 'CUSTOM' ? (
            <FormField label="Custom environment">
              {(control) => (
                <NativeSelect
                  {...control}
                  value={customId}
                  onChange={(e) => {
                    setCustomId(e.target.value);
                  }}
                >
                  {(custom ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.slug}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
          ) : (
            <FormField label="Preview branch" description="Preview only; empty for all branches">
              {(control) => (
                <Input
                  {...control}
                  value={gitBranch}
                  disabled={target !== 'PREVIEW'}
                  onChange={(e) => {
                    setGitBranch(e.target.value);
                  }}
                />
              )}
            </FormField>
          )}
          <Button type="submit" variant="outline">
            Add mapping
          </Button>
        </form>
      ) : null}
    </div>
  );
}

interface PreviewState {
  mapping: IntegrationMapping;
  plan: SyncPlan | null;
  error: string | null;
}

function SyncDialog({
  workspaceId,
  projectId,
  connectionId,
  state,
  canManage,
  run,
  onClose,
}: {
  workspaceId: string;
  projectId: string;
  connectionId: string;
  state: PreviewState | null;
  canManage: boolean;
  run: Run;
  onClose: () => void;
}) {
  const mapping = state?.mapping ?? null;
  const plan = state?.plan ?? null;
  const error = state?.error ?? null;
  const [job, setJob] = useState<SyncJob | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [removeManaged, setRemoveManaged] = useState(false);
  const [confirmProtected, setConfirmProtected] = useState(false);
  const [confirmProduction, setConfirmProduction] = useState(false);
  const [pending, setPending] = useState(false);

  async function confirm() {
    if (!plan || !mapping) return;
    setPending(true);
    try {
      await run(
        () =>
          runSyncAction(workspaceId, projectId, connectionId, mapping.id, {
            planHash: plan.planHash,
            overwrite,
            removeManaged,
            confirmProtected,
            confirmProduction,
          }),
        (data) => {
          setJob(data);
        },
        () => void confirm(),
      );
    } finally {
      setPending(false);
    }
  }

  const needsProtected = plan?.requiresConfirmation.protectedEnvironment === true;
  const needsProduction = plan?.requiresConfirmation.production === true;
  const blocked = (needsProtected && !confirmProtected) || (needsProduction && !confirmProduction);
  const writes = plan
    ? plan.items.filter(
        (i) =>
          i.action === 'create' ||
          i.action === 'update' ||
          (i.action === 'remove' && removeManaged) ||
          (i.action === 'conflict' && overwrite && i.conflict !== 'shared_target'),
      ).length
    : 0;

  return (
    <ResponsiveModal
      open={mapping !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title="Synchronise to Vercel"
      description="Keys and planned changes only; values are never shown. Unrelated Vercel variables are never touched."
      className="sm:max-w-2xl"
    >
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : job ? (
        <SyncResult job={job} />
      ) : !plan ? (
        <p className="text-sm text-muted-foreground">Comparing with Vercel…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {Object.entries(plan.counts)
              .filter(([, n]) => n > 0)
              .map(
                ([action, n]) => `${String(n)} ${ACTION_LABELS[action]?.toLowerCase() ?? action}`,
              )
              .join(' · ') || 'Nothing to do'}
            {plan.unrelated > 0 ? ` · ${String(plan.unrelated)} unrelated left alone` : ''}
          </p>
          <ul
            className="max-h-72 divide-y overflow-auto rounded-md border text-sm"
            aria-label="Planned changes"
          >
            {plan.items.map((item) => (
              <li
                key={item.key}
                className="flex flex-col gap-0.5 px-3 py-1.5 sm:flex-row sm:justify-between"
              >
                <span className="break-all font-mono text-xs">{item.key}</span>
                <span className="text-xs text-muted-foreground">
                  {ACTION_LABELS[item.action]}
                  {item.conflict ? `: ${CONFLICT_LABELS[item.conflict] ?? item.conflict}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {canManage ? (
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="mb-1 font-medium">Options</legend>
              <Check checked={overwrite} onChange={setOverwrite}>
                Overwrite conflicting variables with EnvVault&apos;s values
              </Check>
              <Check checked={removeManaged} onChange={setRemoveManaged}>
                Remove variables EnvVault created whose key is no longer in this environment
              </Check>
              {needsProtected ? (
                <Check checked={confirmProtected} onChange={setConfirmProtected}>
                  I understand this copies a protected environment&apos;s values out of EnvVault
                </Check>
              ) : null}
              {needsProduction ? (
                <Check checked={confirmProduction} onChange={setConfirmProduction}>
                  I understand this changes Vercel Production
                </Check>
              ) : null}
            </fieldset>
          ) : (
            <p className="text-sm text-muted-foreground">You can preview but not synchronise.</p>
          )}
          {canManage ? (
            <div className="flex justify-end">
              <Button disabled={pending || blocked || writes === 0} onClick={() => void confirm()}>
                {writes === 0 ? 'Nothing to write' : `Write ${String(writes)} changes to Vercel`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </ResponsiveModal>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5 size-4"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
      <span>{children}</span>
    </label>
  );
}

function SyncResult({ job }: { job: SyncJob }) {
  return (
    <div className="flex flex-col gap-3" data-testid="sync-result">
      <p className="flex items-center gap-2 text-sm">
        <StatusBadge
          tone={
            job.status === 'SUCCEEDED' ? 'success' : job.status === 'PARTIAL' ? 'warning' : 'danger'
          }
          label={job.status.toLowerCase()}
        />
        {job.errorMessage ?? 'All planned changes were written.'}
        {job.retryAfterSeconds ? ` Retry in ${String(job.retryAfterSeconds)} seconds.` : ''}
      </p>
      {job.redeployRequired ? (
        <p className="text-sm text-muted-foreground">
          Redeploy in Vercel for the changes to reach running deployments.
        </p>
      ) : null}
      <ul
        className="max-h-72 divide-y overflow-auto rounded-md border text-sm"
        aria-label="Results"
      >
        {job.items.map((item) => (
          <li key={item.key} className="flex items-center justify-between gap-2 px-3 py-1.5">
            <span className="break-all font-mono text-xs">{item.key}</span>
            <StatusBadge
              tone={OUTCOME_TONES[item.outcome] ?? 'neutral'}
              label={`${item.outcome.replace('_', ' ')}${item.errorCode ? ` (${item.errorCode})` : ''}`}
            />
          </li>
        ))}
      </ul>
      {job.status === 'PARTIAL' ? (
        <p className="text-sm text-muted-foreground">
          Vercel has no atomic batch: the variables marked written are in Vercel. Preview again to
          finish the rest safely.
        </p>
      ) : null}
    </div>
  );
}

function Activity({ jobs, mappings }: { jobs: SyncJob[]; mappings: IntegrationMapping[] }) {
  if (jobs.length === 0) return null;
  const names = new Map(
    mappings.map((m) => [m.id, `${m.environment.name} → ${TARGET_LABELS[m.target]}`]),
  );
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">Activity</summary>
      <ul className="mt-2 divide-y rounded-md border" aria-label="Synchronisation history">
        {jobs.slice(0, 10).map((job) => (
          <li
            key={job.id}
            className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <span>
              {job.mappingId ? (names.get(job.mappingId) ?? 'Removed mapping') : 'Synchronisation'}{' '}
              · {when(job.finishedAt ?? job.startedAt)}
              {job.requestedBy ? ` · ${job.requestedBy.email}` : ''}
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {Object.entries(job.counts)
                .map(([k, n]) => `${String(n)} ${k.replace('_', ' ')}`)
                .join(', ')}
              <StatusBadge
                tone={
                  job.status === 'SUCCEEDED'
                    ? 'success'
                    : job.status === 'PARTIAL'
                      ? 'warning'
                      : 'danger'
                }
                label={job.status.toLowerCase()}
              />
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
