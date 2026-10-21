'use client';

import {
  INTELLIGENCE_LIMITS,
  NAMING_RULE_KEY,
  VALUE_FORMATS,
  type ValidationRule,
  validationRuleInputSchema,
  type ValueFormat,
} from '@envvault/shared';
import { ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { EmptyState } from '@/components/feedback/states';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { SettingsSection } from '@/components/layout/settings-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SwitchField } from '@/components/ui/switch';
import { NativeSelect, Textarea } from '@/components/ui/textarea';
import { replaceValidationRulesAction } from './actions';

type Rule = Omit<ValidationRule, 'id' | 'updatedAt' | 'updatedBy'>;

const FORMAT_LABELS: Record<ValueFormat, string> = {
  ANY: 'Any text',
  URL: 'URL',
  JSON: 'JSON',
  NUMBER: 'Number',
};

function fromRule(rule: ValidationRule): Rule {
  return {
    key: rule.key,
    required: rule.required,
    allowEmpty: rule.allowEmpty,
    format: rule.format,
    minNumber: rule.minNumber,
    maxNumber: rule.maxNumber,
    minLength: rule.minLength,
    maxLength: rule.maxLength,
    pattern: rule.pattern,
    allowedValues: rule.allowedValues,
    description: rule.description,
  };
}

const EMPTY: Rule = {
  key: '',
  required: true,
  allowEmpty: false,
  format: 'ANY',
  minNumber: null,
  maxNumber: null,
  minLength: null,
  maxLength: null,
  pattern: null,
  allowedValues: [],
  description: null,
};

function summary(rule: Rule): string {
  const parts: string[] = [];
  if (rule.key === NAMING_RULE_KEY) parts.push('Every variable name');
  if (rule.required) parts.push('required');
  if (!rule.allowEmpty) parts.push('not empty');
  if (rule.format !== 'ANY') parts.push(FORMAT_LABELS[rule.format]);
  if (rule.minNumber !== null || rule.maxNumber !== null) {
    parts.push(
      `between ${rule.minNumber === null ? 'any' : String(rule.minNumber)} and ${rule.maxNumber === null ? 'any' : String(rule.maxNumber)}`,
    );
  }
  if (rule.minLength !== null || rule.maxLength !== null) {
    parts.push(
      `${rule.minLength === null ? '0' : String(rule.minLength)} to ${rule.maxLength === null ? 'any' : String(rule.maxLength)} characters`,
    );
  }
  if (rule.pattern !== null) parts.push(`matches ${rule.pattern}`);
  if (rule.allowedValues.length > 0)
    parts.push(`one of ${String(rule.allowedValues.length)} values`);
  return parts.join(' · ') || 'No constraints';
}

const numberOrNull = (text: string) => (text.trim() === '' ? null : Number(text));
const intOrNull = (text: string) => (text.trim() === '' ? null : Number.parseInt(text, 10));

function RuleDialog({
  open,
  initial,
  existingKeys,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  initial: Rule;
  existingKeys: readonly string[];
  onOpenChange: (open: boolean) => void;
  onSave: (rule: Rule) => void;
}) {
  const [rule, setRule] = useState<Rule>(initial);
  const [allowed, setAllowed] = useState(initial.allowedValues.join('\n'));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const naming = rule.key === NAMING_RULE_KEY;
  const set = (patch: Partial<Rule>) => {
    setRule((r) => ({ ...r, ...patch }));
  };

  function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = {
      ...rule,
      allowedValues: allowed
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean),
      description: rule.description?.trim() ? rule.description.trim() : null,
    };
    const parsed = validationRuleInputSchema.safeParse(candidate);
    const next: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'key');
        next[field] ??= issue.message;
      }
    }
    if (candidate.key !== initial.key && existingKeys.includes(candidate.key))
      next.key = 'This variable already has a rule';
    for (const field of ['minNumber', 'maxNumber', 'minLength', 'maxLength'] as const) {
      const value = candidate[field];
      if (value !== null && !Number.isFinite(value)) next[field] = 'Enter a number';
    }
    setErrors(next);
    if (Object.keys(next).length === 0) onSave(candidate);
  }

  const error = (field: string) => (errors[field] ? { error: errors[field] } : {});

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={onOpenChange}
      title={
        initial.key
          ? `Rule for ${initial.key === NAMING_RULE_KEY ? 'variable names' : initial.key}`
          : 'Add rule'
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <FormField
          label="Variable"
          description="A variable name, or * for a naming rule that applies to every name."
          required
          {...error('key')}
        >
          {(control) => (
            <Input
              {...control}
              className="font-mono"
              value={rule.key}
              onChange={(e) => {
                set({ key: e.target.value.trim() });
              }}
            />
          )}
        </FormField>
        {naming ? null : (
          <>
            <SwitchField
              checked={rule.required}
              onCheckedChange={(required) => {
                set({ required });
              }}
              label="Required"
              description="Readiness is blocked while this variable is missing."
            />
            <SwitchField
              checked={!rule.allowEmpty}
              onCheckedChange={(v) => {
                set({ allowEmpty: !v });
              }}
              label="Must not be empty"
              description="An empty value counts as a problem, separate from a missing variable."
            />
            <FormField label="Format" {...error('format')}>
              {(control) => (
                <NativeSelect
                  {...control}
                  value={rule.format}
                  onChange={(e) => {
                    set({ format: e.target.value as ValueFormat });
                  }}
                >
                  {VALUE_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {FORMAT_LABELS[f]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Minimum number" {...error('minNumber')}>
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    value={rule.minNumber ?? ''}
                    onChange={(e) => {
                      set({ minNumber: numberOrNull(e.target.value) });
                    }}
                  />
                )}
              </FormField>
              <FormField label="Maximum number" {...error('maxNumber')}>
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    value={rule.maxNumber ?? ''}
                    onChange={(e) => {
                      set({ maxNumber: numberOrNull(e.target.value) });
                    }}
                  />
                )}
              </FormField>
              <FormField label="Minimum length" {...error('minLength')}>
                {(control) => (
                  <Input
                    {...control}
                    inputMode="numeric"
                    value={rule.minLength ?? ''}
                    onChange={(e) => {
                      set({ minLength: intOrNull(e.target.value) });
                    }}
                  />
                )}
              </FormField>
              <FormField label="Maximum length" {...error('maxLength')}>
                {(control) => (
                  <Input
                    {...control}
                    inputMode="numeric"
                    value={rule.maxLength ?? ''}
                    onChange={(e) => {
                      set({ maxLength: intOrNull(e.target.value) });
                    }}
                  />
                )}
              </FormField>
            </div>
            <FormField
              label="Allowed values"
              description="One per line. Leave empty to allow any value."
              {...error('allowedValues')}
            >
              {(control) => (
                <Textarea
                  {...control}
                  rows={3}
                  className="font-mono"
                  value={allowed}
                  onChange={(e) => {
                    setAllowed(e.target.value);
                  }}
                />
              )}
            </FormField>
          </>
        )}
        <FormField
          label="Pattern"
          description={
            naming
              ? 'Every variable name must match this pattern.'
              : 'The whole value must match. Backreferences, lookarounds and nested repetition are not allowed.'
          }
          required={naming}
          {...error('pattern')}
        >
          {(control) => (
            <Input
              {...control}
              className="font-mono"
              maxLength={200}
              value={rule.pattern ?? ''}
              onChange={(e) => {
                set({ pattern: e.target.value === '' ? null : e.target.value });
              }}
            />
          )}
        </FormField>
        <FormField label="Description" {...error('description')}>
          {(control) => (
            <Input
              {...control}
              maxLength={500}
              value={rule.description ?? ''}
              onChange={(e) => {
                set({ description: e.target.value });
              }}
            />
          )}
        </FormField>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit">Apply</Button>
        </div>
      </form>
    </ResponsiveModal>
  );
}

/**
 * ValidationRulesEditor. Rules are edited locally and saved as one set.
 * Value rules are checked on the server; this page never sees values.
 */
export function ValidationRulesEditor({
  ids,
  initial,
  canEdit,
}: {
  ids: { workspaceId: string; projectId: string; environmentId: string };
  initial: readonly ValidationRule[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<Rule[]>(() => initial.map(fromRule));
  const [editing, setEditing] = useState<{ index: number | null; rule: Rule } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    try {
      const result = await replaceValidationRulesAction(
        ids.workspaceId,
        ids.projectId,
        ids.environmentId,
        { rules },
      );
      if (result.ok) {
        setRules(result.data.map(fromRule));
        setDirty(false);
        setError(null);
        notify.success(result.message ?? 'Saved.');
        router.refresh();
      } else {
        setError(result.message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsSection
      id="validation"
      title="Validation rules"
      description="Requirements the readiness check applies to this environment's variables: required names, formats, ranges, lengths, patterns and allowed values."
      footer={
        canEdit ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || rules.length >= INTELLIGENCE_LIMITS.validationRules}
              onClick={() => {
                setEditing({ index: null, rule: EMPTY });
              }}
            >
              <Plus aria-hidden="true" />
              Add rule
            </Button>
            <Button size="sm" disabled={pending || !dirty} onClick={() => void save()}>
              {pending ? 'Saving…' : 'Save rules'}
            </Button>
          </>
        ) : undefined
      }
    >
      {rules.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No rules"
          description="Without rules, readiness only checks required variables, types and the expected names of the template."
        />
      ) : (
        <ul className="divide-y rounded-md border" aria-label="Validation rules">
          {rules.map((rule, index) => (
            <li
              key={rule.key}
              className="flex items-center gap-2 px-3 py-2"
              data-testid="validation-rule"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <code className="font-mono text-xs font-medium">
                  {rule.key === NAMING_RULE_KEY ? '* (naming rule)' : rule.key}
                </code>
                <span className="truncate text-xs text-muted-foreground">{summary(rule)}</span>
              </div>
              {canEdit ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit rule for ${rule.key}`}
                    onClick={() => {
                      setEditing({ index, rule });
                    }}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove rule for ${rule.key}`}
                    onClick={() => {
                      setRules(rules.filter((_, i) => i !== index));
                      setDirty(true);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {dirty ? (
        <p role="status" className="mt-2 text-xs text-warning">
          Unsaved changes.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {editing ? (
        <RuleDialog
          key={editing.index ?? 'new'}
          open
          initial={editing.rule}
          existingKeys={rules.map((r) => r.key)}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSave={(rule) => {
            setRules(
              editing.index === null
                ? [...rules, rule]
                : rules.map((r, i) => (i === editing.index ? rule : r)),
            );
            setDirty(true);
            setEditing(null);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
