'use client';

import type {
  EnvironmentTemplate,
  EnvironmentTemplateEntry,
  VisualColor,
  VisualIcon,
} from '@envvault/shared';
import { useActionState, useState } from 'react';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { previewSlug } from '@/features/workspaces/create-workspace-form';
import { type FormState, INITIAL_FORM_STATE } from '@/lib/form-state';
import { createProjectAction } from './actions';
import { ColorPicker, EnvironmentTemplateSelector, IconPicker, templateChoices } from './pickers';
import { ProjectAvatar } from './visual';

function fieldError(state: FormState, name: string): { error?: string } {
  const error = state.fieldErrors?.[name];
  return error ? { error } : {};
}

const DEFAULT_SELECTION = ['builtin:development', 'builtin:staging', 'builtin:production'];

export function CreateProjectForm({
  workspaceId,
  templates,
}: {
  workspaceId: string;
  templates: EnvironmentTemplate[];
}) {
  const [state, action, pending] = useActionState(
    createProjectAction.bind(null, workspaceId),
    INITIAL_FORM_STATE,
  );
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<VisualIcon>('folder');
  const [color, setColor] = useState<VisualColor>('blue');
  const choices = templateChoices(templates);
  const [selected, setSelected] = useState<string[]>(
    DEFAULT_SELECTION.filter((id) => choices.some((c) => c.id === id)),
  );

  const environments: EnvironmentTemplateEntry[] = choices
    .filter((c) => selected.includes(c.id))
    .map((c) => c.entry);

  return (
    <form action={action} className="flex flex-col gap-6" noValidate>
      {state.status === 'error' && state.message ? (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger"
        >
          {state.message}
        </p>
      ) : null}
      <input type="hidden" name="environments" value={JSON.stringify(environments)} />

      <section
        className="flex flex-col gap-4 rounded-lg border bg-surface p-5"
        aria-labelledby="project-details"
      >
        <div className="flex items-center gap-3">
          <ProjectAvatar icon={icon} color={color} size="lg" />
          <h2 id="project-details" className="text-sm font-semibold">
            Project details
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Project name" required {...fieldError(state, 'name')}>
            {(control) => (
              <Input
                {...control}
                name="name"
                value={name}
                maxLength={100}
                autoFocus
                placeholder="E-Commerce Backend"
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            label="URL"
            description={`Leave empty to use “${previewSlug(name || 'project')}”. Unique in this workspace.`}
            {...fieldError(state, 'slug')}
          >
            {(control) => (
              <Input
                {...control}
                name="slug"
                value={slug}
                maxLength={63}
                className="font-mono"
                placeholder={previewSlug(name || 'project')}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setSlug(e.target.value.toLowerCase());
                }}
              />
            )}
          </FormField>
        </div>
        <FormField
          label="Description"
          description="Optional."
          {...fieldError(state, 'description')}
        >
          {(control) => (
            <Textarea
              {...control}
              name="description"
              value={description}
              maxLength={1000}
              rows={2}
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
      </section>

      <section
        className="flex flex-col gap-3 rounded-lg border bg-surface p-5"
        aria-labelledby="project-environments"
      >
        <div className="flex flex-col gap-0.5">
          <h2 id="project-environments" className="text-sm font-semibold">
            Environments
          </h2>
          <p className="text-sm text-muted-foreground">
            Pick any number to start with ({selected.length} selected). You can add custom
            environments, rename or remove them later. Protected environments never inherit secret
            access.
          </p>
        </div>
        <EnvironmentTemplateSelector
          templates={templates}
          selected={selected}
          onToggle={(id) => {
            setSelected((current) =>
              current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
            );
          }}
        />
        {state.fieldErrors?.environments ? (
          <p className="text-sm text-danger">{state.fieldErrors.environments}</p>
        ) : null}
      </section>

      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? 'Creating…' : 'Create project'}
        </Button>
      </div>
    </form>
  );
}
