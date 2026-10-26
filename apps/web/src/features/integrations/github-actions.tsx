'use client';

import {
  type MachineIdentitySummary,
  type OidcBindingAttempt,
  type OidcTrustBinding,
  type OidcTrustBindingList,
  type OidcTrustBindingStatus,
  protectedPolicyProblems,
} from '@envvault/shared';
import { Copy, GitBranch, Plus, ShieldAlert, Workflow } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { copyToClipboard } from '@/components/forms/clipboard';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, Textarea } from '@/components/ui/textarea';
import type { StatusTone } from '@/design/tokens';
import { SCOPE_LABELS, useStepUp, when } from '@/features/machines/shared';
import {
  createTrustBindingAction,
  deleteTrustBindingAction,
  setTrustBindingEnabledAction,
  trustBindingAttemptsAction,
} from './actions';
import { exampleWorkflow } from './workflow';

const TONES: Record<OidcTrustBindingStatus, StatusTone> = {
  ACTIVE: 'success',
  DISABLED: 'warning',
  EXPIRED: 'neutral',
  REVOKED: 'danger',
};

const EVENTS = [
  { value: 'push', label: 'push' },
  { value: 'workflow_dispatch', label: 'workflow_dispatch (manual)' },
  { value: 'release', label: 'release' },
  { value: 'schedule', label: 'schedule' },
  { value: 'pull_request', label: 'pull_request (never for protected environments)' },
];

/** Readable refusal reasons from the exchange audit trail. */
const REASONS: Record<string, string> = {
  audience: 'audience did not match',
  repository_owner: 'repository owner did not match',
  workflow: 'workflow file did not match',
  job_workflow: 'reusable workflow did not match',
  ref: 'branch or tag not allowed',
  environment: 'GitHub environment not allowed',
  event: 'event not allowed',
  pull_request: 'pull request event',
  subject: 'subject did not match',
  binding_disabled: 'binding disabled',
  binding_expired: 'binding expired',
  identity_disabled: 'identity disabled',
  identity_expired: 'identity expired',
  identity_retired: 'identity retired',
  protected_policy_required: 'binding too loose for a protected environment',
  scope_not_granted: 'scope not allowed',
  environment_not_in_binding: 'environment not in the binding',
  no_environment: 'no environment left',
};

const lines = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

function Conditions({ binding }: { binding: OidcTrustBinding }) {
  const facts: [string, string][] = [
    ['Repository', `${binding.repository.name} (id ${binding.repository.id})`],
    ['Workflow', binding.workflowPath ?? 'any'],
    ['Branches and tags', binding.refs.length ? binding.refs.join(', ') : 'any'],
    [
      'Events',
      binding.eventNames.length ? binding.eventNames.join(', ') : 'any except pull requests',
    ],
    [
      'GitHub environments',
      binding.githubEnvironments.length ? binding.githubEnvironments.join(', ') : 'any',
    ],
    ...(binding.jobWorkflowRef
      ? [['Reusable workflow', binding.jobWorkflowRef] as [string, string]]
      : []),
    ...(binding.subject ? [['Subject', binding.subject] as [string, string]] : []),
    [
      'EnvVault environments',
      binding.environments.map((e) => `${e.name}${e.isProtected ? ' (protected)' : ''}`).join(', '),
    ],
    ['Identity', binding.identity.name],
    ['Audience', binding.audience],
    ['Expires', when(binding.expiresAt)],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[11rem_1fr]">
      {facts.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function GitHubActionsView({
  workspaceId,
  projectId,
  list,
  identities,
  apiUrl,
  canManage,
}: {
  workspaceId: string;
  projectId: string;
  list: OidcTrustBindingList;
  identities: MachineIdentitySummary[];
  apiUrl: string;
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [workflowFor, setWorkflowFor] = useState<OidcTrustBinding | null>(null);
  const [attempts, setAttempts] = useState<AttemptsState | null>(null);
  const { run, dialog } = useStepUp();

  async function openAttempts(binding: OidcTrustBinding) {
    setAttempts({ binding, items: null, error: null });
    const result = await trustBindingAttemptsAction(workspaceId, projectId, binding.id);
    setAttempts((current) =>
      current?.binding.id === binding.id
        ? {
            binding,
            items: result.ok ? result.data.items : null,
            error: result.ok ? null : result.message,
          }
        : current,
    );
  }

  async function setEnabled(binding: OidcTrustBinding, enabled: boolean) {
    await run(
      () => setTrustBindingEnabledAction(workspaceId, projectId, binding.id, enabled),
      (_data, message) => {
        if (message) notify.success(message);
      },
    );
  }

  return (
    <section aria-labelledby="github-actions-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 id="github-actions-heading" className="text-base font-semibold">
            GitHub Actions
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Trust bindings let GitHub Actions workflows authenticate as a machine identity with the
            job&apos;s short lived OIDC token, so no EnvVault credential is stored in GitHub. A
            binding only decides who may authenticate: what the workflow can read is still the
            identity&apos;s grants.
          </p>
        </div>
        {canManage ? (
          <Button
            onClick={() => {
              setCreating(true);
            }}
            disabled={identities.length === 0}
          >
            <Plus aria-hidden="true" />
            New trust binding
          </Button>
        ) : null}
      </div>

      <details className="rounded-md border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">How to set it up</summary>
        <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-muted-foreground">
          <li>Create a machine identity and grant it the environments the workflow needs.</li>
          <li>
            Find the repository and owner ids:{' '}
            <code className="font-mono">
              gh api repos/OWNER/REPO --jq &apos;.id, .owner.id&apos;
            </code>
          </li>
          <li>
            Create a trust binding here with the workflow file, branches and events it may run from.
          </li>
          <li>
            In the workflow, grant <code className="font-mono">id-token: write</code> and use the
            EnvVault action, pinned to a full commit SHA (copy the example from a binding).
          </li>
          <li>
            Run the workflow; refused attempts and their reasons appear under Recent attempts.
          </li>
        </ol>
      </details>

      {identities.length === 0 && canManage ? (
        <div role="status" className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>Create a machine identity with at least one environment grant first.</p>
        </div>
      ) : null}

      {list.items.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No trust bindings yet"
          description="Bind a repository's workflow to a machine identity to load configuration in GitHub Actions without storing a credential."
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Trust bindings">
          {list.items.map((binding) => (
            <li key={binding.id} className="flex flex-col gap-3 rounded-md border p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="flex min-w-0 items-center gap-2">
                  <GitBranch aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate text-sm font-medium">{binding.name}</span>
                  <StatusBadge tone={TONES[binding.status]} label={binding.status.toLowerCase()} />
                </span>
                <span className="text-xs text-muted-foreground">
                  Last used {when(binding.lastUsedAt)}
                </span>
              </div>
              <Conditions binding={binding} />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setWorkflowFor(binding);
                  }}
                >
                  Workflow example
                </Button>
                <Button variant="outline" size="sm" onClick={() => void openAttempts(binding)}>
                  Recent attempts
                </Button>
                {canManage && binding.status === 'ACTIVE' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void setEnabled(binding, false)}
                  >
                    Disable
                  </Button>
                ) : null}
                {canManage && binding.status === 'DISABLED' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void setEnabled(binding, true)}
                  >
                    Enable
                  </Button>
                ) : null}
                {canManage && binding.status !== 'REVOKED' ? (
                  <ConfirmDialog
                    title={`Delete ${binding.name}?`}
                    description="Workflows matching this binding stop authenticating at once, including jobs that are running. The binding stays in the audit history."
                    confirmLabel="Delete binding"
                    destructive
                    onConfirm={async () => {
                      await run(
                        () => deleteTrustBindingAction(workspaceId, projectId, binding.id),
                        (_data, message) => {
                          if (message) notify.success(message);
                        },
                      );
                    }}
                    trigger={
                      <Button variant="outline" size="sm">
                        Delete
                      </Button>
                    }
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <CreateBindingForm
          open={creating}
          onOpenChange={setCreating}
          workspaceId={workspaceId}
          projectId={projectId}
          identities={identities}
          defaultAudience={apiUrl}
          issuers={list.issuers}
          run={run}
        />
      ) : null}
      <WorkflowExample
        binding={workflowFor}
        onClose={() => {
          setWorkflowFor(null);
        }}
        apiUrl={apiUrl}
        projectId={projectId}
      />
      <Attempts
        state={attempts}
        onClose={() => {
          setAttempts(null);
        }}
      />
      {dialog}
    </section>
  );
}

function WorkflowExample({
  binding,
  onClose,
  apiUrl,
  projectId,
}: {
  binding: OidcTrustBinding | null;
  onClose: () => void;
  apiUrl: string;
  projectId: string;
}) {
  const yaml = binding
    ? exampleWorkflow(binding, { apiUrl, projectId, command: 'npm run build' })
    : '';
  return (
    <ResponsiveModal
      open={binding !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Workflow example"
      description="Replace the placeholders, pin both actions to full commit SHAs and set your command. It contains no credential."
      className="sm:max-w-2xl"
    >
      <pre
        className="max-h-96 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs"
        data-testid="workflow-example"
      >
        {yaml}
      </pre>
      <div className="flex justify-end">
        <Button
          variant="outline"
          onClick={() => {
            void copyToClipboard(yaml).then((copied) => {
              if (copied) notify.success('Workflow copied.');
              else notify.error('The browser refused to copy. Select the text instead.');
            });
          }}
        >
          <Copy aria-hidden="true" />
          Copy
        </Button>
      </div>
    </ResponsiveModal>
  );
}

interface AttemptsState {
  binding: OidcTrustBinding;
  items: OidcBindingAttempt[] | null;
  error: string | null;
}

function Attempts({ state, onClose }: { state: AttemptsState | null; onClose: () => void }) {
  const items = state?.items ?? null;
  const error = state?.error ?? null;
  return (
    <ResponsiveModal
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Recent attempts"
      description="Exchanges by GitHub workflows for this binding, newest first. Repeated refusals are recorded once a minute."
      className="sm:max-w-2xl"
    >
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : items === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No attempts yet.</p>
      ) : (
        <ul className="flex max-h-96 flex-col divide-y overflow-auto text-xs" aria-label="Attempts">
          {items.map((a) => (
            <li key={a.id} className="flex flex-col gap-0.5 py-2">
              <span className="flex items-center gap-2">
                <StatusBadge
                  tone={a.outcome === 'SUCCESS' ? 'success' : 'danger'}
                  label={a.outcome === 'SUCCESS' ? 'accepted' : 'refused'}
                />
                <span className="text-muted-foreground">{when(a.occurredAt)}</span>
              </span>
              {a.reason ? <span>Reason: {REASONS[a.reason] ?? a.reason}</span> : null}
              <span className="break-all text-muted-foreground">
                {[
                  a.ref,
                  a.eventName,
                  a.githubEnvironment ? `environment ${a.githubEnvironment}` : null,
                  a.runId ? `run ${a.runId}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {a.workflowRef ? <span className="break-all font-mono">{a.workflowRef}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </ResponsiveModal>
  );
}

type Run = ReturnType<typeof useStepUp>['run'];

function CreateBindingForm({
  open,
  onOpenChange,
  workspaceId,
  projectId,
  identities,
  defaultAudience,
  issuers,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  projectId: string;
  identities: MachineIdentitySummary[];
  defaultAudience: string;
  issuers: string[];
  run: Run;
}) {
  const usable = identities.filter((i) => i.status === 'ACTIVE' && i.grants.length > 0);
  const [identityId, setIdentityId] = useState(usable[0]?.id ?? '');
  const [name, setName] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [repositoryOwnerId, setRepositoryOwnerId] = useState('');
  const [workflowPath, setWorkflowPath] = useState('.github/workflows/deploy.yml');
  const [refs, setRefs] = useState('refs/heads/main');
  const [events, setEvents] = useState<string[]>(['push', 'workflow_dispatch']);
  const [githubEnvironments, setGithubEnvironments] = useState('');
  const [jobWorkflowRef, setJobWorkflowRef] = useState('');
  const [audience, setAudience] = useState(defaultAudience);
  const [environmentIds, setEnvironmentIds] = useState<string[]>([]);
  const [scopes, setScopes] = useState<string[]>([
    'environment:read',
    'secret:list',
    'secret:runtime',
  ]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  const identity = usable.find((i) => i.id === identityId);
  const environments = [
    ...new Map((identity?.grants ?? []).map((g) => [g.environment.id, g.environment])).values(),
  ];
  const protectedChosen = environments.some((e) => e.isProtected && environmentIds.includes(e.id));
  const problems = protectedChosen
    ? protectedPolicyProblems({
        refs: lines(refs),
        githubEnvironments: lines(githubEnvironments),
        eventNames: events,
      })
    : [];

  async function submit() {
    setPending(true);
    try {
      await run(
        async () => {
          const result = await createTrustBindingAction(workspaceId, projectId, {
            identityId,
            name,
            audience,
            repositoryName,
            repositoryId,
            repositoryOwnerId,
            workflowPath: workflowPath.trim() || null,
            jobWorkflowRef: jobWorkflowRef.trim() || null,
            refs: lines(refs),
            githubEnvironments: lines(githubEnvironments),
            eventNames: events,
            environmentIds,
            scopes,
            ...(issuers[0] ? { issuer: issuers[0] } : {}),
          });
          setErrors(result.ok ? {} : (result.fieldErrors ?? {}));
          return result;
        },
        (_data, message) => {
          if (message) notify.success(message);
          onOpenChange(false);
        },
        () => void submit(),
      );
    } finally {
      setPending(false);
    }
  }

  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((v) => v !== value);

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title="New trust binding"
      description="Which GitHub workflow may authenticate as which machine identity, and for which environments."
      className="sm:max-w-2xl"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <FormField label="Machine identity" required error={errors.identityId}>
          {(control) => (
            <NativeSelect
              {...control}
              value={identityId}
              onChange={(e) => {
                setIdentityId(e.target.value);
                setEnvironmentIds([]);
              }}
            >
              {usable.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <FormField label="Name" required error={errors.name}>
          {(control) => (
            <Input
              {...control}
              value={name}
              maxLength={100}
              placeholder="Deploy from main"
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            label="Repository"
            required
            description="owner/name, for display"
            error={errors.repositoryName}
          >
            {(control) => (
              <Input
                {...control}
                value={repositoryName}
                placeholder="octo-org/app"
                onChange={(e) => {
                  setRepositoryName(e.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            label="Repository id"
            required
            description="Decides trust; names can change"
            error={errors.repositoryId}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                value={repositoryId}
                onChange={(e) => {
                  setRepositoryId(e.target.value);
                }}
              />
            )}
          </FormField>
          <FormField label="Owner id" required error={errors.repositoryOwnerId}>
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                value={repositoryOwnerId}
                onChange={(e) => {
                  setRepositoryOwnerId(e.target.value);
                }}
              />
            )}
          </FormField>
        </div>
        <FormField
          label="Workflow file"
          description="Leave empty to allow any workflow in the repository"
          error={errors.workflowPath}
        >
          {(control) => (
            <Input
              {...control}
              value={workflowPath}
              onChange={(e) => {
                setWorkflowPath(e.target.value);
              }}
            />
          )}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Branches and tags"
            description="One full ref per line; a final * matches a prefix. Empty allows any."
            error={errors.refs}
          >
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                value={refs}
                onChange={(e) => {
                  setRefs(e.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            label="GitHub environments"
            description="Require the job to run in one of these GitHub deployment environments"
            error={errors.githubEnvironments}
          >
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                value={githubEnvironments}
                placeholder="production"
                onChange={(e) => {
                  setGithubEnvironments(e.target.value);
                }}
              />
            )}
          </FormField>
        </div>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 font-medium">Events</legend>
          {EVENTS.map((event) => (
            <label key={event.value} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={events.includes(event.value)}
                onChange={(e) => {
                  setEvents(toggle(events, event.value, e.target.checked));
                }}
              />
              {event.label}
            </label>
          ))}
          <span className="text-xs text-muted-foreground">
            None checked allows any event except pull requests. pull_request_target is never
            accepted.
          </span>
        </fieldset>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 font-medium">EnvVault environments</legend>
          {environments.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              This identity has no environment grants.
            </span>
          ) : (
            environments.map((environment) => (
              <label key={environment.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={environmentIds.includes(environment.id)}
                  onChange={(e) => {
                    setEnvironmentIds(toggle(environmentIds, environment.id, e.target.checked));
                  }}
                />
                {environment.name}
                {environment.isProtected ? (
                  <span className="text-xs text-muted-foreground">(protected)</span>
                ) : null}
              </label>
            ))
          )}
          {errors.environmentIds ? (
            <span className="text-xs text-danger">{errors.environmentIds}</span>
          ) : null}
        </fieldset>
        {problems.length > 0 ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle p-3 text-sm"
          >
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="font-medium">A protected environment needs a stricter binding:</p>
              <ul className="list-disc pl-5">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 font-medium">Scopes</legend>
          {Object.entries(SCOPE_LABELS).map(([scope, label]) => (
            <label key={scope} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={scopes.includes(scope)}
                onChange={(e) => {
                  setScopes(toggle(scopes, scope, e.target.checked));
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Advanced</summary>
          <div className="mt-3 flex flex-col gap-4">
            <FormField
              label="Audience"
              description="The action requests its OIDC token for this audience (default: the API address)"
              error={errors.audience}
            >
              {(control) => (
                <Input
                  {...control}
                  value={audience}
                  onChange={(e) => {
                    setAudience(e.target.value);
                  }}
                />
              )}
            </FormField>
            <FormField
              label="Reusable workflow"
              description="owner/repo/.github/workflows/file.yml@ref, pinned to a commit SHA"
              error={errors.jobWorkflowRef}
            >
              {(control) => (
                <Input
                  {...control}
                  value={jobWorkflowRef}
                  onChange={(e) => {
                    setJobWorkflowRef(e.target.value);
                  }}
                />
              )}
            </FormField>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={pending || problems.length > 0 || environmentIds.length === 0}
          >
            Create binding
          </Button>
        </div>
      </form>
    </ResponsiveModal>
  );
}
