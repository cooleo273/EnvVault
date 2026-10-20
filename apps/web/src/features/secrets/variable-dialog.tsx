'use client';

import {
  createSecretInputSchema,
  SECRET_TYPE_DESCRIPTIONS,
  SECRET_TYPE_LABELS,
  SECRET_TYPES,
  type SecretSummary,
  type SecretType,
  secretValueProblem,
  STRICT_SECRET_TYPES,
  SUGGESTED_SECRET_CATEGORIES,
  updateSecretInputSchema,
} from '@envvault/shared';
import { EyeIcon, EyeOffIcon, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import type { z } from 'zod';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, Textarea } from '@/components/ui/textarea';
import { SwitchField } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { createSecretAction, updateSecretAction } from './actions';

export interface VariableDialogProps {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omitted: add a new variable. */
  secret?: SecretSummary;
  /** Prefills the name when adding (e.g. an expected key from the template). */
  initialKey?: string;
  /** Names on screen, for an early duplicate warning. The API has the final word. */
  knownKeys: readonly string[];
  categories: readonly string[];
}

interface Draft {
  key: string;
  type: SecretType;
  value: string;
  /** Add: store a value (possibly empty). Edit: replace the value. */
  setValue: boolean;
  description: string;
  category: string;
  tags: string;
  isRequired: boolean;
}

function initialDraft(secret: SecretSummary | undefined, initialKey: string | undefined): Draft {
  return {
    key: secret?.key ?? initialKey ?? '',
    type: secret?.type ?? 'SECRET',
    value: '',
    setValue: secret === undefined,
    description: secret?.description ?? '',
    category: secret?.category ?? '',
    tags: secret?.tags.join(', ') ?? '',
    isRequired: secret?.isRequired ?? false,
  };
}

function parseTags(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function issuesToFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) fields[String(issue.path[0] ?? 'form')] ??= issue.message;
  return fields;
}

const MULTILINE_TYPES: ReadonlySet<SecretType> = new Set<SecretType>(['MULTILINE', 'JSON']);

/**
 * Add or edit a variable. The value draft exists only in this component's
 * state and is cleared when the dialog closes or saves; it is never stored in
 * the browser. Editing never shows the current value: replacing it is an
 * explicit choice, and metadata only edits do not touch the stored value.
 */
export function VariableDialog({
  workspaceId,
  projectId,
  environmentId,
  open,
  onOpenChange,
  secret,
  initialKey,
  knownKeys,
  categories,
}: VariableDialogProps) {
  const router = useRouter();
  const formId = useId();
  const listId = useId();
  const editing = secret !== undefined;
  const [draft, setDraft] = useState<Draft>(() => initialDraft(secret, initialKey));
  const [showValue, setShowValue] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);

  function reset() {
    setDraft(initialDraft(secret, initialKey));
    setShowValue(false);
    setErrors({});
    setFormError(undefined);
    setConflict(false);
  }

  function close(next: boolean) {
    if (pending) return;
    if (!next) reset();
    onOpenChange(next);
  }

  function patch(changes: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...changes }));
  }

  const trimmedKey = draft.key.trim();
  const duplicate =
    trimmedKey !== '' && trimmedKey !== secret?.key && knownKeys.includes(trimmedKey);
  const valueProblem =
    draft.setValue && draft.value !== '' ? secretValueProblem(draft.type, draft.value) : null;
  const needsValue =
    editing &&
    !draft.setValue &&
    secret.hasValue &&
    draft.type !== secret.type &&
    STRICT_SECRET_TYPES.has(draft.type);

  function payload(): { ok: true; input: object } | { ok: false; fields: Record<string, string> } {
    const tags = parseTags(draft.tags);
    if (!editing) {
      const parsed = createSecretInputSchema.safeParse({
        key: draft.key,
        type: draft.type,
        ...(draft.setValue ? { value: draft.value } : {}),
        ...(draft.description.trim() ? { description: draft.description } : {}),
        ...(draft.category.trim() ? { category: draft.category } : {}),
        tags,
        isRequired: draft.isRequired,
      });
      return parsed.success
        ? { ok: true, input: parsed.data }
        : { ok: false, fields: issuesToFields(parsed.error) };
    }
    // Only changed fields are sent, so the audit log records what really changed.
    const changes: Record<string, unknown> = {};
    if (trimmedKey !== secret.key) changes.key = draft.key;
    if (draft.type !== secret.type) changes.type = draft.type;
    if (draft.description.trim() !== (secret.description ?? '')) {
      changes.description = draft.description.trim() === '' ? null : draft.description;
    }
    if (draft.category.trim() !== (secret.category ?? '')) {
      changes.category = draft.category.trim() === '' ? null : draft.category;
    }
    if (tags.map((t) => t.toLowerCase()).join(',') !== secret.tags.join(',')) changes.tags = tags;
    if (draft.isRequired !== secret.isRequired) changes.isRequired = draft.isRequired;
    if (draft.setValue) changes.value = draft.value;
    if (Object.keys(changes).length === 0)
      return { ok: false, fields: { form: 'Nothing has changed.' } };
    const parsed = updateSecretInputSchema.safeParse({
      expectedRevision: secret.revision,
      ...changes,
    });
    return parsed.success
      ? { ok: true, input: parsed.data }
      : { ok: false, fields: issuesToFields(parsed.error) };
  }

  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    if (duplicate) {
      setErrors({ key: 'A variable with that name already exists in this environment.' });
      return;
    }
    if (needsValue) {
      setErrors({ value: 'Enter a value of the new type when changing to it.' });
      return;
    }
    const built = payload();
    if (!built.ok) {
      const { form, ...fields } = built.fields;
      setErrors(fields);
      setFormError(form);
      return;
    }
    setPending(true);
    try {
      const result = editing
        ? await updateSecretAction(workspaceId, projectId, environmentId, secret.id, built.input)
        : await createSecretAction(workspaceId, projectId, environmentId, built.input);
      if (result.ok) {
        notify.success(result.message ?? 'Saved.');
        reset();
        onOpenChange(false);
        return;
      }
      if (result.code === 'SECRET_CONFLICT') {
        setConflict(true);
        return;
      }
      setErrors(result.fieldErrors ?? {});
      setFormError(result.fieldErrors ? undefined : result.message);
    } finally {
      setPending(false);
    }
  }

  const multiline = MULTILINE_TYPES.has(draft.type);
  const valueHidden = !showValue;
  const valueControlClass = cn('font-mono text-xs', valueHidden && 'secret-input-hidden');

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={close}
      title={editing ? `Edit ${secret.key}` : 'Add variable'}
      description={
        editing
          ? 'Change the name, details or value. The current value is never shown here.'
          : 'Values are encrypted on the server before they are stored.'
      }
      className="sm:max-w-xl"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              close(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending || conflict} aria-busy={pending}>
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Add variable'}
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
        {conflict ? (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning"
          >
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlert aria-hidden="true" className="size-4" />
              Someone else changed this variable while you were editing.
            </p>
            <p>Your changes were not saved. Reload to see the latest version, then edit again.</p>
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  close(false);
                  router.refresh();
                }}
              >
                Reload
              </Button>
            </div>
          </div>
        ) : null}
        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        ) : null}

        <FormField
          label="Name"
          required
          error={
            errors.key ?? (duplicate ? 'A variable with that name already exists here.' : undefined)
          }
          description="Letters, digits and underscores; cannot start with a digit. Case matters."
        >
          {(control) => (
            <Input
              {...control}
              value={draft.key}
              autoComplete="off"
              spellCheck={false}
              autoFocus={!editing}
              className="font-mono"
              placeholder="DATABASE_URL"
              onChange={(e) => {
                patch({ key: e.target.value });
              }}
            />
          )}
        </FormField>

        <FormField
          label="Type"
          description={SECRET_TYPE_DESCRIPTIONS[draft.type]}
          error={errors.type}
        >
          {(control) => (
            <NativeSelect
              {...control}
              value={draft.type}
              onChange={(e) => {
                patch({ type: e.target.value as SecretType });
              }}
            >
              {SECRET_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SECRET_TYPE_LABELS[type]}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>

        {editing ? (
          <SwitchField
            checked={draft.setValue}
            onCheckedChange={(checked) => {
              patch({ setValue: checked, value: '' });
            }}
            label={secret.hasValue ? 'Replace the value' : 'Set a value'}
            description="Saving a value creates a new version; earlier versions are kept."
          />
        ) : (
          <SwitchField
            checked={!draft.setValue}
            onCheckedChange={(checked) => {
              patch({ setValue: !checked, value: '' });
            }}
            label="No value yet"
            description="Create the variable now and set its value later. An empty value is different: it is stored as an empty string."
          />
        )}

        {draft.setValue ? (
          <FormField
            label="Value"
            error={errors.value ?? valueProblem ?? undefined}
            description={
              draft.type === 'JSON' && draft.value !== '' && !valueProblem
                ? 'Valid JSON.'
                : undefined
            }
          >
            {(control) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start gap-1">
                  {multiline ? (
                    <Textarea
                      {...control}
                      rows={draft.type === 'JSON' ? 8 : 6}
                      value={draft.value}
                      spellCheck={false}
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      className={valueControlClass}
                      onChange={(e) => {
                        patch({ value: e.target.value });
                      }}
                    />
                  ) : (
                    <Input
                      {...control}
                      type={valueHidden ? 'password' : 'text'}
                      value={draft.value}
                      spellCheck={false}
                      autoComplete="new-password"
                      data-1p-ignore
                      data-lpignore="true"
                      className="font-mono text-xs"
                      onChange={(e) => {
                        patch({ value: e.target.value });
                      }}
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-pressed={showValue}
                    aria-label={showValue ? 'Hide value' : 'Show value'}
                    onClick={() => {
                      setShowValue((v) => !v);
                    }}
                  >
                    {showValue ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
                  </Button>
                </div>
                {draft.type === 'JSON' ? (
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={draft.value === '' || valueProblem !== null}
                      onClick={() => {
                        patch({ value: JSON.stringify(JSON.parse(draft.value), null, 2) });
                      }}
                    >
                      Format JSON
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </FormField>
        ) : needsValue ? (
          <p role="alert" className="text-sm text-danger">
            Switching to {SECRET_TYPE_LABELS[draft.type]} needs a new value of that type.
          </p>
        ) : null}

        <FormField label="Description" error={errors.description}>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              value={draft.description}
              onChange={(e) => {
                patch({ description: e.target.value });
              }}
            />
          )}
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Category"
            error={errors.category}
            description="Pick one or type your own."
          >
            {(control) => (
              <>
                <Input
                  {...control}
                  list={listId}
                  value={draft.category}
                  autoComplete="off"
                  placeholder="General"
                  onChange={(e) => {
                    patch({ category: e.target.value });
                  }}
                />
                <datalist id={listId}>
                  {[...new Set([...SUGGESTED_SECRET_CATEGORIES, ...categories])].map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </>
            )}
          </FormField>
          <FormField label="Tags" error={errors.tags} description="Separate with commas or spaces.">
            {(control) => (
              <Input
                {...control}
                value={draft.tags}
                autoComplete="off"
                spellCheck={false}
                placeholder="backend, billing"
                onChange={(e) => {
                  patch({ tags: e.target.value });
                }}
              />
            )}
          </FormField>
        </div>

        <SwitchField
          checked={draft.isRequired}
          onCheckedChange={(checked) => {
            patch({ isRequired: checked });
          }}
          label="Required"
          description="The application expects this variable to be set."
        />
      </form>
    </ResponsiveModal>
  );
}
