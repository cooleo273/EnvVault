'use client';

import type {
  EnvironmentDetail,
  EnvironmentGrant,
  ProjectMember,
  ScopedRole,
} from '@envvault/shared';
import { ShieldCheck } from 'lucide-react';
import { useActionState, useState } from 'react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { EmptyState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { FormField } from '@/components/forms/form-field';
import { SettingsRow, SettingsSection } from '@/components/layout/settings-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SwitchField } from '@/components/ui/switch';
import { NativeSelect } from '@/components/ui/textarea';
import { reportAction } from '@/lib/action-result';
import { type FormState, INITIAL_FORM_STATE } from '@/lib/form-state';
import {
  deleteEnvironmentAction,
  duplicateEnvironmentAction,
  grantEnvironmentAccessAction,
  revokeEnvironmentAccessAction,
  saveEnvironmentAsTemplateAction,
  setEnvironmentArchivedAction,
  setEnvironmentProtectionAction,
} from './actions';

interface Ids {
  workspaceId: string;
  projectId: string;
  environmentId: string;
}

function fieldError(state: FormState, name: string): { error?: string } {
  const error = state.fieldErrors?.[name];
  return error ? { error } : {};
}

function Message({ state }: { state: FormState }) {
  if (!state.message) return null;
  return (
    <p
      role={state.status === 'error' ? 'alert' : 'status'}
      className={
        state.status === 'error'
          ? 'rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger'
          : 'rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success'
      }
    >
      {state.message}
    </p>
  );
}

/* --------------------------------------------------------------- Protection */

/**
 * EnvironmentProtectionSettings. Changes are confirmed; removing protection
 * requires the password (step-up). Approval counts are stored for the future
 * approval workflow and are not enforced yet — the UI says so.
 */
export function EnvironmentProtectionSettings({
  ids,
  environment,
  canProtect,
}: {
  ids: Ids;
  environment: EnvironmentDetail;
  canProtect: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isProtected, setIsProtected] = useState(environment.isProtected);
  const [approvals, setApprovals] = useState(environment.requiredApprovals);
  const [state, action, pending] = useActionState(
    setEnvironmentProtectionAction.bind(
      null,
      ids.workspaceId,
      ids.projectId,
      ids.environmentId,
      environment.isProtected,
    ),
    INITIAL_FORM_STATE,
  );
  const unprotecting = environment.isProtected && !isProtected;
  const archived = environment.status === 'ARCHIVED';

  return (
    <SettingsSection
      id="protection"
      title="Protection"
      description="Protected environments (typically production) require environment:protect for every change and never inherit secret access from project roles."
      badge={
        environment.isProtected ? (
          <span className="inline-flex items-center gap-1 rounded-sm border border-warning-border bg-warning-subtle px-1.5 py-px text-2xs font-medium text-warning">
            <ShieldCheck aria-hidden="true" className="size-3" />
            Protected
          </span>
        ) : (
          <StatusBadge tone="neutral" label="Not protected" dot={false} />
        )
      }
    >
      {state.status === 'success' ? <Message state={state} /> : null}
      <SettingsRow
        title={environment.isProtected ? 'Protection is on' : 'Protection is off'}
        description={
          canProtect
            ? 'Change who may modify this environment. Removing protection asks for your password.'
            : 'Only people with environment:protect (project or workspace admins) can change this.'
        }
        action={
          <ResponsiveModal
            open={open}
            onOpenChange={setOpen}
            title="Protection settings"
            description="These settings affect who may change this environment and how secret access is inherited."
            trigger={
              <Button variant="outline" disabled={!canProtect || archived}>
                Edit protection
              </Button>
            }
          >
            <form action={action} className="flex flex-col gap-4" noValidate>
              {state.status === 'error' ? <Message state={state} /> : null}
              <SwitchField
                name="isProtected"
                checked={isProtected}
                onCheckedChange={setIsProtected}
                label="Protected environment"
                description="Data-plane access (secret values, deployments) must be granted explicitly here."
              />
              <FormField
                label="Required approvals (planned)"
                description="Stored for the change-approval workflow of a later phase. Not enforced yet."
                {...fieldError(state, 'requiredApprovals')}
              >
                {(control) => (
                  <Input
                    {...control}
                    name="requiredApprovals"
                    type="number"
                    min={0}
                    max={10}
                    value={isProtected ? approvals : 0}
                    disabled={!isProtected}
                    onChange={(e) => {
                      setApprovals(Number(e.target.value));
                    }}
                  />
                )}
              </FormField>
              {unprotecting ? (
                <FormField
                  label="Confirm your password"
                  description="Removing protection is a sensitive action."
                  {...fieldError(state, 'password')}
                >
                  {(control) => (
                    <Input
                      {...control}
                      name="password"
                      type="password"
                      autoComplete="current-password"
                    />
                  )}
                </FormField>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={unprotecting ? 'destructive' : 'default'}
                  disabled={pending}
                  aria-busy={pending}
                >
                  {pending ? 'Saving…' : unprotecting ? 'Remove protection' : 'Save protection'}
                </Button>
              </div>
            </form>
          </ResponsiveModal>
        }
      />
    </SettingsSection>
  );
}

/* ---------------------------------------------------------- Permissions */

/** EnvironmentPermissions: ALLOW/DENY grants of environment roles to project members. */
export function EnvironmentPermissions({
  ids,
  environment,
  grants,
  roles,
  candidates,
}: {
  ids: Ids;
  environment: EnvironmentDetail;
  grants: EnvironmentGrant[];
  roles: ScopedRole[];
  candidates: Pick<ProjectMember, 'workspaceMembershipId' | 'user'>[];
}) {
  const [state, action, pending] = useActionState(
    grantEnvironmentAccessAction.bind(null, ids.workspaceId, ids.projectId, ids.environmentId),
    INITIAL_FORM_STATE,
  );
  const archived = environment.status === 'ARCHIVED';
  const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

  return (
    <SettingsSection
      id="access"
      title="Access"
      description="Grants apply to this environment only. DENY always wins over inherited permissions and ALLOW grants. People must belong to the project first."
    >
      <div className="flex flex-col gap-4">
        {grants.length === 0 ? (
          <EmptyState
            title="No environment-specific grants"
            description="Access comes from project roles only."
            className="py-6"
          />
        ) : (
          <ul className="divide-y rounded-md border" aria-label="Environment grants">
            {grants.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    {grant.user.displayName ?? grant.user.email}
                    {grant.isCurrentUser ? ' (you)' : ''}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {grant.role.name} · {grant.role.permissions.join(', ')}
                    {grant.expiresAt
                      ? ` · until ${dateFormat.format(new Date(grant.expiresAt))}`
                      : ''}
                  </span>
                </div>
                <StatusBadge
                  tone={grant.effect === 'DENY' ? 'danger' : 'success'}
                  label={grant.effect}
                  dot={false}
                />
                {!grant.isCurrentUser ? (
                  <ConfirmDialog
                    title="Revoke this grant?"
                    description={`${grant.user.displayName ?? grant.user.email} loses the "${grant.role.name}" ${grant.effect === 'DENY' ? 'restriction' : 'access'} on this environment immediately.`}
                    confirmLabel="Revoke"
                    destructive
                    onConfirm={async () => {
                      await reportAction(
                        revokeEnvironmentAccessAction(
                          ids.workspaceId,
                          ids.projectId,
                          ids.environmentId,
                          grant.id,
                        ),
                      );
                    }}
                    trigger={
                      <Button variant="ghost" size="sm" disabled={archived}>
                        Revoke
                      </Button>
                    }
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {candidates.length > 0 && !archived ? (
          <form
            action={action}
            className="grid gap-3 rounded-md border bg-surface-muted/50 p-3 md:grid-cols-[1fr_1fr_7rem_9rem_auto] md:items-end"
            noValidate
          >
            <FormField label="Person" {...fieldError(state, 'workspaceMembershipId')}>
              {(control) => (
                <NativeSelect {...control} name="workspaceMembershipId" defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {candidates.map((c) => (
                    <option key={c.workspaceMembershipId} value={c.workspaceMembershipId}>
                      {c.user.displayName ?? c.user.email}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Role" {...fieldError(state, 'roleKey')}>
              {(control) => (
                <NativeSelect {...control} name="roleKey" defaultValue="environment-viewer">
                  {roles.map((r) => (
                    <option key={r.key} value={r.key} title={r.permissions.join(', ')}>
                      {r.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Effect">
              {(control) => (
                <NativeSelect {...control} name="effect" defaultValue="ALLOW">
                  <option value="ALLOW">Allow</option>
                  <option value="DENY">Deny</option>
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Expires" description="Optional" {...fieldError(state, 'expiresAt')}>
              {(control) => <Input {...control} name="expiresAt" type="date" />}
            </FormField>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? 'Saving…' : 'Add grant'}
            </Button>
            <div className="md:col-span-5">
              <Message state={state} />
            </div>
          </form>
        ) : null}
      </div>
    </SettingsSection>
  );
}

/* ----------------------------------------------------------- Lifecycle */

export function EnvironmentLifecycle({
  ids,
  environment,
  canUpdate,
  canDelete,
  canDuplicate,
  canSaveTemplate,
}: {
  ids: Ids;
  environment: EnvironmentDetail;
  canUpdate: boolean;
  canDelete: boolean;
  canDuplicate: boolean;
  canSaveTemplate: boolean;
}) {
  const archived = environment.status === 'ARCHIVED';
  const [dupOpen, setDupOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [dupState, dupAction, dupPending] = useActionState(
    duplicateEnvironmentAction.bind(null, ids.workspaceId, ids.projectId, ids.environmentId),
    INITIAL_FORM_STATE,
  );
  const [tplState, tplAction, tplPending] = useActionState(
    saveEnvironmentAsTemplateAction.bind(null, ids.workspaceId, {
      name: environment.name,
      kind: environment.kind,
      description: environment.description ?? undefined,
      isProtected: environment.isProtected,
      color: environment.color,
      icon: environment.icon ?? undefined,
      expectedKeys: environment.expectedKeys,
    }),
    INITIAL_FORM_STATE,
  );
  const [delState, delAction, delPending] = useActionState(
    deleteEnvironmentAction.bind(
      null,
      ids.workspaceId,
      ids.projectId,
      ids.environmentId,
      environment.slug,
      environment.isProtected,
    ),
    INITIAL_FORM_STATE,
  );

  return (
    <SettingsSection
      id="lifecycle"
      title="Lifecycle"
      tone="danger"
      description="Duplicate, template, archive or delete. Each action is recorded in the project activity."
    >
      <div className="flex flex-col divide-y [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        {canDuplicate ? (
          <SettingsRow
            title="Duplicate environment"
            description="Copies the structure (type, protection, colors, expected keys). Never grants or values."
            action={
              <ResponsiveModal
                open={dupOpen}
                onOpenChange={setDupOpen}
                title="Duplicate environment"
                trigger={<Button variant="outline">Duplicate</Button>}
              >
                <form action={dupAction} className="flex flex-col gap-4" noValidate>
                  <Message state={dupState} />
                  <FormField label="Name of the copy" required {...fieldError(dupState, 'name')}>
                    {(control) => (
                      <Input {...control} name="name" defaultValue={`${environment.name} copy`} />
                    )}
                  </FormField>
                  <div className="flex justify-end">
                    <Button type="submit" disabled={dupPending} aria-busy={dupPending}>
                      {dupPending ? 'Duplicating…' : 'Duplicate'}
                    </Button>
                  </div>
                </form>
              </ResponsiveModal>
            }
          />
        ) : null}
        {canSaveTemplate ? (
          <SettingsRow
            title="Save as template"
            description="Reuse this environment’s structure in other projects of the workspace."
            action={
              <ResponsiveModal
                open={templateOpen}
                onOpenChange={setTemplateOpen}
                title="Save as workspace template"
                trigger={<Button variant="outline">Save as template</Button>}
              >
                <form action={tplAction} className="flex flex-col gap-4" noValidate>
                  <Message state={tplState} />
                  <FormField label="Template name" required {...fieldError(tplState, 'name')}>
                    {(control) => (
                      <Input {...control} name="name" defaultValue={environment.name} />
                    )}
                  </FormField>
                  <div className="flex justify-end">
                    <Button type="submit" disabled={tplPending} aria-busy={tplPending}>
                      {tplPending ? 'Saving…' : 'Save template'}
                    </Button>
                  </div>
                </form>
              </ResponsiveModal>
            }
          />
        ) : null}
        {canUpdate ? (
          <SettingsRow
            title={archived ? 'Restore environment' : 'Archive environment'}
            description={
              archived
                ? 'Makes it editable again.'
                : 'Makes it read-only and hides it from the default list.'
            }
            action={
              <ConfirmDialog
                title={archived ? 'Restore environment?' : 'Archive environment?'}
                description={
                  archived
                    ? 'The environment becomes editable again.'
                    : 'Settings and access can no longer be changed until it is restored.'
                }
                confirmLabel={archived ? 'Restore' : 'Archive'}
                onConfirm={async () => {
                  await reportAction(
                    setEnvironmentArchivedAction(
                      ids.workspaceId,
                      ids.projectId,
                      ids.environmentId,
                      !archived,
                    ),
                  );
                }}
                trigger={<Button variant="outline">{archived ? 'Restore' : 'Archive'}</Button>}
              />
            }
          />
        ) : null}
        {canDelete ? (
          <SettingsRow
            title="Delete environment"
            description={
              environment.isProtected
                ? 'Protected: requires typed confirmation and your password.'
                : 'Requires typed confirmation.'
            }
            action={
              <ResponsiveModal
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete environment?"
                description="Its settings, grants and (future) secrets become inaccessible. An administrator can recover it during the recovery window."
                trigger={<Button variant="destructive">Delete</Button>}
              >
                <form action={delAction} className="flex flex-col gap-4" noValidate>
                  {delState.message ? (
                    <p
                      role="alert"
                      className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger"
                    >
                      {delState.message}
                    </p>
                  ) : null}
                  <FormField
                    label={`Type ${environment.slug} to confirm`}
                    {...fieldError(delState, 'confirmation')}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        name="confirmation"
                        value={confirmation}
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono"
                        onChange={(e) => {
                          setConfirmation(e.target.value);
                        }}
                      />
                    )}
                  </FormField>
                  {environment.isProtected ? (
                    <FormField label="Confirm your password" {...fieldError(delState, 'password')}>
                      {(control) => (
                        <Input
                          {...control}
                          name="password"
                          type="password"
                          autoComplete="current-password"
                        />
                      )}
                    </FormField>
                  ) : null}
                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      variant="destructive"
                      disabled={delPending}
                      aria-busy={delPending}
                    >
                      {delPending ? 'Deleting…' : 'Delete environment'}
                    </Button>
                  </div>
                </form>
              </ResponsiveModal>
            }
          />
        ) : null}
      </div>
    </SettingsSection>
  );
}
