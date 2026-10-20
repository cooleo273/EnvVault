'use client';

import type { ProjectAccessList, ScopedRole, WorkspaceMember } from '@envvault/shared';
import { useActionState, useState, useTransition } from 'react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { SettingsSection } from '@/components/layout/settings-section';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/textarea';
import { reportAction } from '@/lib/action-result';
import { INITIAL_FORM_STATE } from '@/lib/form-state';
import {
  addProjectMemberAction,
  changeProjectMemberRoleAction,
  removeProjectMemberAction,
} from './actions';

function RoleSelect({
  workspaceId,
  projectId,
  memberId,
  name,
  value,
  roles,
}: {
  workspaceId: string;
  projectId: string;
  memberId: string;
  name: string;
  value: string;
  roles: ScopedRole[];
}) {
  const [current, setCurrent] = useState(value);
  const [pending, startTransition] = useTransition();
  return (
    <NativeSelect
      aria-label={`Project role for ${name}`}
      value={current}
      disabled={pending}
      className="h-control-sm w-48"
      onChange={(e) => {
        const next = e.target.value;
        const previous = current;
        setCurrent(next);
        startTransition(async () => {
          const result = await changeProjectMemberRoleAction(
            workspaceId,
            projectId,
            memberId,
            next,
          );
          if (result.ok) notify.success(result.message ?? 'Updated.');
          else {
            setCurrent(previous);
            notify.error(result.message);
          }
        });
      }}
    >
      {roles.map((r) => (
        <option key={r.key} value={r.key}>
          {r.name}
        </option>
      ))}
    </NativeSelect>
  );
}

/**
 * ProjectMemberManager: who has access to the project. Explicit members get a
 * project role; workspace owners/admins have inherited administrative access
 * (never secret values). Only existing workspace members can be added.
 */
export function ProjectMemberManager({
  workspaceId,
  projectId,
  access,
  roles,
  workspaceMembers,
  canManage,
}: {
  workspaceId: string;
  projectId: string;
  access: ProjectAccessList;
  roles: ScopedRole[];
  workspaceMembers: WorkspaceMember[];
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState(
    addProjectMemberAction.bind(null, workspaceId, projectId),
    INITIAL_FORM_STATE,
  );
  const memberIds = new Set(access.members.map((m) => m.workspaceMembershipId));
  const addable = workspaceMembers.filter((m) => !memberIds.has(m.id) && !m.isCurrentUser);
  const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        id="project-members"
        title="Project members"
        description="Project roles apply to this project and its environments. Protected environments still need explicit grants for secret access."
      >
        <div className="flex flex-col gap-4">
          {access.members.length === 0 ? (
            <EmptyState title="No project members" className="py-6" />
          ) : (
            <ul className="divide-y rounded-md border" aria-label="Project members">
              {access.members.map((m) => {
                const name = m.user.displayName ?? m.user.email;
                return (
                  <li
                    key={m.id}
                    className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center"
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2 truncate text-sm font-medium">
                        {name}
                        {m.isCurrentUser ? (
                          <StatusBadge tone="info" label="You" dot={false} />
                        ) : null}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {m.user.email} · added {dateFormat.format(new Date(m.createdAt))}
                      </span>
                    </div>
                    {canManage && !m.isCurrentUser ? (
                      <div className="flex items-center gap-1">
                        <RoleSelect
                          workspaceId={workspaceId}
                          projectId={projectId}
                          memberId={m.id}
                          name={name}
                          value={m.role.key}
                          roles={roles}
                        />
                        <ConfirmDialog
                          title={`Remove ${name} from the project?`}
                          description="They lose project access and every environment grant in this project immediately."
                          confirmLabel="Remove"
                          destructive
                          onConfirm={async () => {
                            await reportAction(
                              removeProjectMemberAction(workspaceId, projectId, m.id),
                            );
                          }}
                          trigger={
                            <Button variant="ghost" size="sm" aria-label={`Remove ${name}`}>
                              Remove
                            </Button>
                          }
                        />
                      </div>
                    ) : (
                      <span className="text-sm">{m.role.name}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Outside the form: the form disappears once everyone is a member. */}
          {state.message ? (
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
          ) : null}
          {canManage ? (
            addable.length > 0 ? (
              <form
                action={action}
                className="grid gap-3 rounded-md border bg-surface-muted/50 p-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
                noValidate
              >
                <FormField
                  label="Workspace member"
                  {...(state.fieldErrors?.workspaceMembershipId
                    ? { error: state.fieldErrors.workspaceMembershipId }
                    : {})}
                >
                  {(control) => (
                    <NativeSelect {...control} name="workspaceMembershipId" defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {addable.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.user.displayName
                            ? `${m.user.displayName} (${m.user.email})`
                            : m.user.email}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </FormField>
                <FormField label="Project role">
                  {(control) => (
                    <NativeSelect {...control} name="roleKey" defaultValue="project-developer">
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.name}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </FormField>
                <Button type="submit" disabled={pending} aria-busy={pending}>
                  {pending ? 'Adding…' : 'Add to project'}
                </Button>
              </form>
            ) : (
              <p className="text-xs text-muted-foreground">
                Everyone in the workspace is already a member. Invite people to the workspace to add
                more.
              </p>
            )
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        id="inherited-access"
        title="Workspace administrators"
        description="Workspace owners and admins administer every project (settings, environments, members) but never see secret values through that role."
      >
        <ul className="divide-y rounded-md border" aria-label="Inherited access">
          {access.inherited.map((i) => (
            <li
              key={i.workspaceMembershipId}
              className="flex items-center gap-2 px-3 py-2.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {i.user.displayName ?? i.user.email}
                {i.isCurrentUser ? ' (you)' : ''}
              </span>
              <StatusBadge tone="neutral" label={`Workspace ${i.workspaceRole.name}`} dot={false} />
            </li>
          ))}
        </ul>
      </SettingsSection>

      <SettingsSection id="role-reference" title="Project roles">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {roles.map((r) => (
            <div key={r.key} className="flex flex-col gap-0.5">
              <dt className="font-medium">{r.name}</dt>
              <dd className="text-xs text-muted-foreground">{r.description}</dd>
            </div>
          ))}
        </dl>
      </SettingsSection>
    </div>
  );
}
