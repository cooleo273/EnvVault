'use client';

import type { WorkspaceType } from '@envvault/shared';
import { Building2, User } from 'lucide-react';
import { useActionState, useState } from 'react';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { type FormState, INITIAL_FORM_STATE } from '@/lib/form-state';
import { cn } from '@/lib/utils';
import { createWorkspaceAction } from './actions';

/** Client-side preview of the server's slug generation (the server decides). */
export function previewSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'workspace'
  );
}

function fieldError(state: FormState, name: string): { error?: string } {
  const error = state.fieldErrors?.[name];
  return error ? { error } : {};
}

const TYPES: { value: WorkspaceType; label: string; description: string; icon: typeof User }[] = [
  {
    value: 'PERSONAL',
    label: 'Personal',
    description: 'For your own projects. You can invite people later.',
    icon: User,
  },
  {
    value: 'TEAM',
    label: 'Team',
    description: 'Shared with colleagues, with roles and invitations.',
    icon: Building2,
  },
];

export function WorkspaceTypePicker({
  value,
  onChange,
}: {
  value: WorkspaceType;
  onChange: (value: WorkspaceType) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">Workspace type</legend>
      {/* Submitted from state: React's post-action form reset would revert the radios. */}
      <input type="hidden" name="type" value={value} />
      <div className="grid gap-2 sm:grid-cols-2">
        {TYPES.map((type) => {
          const Icon = type.icon;
          const checked = value === type.value;
          return (
            <label
              key={type.value}
              className={cn(
                'flex cursor-pointer gap-3 rounded-lg border bg-surface p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                checked ? 'border-brand bg-accent' : 'hover:bg-accent',
              )}
            >
              <input
                type="radio"
                name="type-choice"
                value={type.value}
                checked={checked}
                onChange={() => {
                  onChange(type.value);
                }}
                className="sr-only"
              />
              <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{type.label}</span>
                <span className="text-xs text-muted-foreground">{type.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export interface CreateWorkspaceFormProps {
  /** `dashboard` during onboarding; otherwise the new workspace opens. */
  next?: 'dashboard' | 'workspace';
  defaultType?: WorkspaceType;
  /** Hide the type picker (the onboarding wizard asks for it in its own step). */
  showType?: boolean;
  onBack?: () => void;
  submitLabel?: string;
}

export function CreateWorkspaceForm({
  next = 'workspace',
  defaultType = 'TEAM',
  showType = true,
  onBack,
  submitLabel = 'Create workspace',
}: CreateWorkspaceFormProps) {
  const [state, action, pending] = useActionState(createWorkspaceAction, INITIAL_FORM_STATE);
  const [type, setType] = useState<WorkspaceType>(defaultType);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state.status === 'error' && state.message ? (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger"
        >
          {state.message}
        </p>
      ) : null}
      <input type="hidden" name="next" value={next} />
      {showType ? (
        <WorkspaceTypePicker value={type} onChange={setType} />
      ) : (
        <input type="hidden" name="type" value={type} />
      )}
      <FormField label="Workspace name" required {...fieldError(state, 'name')}>
        {(control) => (
          <Input
            {...control}
            name="name"
            value={name}
            autoFocus
            maxLength={100}
            placeholder={type === 'PERSONAL' ? 'My projects' : 'Acme Engineering'}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        )}
      </FormField>
      <FormField
        label="URL"
        description={
          slug
            ? 'Lowercase letters, numbers and single dashes. Cannot be changed later.'
            : `Leave empty to use “${previewSlug(name || 'workspace')}”. Cannot be changed later.`
        }
        {...fieldError(state, 'slug')}
      >
        {(control) => (
          <Input
            {...control}
            name="slug"
            value={slug}
            maxLength={63}
            placeholder={previewSlug(name || 'workspace')}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setSlug(event.target.value.toLowerCase());
            }}
          />
        )}
      </FormField>
      <FormField label="Description" description="Optional." {...fieldError(state, 'description')}>
        {(control) => (
          <Textarea
            {...control}
            name="description"
            value={description}
            maxLength={500}
            rows={2}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        )}
      </FormField>
      <div className="flex justify-end gap-2">
        {onBack ? (
          <Button type="button" variant="outline" onClick={onBack} disabled={pending}>
            Back
          </Button>
        ) : null}
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? 'Creating…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
