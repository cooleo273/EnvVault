'use client';

import type { ProjectDetail, VisualColor, VisualIcon } from '@envvault/shared';
import { useActionState, useState } from 'react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { FormField } from '@/components/forms/form-field';
import { SettingsRow, SettingsSection } from '@/components/layout/settings-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { reportAction } from '@/lib/action-result';
import { type FormState, INITIAL_FORM_STATE } from '@/lib/form-state';
import {
  deleteProjectAction,
  duplicateProjectAction,
  setProjectArchivedAction,
  updateProjectAction,
} from './actions';
import { ColorPicker, IconPicker } from './pickers';
import { ProjectAvatar } from './visual';

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

export function ProjectGeneralSettings({
  workspaceId,
  project,
}: {
  workspaceId: string;
  project: ProjectDetail;
}) {
  const [state, action, pending] = useActionState(
    updateProjectAction.bind(null, workspaceId, project.id),
    INITIAL_FORM_STATE,
  );
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [icon, setIcon] = useState(project.icon as VisualIcon);
  const [color, setColor] = useState(project.color as VisualColor);
  const readOnly = project.status !== 'ACTIVE' || !project.permissions.includes('project:update');

  return (
    <form action={action} noValidate>
      <SettingsSection
        id="general"
        title="General"
        description="The URL is a stable identifier and cannot change."
        footer={
          <Button type="submit" disabled={pending || readOnly} aria-busy={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Message state={state} />
          <div className="flex items-center gap-3">
            <ProjectAvatar icon={icon} color={color} size="lg" />
            <span className="font-mono text-xs text-muted-foreground">{project.slug}</span>
          </div>
          <FormField label="Name" required {...fieldError(state, 'name')}>
            {(control) => (
              <Input
                {...control}
                name="name"
                value={name}
                maxLength={100}
                disabled={readOnly}
                onChange={(e) => {
                  setName(e.target.value);
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
                maxLength={1000}
                rows={3}
                disabled={readOnly}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
            )}
          </FormField>
          <div className="grid gap-4 md:grid-cols-2">
            <IconPicker name="icon" value={icon} onChange={setIcon} />
            <ColorPicker name="color" value={color} onChange={setColor} />
          </div>
        </div>
      </SettingsSection>
    </form>
  );
}

export function ProjectLifecycle({
  workspaceId,
  project,
  canDuplicate,
}: {
  workspaceId: string;
  project: ProjectDetail;
  canDuplicate: boolean;
}) {
  const can = (p: string) => project.permissions.includes(p);
  const archived = project.status === 'ARCHIVED';
  const [dupOpen, setDupOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [dupState, dupAction, dupPending] = useActionState(
    duplicateProjectAction.bind(null, workspaceId, project.id),
    INITIAL_FORM_STATE,
  );
  const [delState, delAction, delPending] = useActionState(
    deleteProjectAction.bind(null, workspaceId, project.id, project.slug),
    INITIAL_FORM_STATE,
  );
  const protectedNote =
    project.protectedEnvironmentCount > 0
      ? ` It has ${String(project.protectedEnvironmentCount)} protected environment(s); deleting also requires environment:protect.`
      : '';

  return (
    <SettingsSection
      id="danger-zone"
      title="Danger zone"
      tone="danger"
      description="Each action is recorded in the project activity."
    >
      <div className="flex flex-col divide-y [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        {canDuplicate ? (
          <SettingsRow
            title="Duplicate project"
            description="Copies metadata and the environment structure. Never members, grants or secret values."
            action={
              <ResponsiveModal
                open={dupOpen}
                onOpenChange={setDupOpen}
                title="Duplicate project"
                trigger={<Button variant="outline">Duplicate</Button>}
              >
                <form action={dupAction} className="flex flex-col gap-4" noValidate>
                  <Message state={dupState} />
                  <FormField label="Name of the copy" required {...fieldError(dupState, 'name')}>
                    {(control) => (
                      <Input {...control} name="name" defaultValue={`${project.name} copy`} />
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
        {can('project:archive') ? (
          <SettingsRow
            title={archived ? 'Restore project' : 'Archive project'}
            description={
              archived
                ? 'Makes the project editable again.'
                : 'Makes the project and its environments read-only.'
            }
            action={
              <ConfirmDialog
                title={archived ? 'Restore project?' : 'Archive project?'}
                description={
                  archived
                    ? 'Members can change the project again.'
                    : 'Nothing can change until it is restored. Members keep read access.'
                }
                confirmLabel={archived ? 'Restore' : 'Archive'}
                onConfirm={async () => {
                  await reportAction(setProjectArchivedAction(workspaceId, project.id, !archived));
                }}
                trigger={<Button variant="outline">{archived ? 'Restore' : 'Archive'}</Button>}
              />
            }
          />
        ) : null}
        {can('project:delete') ? (
          <SettingsRow
            title="Delete project"
            description={`Requires typed confirmation and your password.${protectedNote}`}
            action={
              <ResponsiveModal
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete project?"
                description="The project, its environments, members and grants become inaccessible. An administrator can recover it during the recovery window. Nothing is cascaded or purged immediately."
                trigger={<Button variant="destructive">Delete project</Button>}
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
                    label={`Type ${project.slug} to confirm`}
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
                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      variant="destructive"
                      disabled={delPending}
                      aria-busy={delPending}
                    >
                      {delPending ? 'Deleting…' : 'Delete project'}
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
