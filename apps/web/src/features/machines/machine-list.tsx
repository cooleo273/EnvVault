'use client';

import type {
  EnvironmentSummary,
  IssuedServiceCredential,
  MachineIdentityList,
  MachineIdentityStatus,
} from '@envvault/shared';
import { Bot, Plus, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { FilterDropdown } from '@/components/data/filter-dropdown';
import { SearchInput } from '@/components/data/search-input';
import { EmptyState } from '@/components/feedback/states';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, Textarea } from '@/components/ui/textarea';
import {
  createMachineIdentityAction,
  grantMachineAccessAction,
  issueServiceCredentialAction,
} from './actions';
import {
  CredentialReveal,
  effectiveAccess,
  IdentityStatus,
  SCOPE_LABELS,
  useStepUp,
  when,
} from './shared';

const STATUSES: { value: MachineIdentityStatus; label: string }[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DISABLED', label: 'Disabled' },
  { value: 'EXPIRED', label: 'Expired' },
];

const SHORT: Record<string, string> = {
  'environment:read': 'read',
  'secret:list': 'list',
  'secret:runtime': 'run',
};

/**
 * Machine identities of a project: who (which pipeline or server) can reach
 * which environment, and how. Values and tokens are never shown here.
 */
export function MachineIdentityListView({
  workspaceId,
  projectId,
  list,
  environments,
  canManage,
}: {
  workspaceId: string;
  projectId: string;
  list: MachineIdentityList;
  environments: EnvironmentSummary[];
  canManage: boolean;
}) {
  const [query, setQuery] = useState('');
  const [statuses, setStatuses] = useState<MachineIdentityStatus[]>([]);
  const [creating, setCreating] = useState(false);
  const base = `/workspaces/${workspaceId}/projects/${projectId}/machines`;

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.items.filter(
      (i) =>
        (statuses.length === 0 || statuses.includes(i.status)) &&
        (q === '' ||
          i.name.toLowerCase().includes(q) ||
          (i.description ?? '').toLowerCase().includes(q)),
    );
  }, [list.items, query, statuses]);

  return (
    <section aria-labelledby="machines-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 id="machines-heading" className="text-base font-semibold">
            Machine identities
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            CI pipelines, deployment servers and jobs authenticate with their own credentials. They
            never inherit anyone&apos;s access: each identity reaches only the environments granted
            to it, and only to read metadata or load values at runtime.
          </p>
        </div>
        {canManage ? (
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus aria-hidden="true" />
            New identity
          </Button>
        ) : null}
      </div>

      {!list.credentialsDurable ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm"
        >
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            This API has no integrity key file, so credentials issued now stop working when it
            restarts. Configure <code className="font-mono">INTEGRITY_KEY_FILE</code> before relying
            on them.
          </p>
        </div>
      ) : null}

      {list.items.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <SearchInput
            label="Search machine identities"
            placeholder="Search by name or description"
            value={query}
            onValueChange={setQuery}
            className="sm:max-w-xs"
          />
          <FilterDropdown
            label="Status"
            options={STATUSES}
            selected={statuses}
            onSelectedChange={setStatuses}
          />
        </div>
      ) : null}

      {list.items.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No machine identities yet"
          description="Create one for each pipeline or server, grant it the environments it needs, and give it a credential."
          {...(canManage
            ? {
                action: (
                  <Button
                    onClick={() => {
                      setCreating(true);
                    }}
                  >
                    New identity
                  </Button>
                ),
              }
            : {})}
        />
      ) : items.length === 0 ? (
        <EmptyState title="No identity matches" className="py-6" />
      ) : (
        <ul className="divide-y rounded-md border" aria-label="Machine identities">
          {items.map((identity) => {
            const access = effectiveAccess(identity.grants).filter((a) => a.permissions.length > 0);
            return (
              <li
                key={identity.id}
                className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <Link
                      href={`${base}/${identity.id}`}
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {identity.name}
                    </Link>
                    <IdentityStatus status={identity.status} />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {access.length === 0
                      ? 'No environment access'
                      : access
                          .map(
                            (a) =>
                              `${a.environment.name}${a.environment.isProtected ? ' (protected)' : ''}: ${a.permissions.map((p) => SHORT[p] ?? p).join(', ')}`,
                          )
                          .join(' · ')}
                  </span>
                </div>
                <div className="flex flex-col text-xs text-muted-foreground sm:items-end">
                  <span>
                    {identity.activeCredentials} active credential
                    {identity.activeCredentials === 1 ? '' : 's'}
                  </span>
                  <span>Last used {when(identity.lastUsedAt)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canManage ? (
        <CreateMachineWizard
          open={creating}
          onOpenChange={setCreating}
          workspaceId={workspaceId}
          projectId={projectId}
          environments={environments.filter((e) => e.status === 'ACTIVE')}
          roles={list.roles}
          base={base}
        />
      ) : null}
    </section>
  );
}

interface Assignment {
  environmentId: string;
  roleKey: string;
}

/**
 * Three steps: what the identity is, which environments it may use, and its
 * first credential (shown once). Each grant is checked by the API against
 * your own access to that environment.
 */
function CreateMachineWizard({
  open,
  onOpenChange,
  workspaceId,
  projectId,
  environments,
  roles,
  base,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  projectId: string;
  environments: EnvironmentSummary[];
  roles: MachineIdentityList['roles'];
  base: string;
}) {
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [lifetime, setLifetime] = useState('90');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [credentialName, setCredentialName] = useState('ci');
  const [scopes, setScopes] = useState<string[]>([
    'environment:read',
    'secret:list',
    'secret:runtime',
  ]);
  const [expiresInDays, setExpiresInDays] = useState('30');
  const [issued, setIssued] = useState<IssuedServiceCredential | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Read by finish(), which may run again after a password confirmation from an
  // older render: refs keep it from creating the identity twice or regranting.
  const createdRef = useRef<string | null>(null);
  const assignmentsRef = useRef<Assignment[]>([]);
  function changeAssignments(next: Assignment[]) {
    assignmentsRef.current = next;
    setAssignments(next);
  }

  function reset() {
    setStep(1);
    setName('');
    setDescription('');
    setLifetime('90');
    changeAssignments([]);
    setCredentialName('ci');
    setScopes(['environment:read', 'secret:list', 'secret:runtime']);
    setExpiresInDays('30');
    setIssued(null);
    setCreatedId(null);
    createdRef.current = null;
    setErrors({});
  }

  function close(next: boolean) {
    if (pending) return;
    // The token is lost once the dialog closes; CredentialReveal asks first.
    if (!next && issued) return;
    if (!next) {
      if (createdId) router.push(`${base}/${createdId}`);
      reset();
    }
    onOpenChange(next);
  }

  async function finish() {
    setPending(true);
    try {
      let identityId = createdRef.current;
      if (!identityId) {
        const created = await createMachineIdentityAction(workspaceId, projectId, {
          name,
          ...(description.trim() ? { description } : {}),
          credentialMaxLifetimeDays: Number(lifetime),
        });
        if (!created.ok) {
          setErrors(created.fieldErrors ?? {});
          notify.error(created.message);
          setStep(1);
          return;
        }
        identityId = created.data.id;
        createdRef.current = identityId;
        setCreatedId(identityId);
      }
      const id = identityId;
      // Granted ones leave the list, so a retry after a password confirmation skips them.
      for (const assignment of [...assignmentsRef.current]) {
        const granted = await run(
          () => grantMachineAccessAction(workspaceId, projectId, id, assignment),
          () => {
            changeAssignments(
              assignmentsRef.current.filter((a) => a.environmentId !== assignment.environmentId),
            );
          },
          () => void finish(),
        );
        if (!granted) return;
      }
      await run(
        () =>
          issueServiceCredentialAction(workspaceId, projectId, id, {
            name: credentialName,
            scopes,
            expiresInDays: Number(expiresInDays),
          }),
        (data) => {
          setIssued(data);
        },
        () => void finish(),
      );
    } finally {
      setPending(false);
    }
  }

  const roleName = (key: string) => roles.find((r) => r.key === key)?.name ?? key;

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={close}
      title={issued ? 'Store the credential' : `New machine identity · step ${String(step)} of 3`}
      description={
        issued
          ? undefined
          : step === 1
            ? 'Name it after the pipeline or server that will use it.'
            : step === 2
              ? 'Choose the environments it may use. Nothing is granted by default.'
              : 'Create its first credential. You see it once.'
      }
    >
      {issued ? (
        <CredentialReveal
          issued={issued}
          onDone={() => {
            const id = createdId;
            setIssued(null);
            reset();
            onOpenChange(false);
            if (id) router.push(`${base}/${id}`);
          }}
        />
      ) : step === 1 ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() === '') setErrors({ name: 'Enter a name' });
            else {
              setErrors({});
              setStep(2);
            }
          }}
        >
          <FormField label="Name" error={errors.name} required>
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={100}
                placeholder="GitHub Actions QA"
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            )}
          </FormField>
          <FormField label="Description" error={errors.description}>
            {(control) => (
              <Textarea
                {...control}
                value={description}
                maxLength={1000}
                rows={2}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            label="Longest credential lifetime"
            description="Credentials of this identity can never last longer."
            error={errors.credentialMaxLifetimeDays}
          >
            {(control) => (
              <NativeSelect
                {...control}
                value={lifetime}
                onChange={(e) => {
                  setLifetime(e.target.value);
                }}
              >
                {['7', '30', '90', '180', '365'].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <div className="flex justify-end">
            <Button type="submit">Next</Button>
          </div>
        </form>
      ) : step === 2 ? (
        <div className="flex flex-col gap-4">
          {environments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This project has no active environments.
            </p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Environment access">
              {environments.map((env) => {
                const current = assignments.find((a) => a.environmentId === env.id);
                return (
                  <li key={env.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                    <span className="flex-1 text-sm">
                      {env.name}
                      {env.isProtected ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          protected: you need this access there yourself
                        </span>
                      ) : null}
                    </span>
                    <NativeSelect
                      aria-label={`Access to ${env.name}`}
                      className="h-control-sm w-48"
                      value={current?.roleKey ?? ''}
                      onChange={(e) => {
                        const roleKey = e.target.value;
                        changeAssignments([
                          ...assignmentsRef.current.filter((a) => a.environmentId !== env.id),
                          ...(roleKey ? [{ environmentId: env.id, roleKey }] : []),
                        ]);
                      }}
                    >
                      <option value="">No access</option>
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            {roles
              .map((r) => `${r.name}: ${r.permissions.map((p) => SCOPE_LABELS[p] ?? p).join(', ')}`)
              .join('. ')}
            .
          </p>
          <div className="flex justify-between">
            <Button
              variant="outline"
              onClick={() => {
                setStep(1);
              }}
            >
              Back
            </Button>
            <Button
              onClick={() => {
                setStep(3);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void finish();
          }}
        >
          <FormField label="Credential name" required>
            {(control) => (
              <Input
                {...control}
                value={credentialName}
                maxLength={100}
                onChange={(e) => {
                  setCredentialName(e.target.value);
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
            <p className="text-xs text-muted-foreground">
              Scopes narrow what the grants allow; they never add to them. Write, export and
              administration are not possible for machines.
            </p>
          </fieldset>
          <FormField label="Expires after">
            {(control) => (
              <NativeSelect
                {...control}
                value={expiresInDays}
                onChange={(e) => {
                  setExpiresInDays(e.target.value);
                }}
              >
                {['7', '30', '90', '180', '365']
                  .filter((d) => Number(d) <= Number(lifetime))
                  .map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
              </NativeSelect>
            )}
          </FormField>
          {assignments.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Grants:{' '}
              {assignments
                .map(
                  (a) =>
                    `${environments.find((e) => e.id === a.environmentId)?.name ?? ''} (${roleName(a.roleKey)})`,
                )
                .join(', ')}
              . Creating them asks for your password.
            </p>
          ) : null}
          <div className="flex justify-between">
            <Button
              variant="outline"
              disabled={pending || createdId !== null}
              onClick={() => {
                setStep(2);
              }}
            >
              Back
            </Button>
            <Button type="submit" disabled={pending || scopes.length === 0} aria-busy={pending}>
              {pending ? 'Creating…' : createdId ? 'Continue' : 'Create identity'}
            </Button>
          </div>
        </form>
      )}
      {dialog}
    </ResponsiveModal>
  );
}
