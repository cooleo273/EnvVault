'use client';

import type { WorkspaceDetail, WorkspaceMember } from '@envvault/shared';
import { useActionState, useState } from 'react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { FormField } from '@/components/forms/form-field';
import { SettingsRow, SettingsSection } from '@/components/layout/settings-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, Textarea } from '@/components/ui/textarea';
import { reportAction } from '@/lib/action-result';
import { type FormState, INITIAL_FORM_STATE } from '@/lib/form-state';
import {
  archiveWorkspaceAction,
  deleteWorkspaceAction,
  restoreWorkspaceAction,
  transferOwnershipAction,
  updateWorkspaceAction,
} from './actions';

function fieldError(state: FormState, name: string): { error?: string } {
  const error = state.fieldErrors?.[name];
  return error ? { error } : {};
}

function FormMessage({ state }: { state: FormState }) {
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

export function GeneralSettings({ workspace }: { workspace: WorkspaceDetail }) {
  const [state, action, pending] = useActionState(
    updateWorkspaceAction.bind(null, workspace.id),
    INITIAL_FORM_STATE,
  );
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? '');
  const readOnly = workspace.archivedAt !== null;

  return (
    <form action={action} noValidate>
      <SettingsSection
        id="general"
        title="General"
        description="Shown to everyone in the workspace."
        footer={
          <Button type="submit" disabled={pending || readOnly} aria-busy={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        }
      >
        <div className="flex max-w-xl flex-col gap-4">
          <FormMessage state={state} />
          <FormField label="Name" required {...fieldError(state, 'name')}>
            {(control) => (
              <Input
                {...control}
                name="name"
                value={name}
                maxLength={100}
                disabled={readOnly}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField label="Description" {...fieldError(state, 'description')}>
            {(control) => (
              <Textarea
                {...control}
                name="description"
                value={description}
                maxLength={500}
                rows={3}
                disabled={readOnly}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField label="URL" description="The workspace URL cannot be changed.">
            {(control) => (
              <Input {...control} value={workspace.slug} readOnly className="font-mono" />
            )}
          </FormField>
        </div>
      </SettingsSection>
    </form>
  );
}

export function TransferOwnership({
  workspace,
  candidates,
}: {
  workspace: WorkspaceDetail;
  candidates: WorkspaceMember[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(
    transferOwnershipAction.bind(null, workspace.id),
    INITIAL_FORM_STATE,
  );
  return (
    <SettingsRow
      title="Transfer ownership"
      description={
        candidates.length === 0
          ? 'Invite another member first: ownership can only go to an existing member.'
          : 'Make another member the owner. You will become an admin.'
      }
      action={
        <ResponsiveModal
          open={open}
          onOpenChange={setOpen}
          title="Transfer ownership"
          description="The new owner gets full control, including deletion. You become an admin. Confirm with your password."
          trigger={
            <Button
              variant="outline"
              disabled={candidates.length === 0 || workspace.archivedAt !== null}
            >
              Transfer ownership
            </Button>
          }
        >
          <form action={action} className="flex flex-col gap-4" noValidate>
            <FormMessage state={state.status === 'error' ? state : INITIAL_FORM_STATE} />
            <FormField label="New owner" {...fieldError(state, 'membershipId')}>
              {(control) => (
                <NativeSelect {...control} name="membershipId" defaultValue="">
                  <option value="" disabled>
                    Choose a member
                  </option>
                  {candidates.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.user.displayName
                        ? `${member.user.displayName} (${member.user.email})`
                        : member.user.email}{' '}
                      · {member.role.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField
              label="Confirm your password"
              description="Sensitive actions require re-entering your password."
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
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? 'Transferring…' : 'Transfer ownership'}
              </Button>
            </div>
          </form>
        </ResponsiveModal>
      }
    />
  );
}

export function ArchiveSettings({ workspace }: { workspace: WorkspaceDetail }) {
  if (workspace.archivedAt) {
    return (
      <SettingsRow
        title="Restore workspace"
        description="Makes the workspace editable again and shows it in the switcher."
        action={
          <ConfirmDialog
            title="Restore workspace?"
            description="Members regain normal access according to their roles."
            confirmLabel="Restore"
            onConfirm={async () => {
              await reportAction(restoreWorkspaceAction(workspace.id));
            }}
            trigger={<Button variant="outline">Restore workspace</Button>}
          />
        }
      />
    );
  }
  return (
    <SettingsRow
      title="Archive workspace"
      description="Makes the workspace read-only and hides it from the switcher. You can restore it at any time."
      action={
        <ConfirmDialog
          title="Archive workspace?"
          description="Settings, members and invitations can no longer be changed until an owner restores the workspace. Pending invitations stop working."
          confirmLabel="Archive"
          onConfirm={async () => {
            await reportAction(archiveWorkspaceAction(workspace.id));
          }}
          trigger={<Button variant="outline">Archive workspace</Button>}
        />
      }
    />
  );
}

/**
 * Sensitive action UI: typed confirmation plus password re-entry. The API
 * enforces both the permission and a fresh step-up; this form only collects
 * the password so the server can re-verify it with Neon Auth.
 */
export function DeleteWorkspace({ workspace }: { workspace: WorkspaceDetail }) {
  const [open, setOpen] = useState(false);
  // Controlled so a failed attempt keeps it: React resets uncontrolled fields
  // after every action. The password is deliberately left to be cleared.
  const [confirmation, setConfirmation] = useState('');
  const [state, action, pending] = useActionState(
    deleteWorkspaceAction.bind(null, workspace.id, workspace.slug),
    INITIAL_FORM_STATE,
  );

  return (
    <SettingsRow
      title="Delete workspace"
      description="Requires the owner role, typed confirmation and your password."
      action={
        <ResponsiveModal
          open={open}
          onOpenChange={setOpen}
          title="Delete workspace?"
          description="All projects, environments and secrets in this workspace become inaccessible. An administrator can restore it during the recovery window."
          trigger={<Button variant="destructive">Delete workspace</Button>}
        >
          <form action={action} className="flex flex-col gap-4" noValidate>
            {state.message ? (
              <p
                role="alert"
                className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger"
              >
                {state.message}
              </p>
            ) : null}
            <FormField
              label={`Type ${workspace.slug} to confirm`}
              {...fieldError(state, 'confirmation')}
            >
              {(control) => (
                <Input
                  {...control}
                  name="confirmation"
                  value={confirmation}
                  onChange={(event) => {
                    setConfirmation(event.target.value);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  required
                />
              )}
            </FormField>
            <FormField
              label="Confirm your password"
              description="Sensitive actions require re-entering your password."
              {...fieldError(state, 'password')}
            >
              {(control) => (
                <Input
                  {...control}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              )}
            </FormField>
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
              <Button type="submit" variant="destructive" disabled={pending} aria-busy={pending}>
                {pending ? 'Deleting…' : 'Delete workspace'}
              </Button>
            </div>
          </form>
        </ResponsiveModal>
      }
    />
  );
}
