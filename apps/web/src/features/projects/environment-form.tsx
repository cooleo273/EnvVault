'use client';

import {
  DEFAULT_ENVIRONMENT_COLORS,
  ENVIRONMENT_KIND_LABELS,
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  type VisualColor,
  type VisualIcon,
} from '@envvault/shared';
import { useActionState, useState } from 'react';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, Textarea } from '@/components/ui/textarea';
import { previewSlug } from '@/features/workspaces/create-workspace-form';
import { type FormState, INITIAL_FORM_STATE } from '@/lib/form-state';
import { createEnvironmentAction, updateEnvironmentAction } from './actions';
import { ColorPicker, IconPicker } from './pickers';
import { EnvironmentIcon } from './visual';

function fieldError(state: FormState, name: string): { error?: string } {
  const error = state.fieldErrors?.[name];
  return error ? { error } : {};
}

export interface EnvironmentFormValues {
  name: string;
  slug?: string;
  kind: EnvironmentKind;
  description: string;
  color: VisualColor;
  icon: VisualIcon | null;
  isProtected: boolean;
  expectedKeys: string;
  templateId?: string | undefined;
}

type Props =
  | {
      mode: 'create';
      workspaceId: string;
      projectId: string;
      initial: EnvironmentFormValues;
      canProtect: boolean;
    }
  | {
      mode: 'edit';
      workspaceId: string;
      projectId: string;
      environmentId: string;
      slug: string;
      initial: EnvironmentFormValues;
      disabled: boolean;
    };

/** Create or edit an environment's metadata (never values). */
export function EnvironmentForm(props: Props) {
  const action =
    props.mode === 'create'
      ? createEnvironmentAction.bind(null, props.workspaceId, props.projectId)
      : updateEnvironmentAction.bind(null, props.workspaceId, props.projectId, props.environmentId);
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const [values, setValues] = useState(props.initial);
  const set = <K extends keyof EnvironmentFormValues>(key: K, value: EnvironmentFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };
  const disabled = props.mode === 'edit' && props.disabled;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
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
      {values.templateId ? (
        <input type="hidden" name="templateId" value={values.templateId} />
      ) : null}
      <div className="flex items-center gap-3">
        <EnvironmentIcon icon={values.icon} kind={values.kind} color={values.color} />
        <p className="text-sm text-muted-foreground">
          {props.mode === 'edit'
            ? 'Renaming keeps the environment’s id and URL, so integrations keep working.'
            : 'Every environment has its own id, settings and access.'}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="Name" required {...fieldError(state, 'name')}>
          {(control) => (
            <Input
              {...control}
              name="name"
              value={values.name}
              maxLength={64}
              disabled={disabled}
              autoFocus={props.mode === 'create'}
              onChange={(e) => {
                set('name', e.target.value);
              }}
            />
          )}
        </FormField>
        {props.mode === 'create' ? (
          <FormField
            label="URL"
            description={`Leave empty to use “${previewSlug(values.name || 'environment')}”. Cannot change later.`}
            {...fieldError(state, 'slug')}
          >
            {(control) => (
              <Input
                {...control}
                name="slug"
                value={values.slug ?? ''}
                maxLength={63}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder={previewSlug(values.name || 'environment')}
                onChange={(e) => {
                  set('slug', e.target.value.toLowerCase());
                }}
              />
            )}
          </FormField>
        ) : (
          <FormField label="URL" description="Stable identifier; cannot be changed.">
            {(control) => <Input {...control} value={props.slug} readOnly className="font-mono" />}
          </FormField>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="Type" {...fieldError(state, 'kind')}>
          {(control) => (
            <NativeSelect
              {...control}
              name="kind"
              value={values.kind}
              disabled={disabled}
              onChange={(e) => {
                const kind = e.target.value as EnvironmentKind;
                set('kind', kind);
                if (props.mode === 'create') set('color', DEFAULT_ENVIRONMENT_COLORS[kind]);
              }}
            >
              {ENVIRONMENT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {ENVIRONMENT_KIND_LABELS[kind]}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <FormField
          label="Description"
          description="Optional."
          {...fieldError(state, 'description')}
        >
          {(control) => (
            <Input
              {...control}
              name="description"
              value={values.description}
              maxLength={1000}
              disabled={disabled}
              onChange={(e) => {
                set('description', e.target.value);
              }}
            />
          )}
        </FormField>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ColorPicker
          name="color"
          value={values.color}
          onChange={(color) => {
            set('color', color);
          }}
        />
        <IconPicker
          name="icon"
          value={values.icon ?? ''}
          onChange={(icon) => {
            set('icon', icon);
          }}
        />
      </div>
      <FormField
        label="Expected variables"
        description="Optional. One key per line (e.g. DATABASE_URL or API_KEY - Payment provider key). Names only — values arrive with secrets management in the next phase."
        {...fieldError(state, 'expectedKeys')}
      >
        {(control) => (
          <Textarea
            {...control}
            name="expectedKeys"
            value={values.expectedKeys}
            rows={4}
            disabled={disabled}
            className="font-mono text-xs"
            spellCheck={false}
            onChange={(e) => {
              set('expectedKeys', e.target.value);
            }}
          />
        )}
      </FormField>
      {props.mode === 'create' ? (
        <label className="flex items-start gap-3 rounded-md border bg-surface-muted p-3">
          <input
            type="checkbox"
            name="isProtected"
            checked={values.isProtected}
            disabled={!props.canProtect}
            onChange={(e) => {
              set('isProtected', e.target.checked);
            }}
            className="mt-0.5 size-4"
          />
          <span className="flex flex-col gap-0.5 text-sm">
            <span className="font-medium">Protected environment</span>
            <span className="text-xs text-muted-foreground">
              Changes need the environment:protect permission, and secret access is never inherited
              from project roles. Recommended for production.
              {props.canProtect ? '' : ' You cannot create protected environments in this project.'}
            </span>
          </span>
        </label>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending || disabled} aria-busy={pending}>
          {pending ? 'Saving…' : props.mode === 'create' ? 'Create environment' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
