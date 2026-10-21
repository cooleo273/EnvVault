'use client';

import {
  type ImportEntry,
  type ImportEntryStatus,
  type ImportPreview,
  type ImportResult,
  SECRET_TRANSFER_DEFAULTS,
  SECRET_TYPE_LABELS,
  SECRET_TYPES,
  type SecretType,
  SUGGESTED_SECRET_CATEGORIES,
} from '@envvault/shared';
import { CheckCircle2, EyeIcon, EyeOffIcon, FileUp, LoaderIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { StatusBadge, type StatusBadgeProps } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { importAction, previewImportAction } from './actions';

type Step = 'source' | 'review' | 'done';
type Choice =
  | { action: 'create'; key: string }
  | { action: 'overwrite'; key: string; expectedRevision: number };
type Decision = 'create' | 'overwrite' | 'skip';

const STATUS: Record<ImportEntryStatus, { label: string; tone: StatusBadgeProps['tone'] }> = {
  new: { label: 'New', tone: 'success' },
  changed: { label: 'Changed', tone: 'warning' },
  exists: { label: 'Exists', tone: 'warning' },
  unchanged: { label: 'Unchanged', tone: 'neutral' },
  invalid: { label: 'Invalid', tone: 'danger' },
  duplicate: { label: 'Duplicate', tone: 'neutral' },
};

const bytes = new Intl.NumberFormat('en', { style: 'unit', unit: 'byte', unitDisplay: 'narrow' });

function defaultDecision(entry: ImportEntry): Decision {
  if (entry.status === 'new') return 'create';
  return 'skip';
}

function canChoose(entry: ImportEntry): boolean {
  return entry.status === 'new' || entry.status === 'changed' || entry.status === 'exists';
}

export interface ImportWizardProps {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  environmentName: string;
  isProtected: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * .env import: paste or pick a file, review what would change, choose per
 * variable, import. The file is read in the browser and sent to the server
 * for parsing; its content lives only in this component's state and is
 * cleared on close and after the import. Existing values are never shown.
 */
export function ImportWizard({
  workspaceId,
  projectId,
  environmentId,
  environmentName,
  isProtected,
  open,
  onOpenChange,
}: ImportWizardProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const textareaId = useId();
  const [step, setStep] = useState<Step>('source');
  const [content, setContent] = useState('');
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [showContent, setShowContent] = useState(false);
  const [defaultType, setDefaultType] = useState<SecretType>('SECRET');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<'preview' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setStep('source');
    setContent('');
    setSourceName(null);
    setShowContent(false);
    setPreview(null);
    setDecisions(new Map());
    setCategory('');
    setTags('');
    setReason('');
    setError(null);
    setIssues({});
    setResult(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  function close(next: boolean) {
    if (pending === 'import') return;
    if (!next) reset();
    onOpenChange(next);
  }

  async function readFile(file: File) {
    setError(null);
    if (file.size > SECRET_TRANSFER_DEFAULTS.importBytes) {
      setError(
        `The file is larger than ${String(SECRET_TRANSFER_DEFAULTS.importBytes / 1024)} KiB.`,
      );
      return;
    }
    setContent(await file.text());
    setSourceName(file.name);
  }

  async function runPreview() {
    setPending('preview');
    setError(null);
    try {
      const outcome = await previewImportAction(workspaceId, projectId, environmentId, {
        content,
        defaultType,
      });
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      const lastEntries = outcome.data.entries;
      setPreview(outcome.data);
      setDecisions(
        new Map(lastEntries.map((e) => [`${e.key}@${String(e.line)}`, defaultDecision(e)])),
      );
      setStep('review');
    } finally {
      setPending(null);
    }
  }

  const entries = preview?.entries ?? [];
  const choices: Choice[] = entries.flatMap((entry): Choice[] => {
    const decision = decisions.get(`${entry.key}@${String(entry.line)}`) ?? 'skip';
    if (decision === 'skip' || !canChoose(entry)) return [];
    return decision === 'create'
      ? [{ action: 'create', key: entry.key }]
      : [{ action: 'overwrite', key: entry.key, expectedRevision: entry.existing?.revision ?? 1 }];
  });

  async function runImport() {
    setPending('import');
    setError(null);
    setIssues({});
    try {
      const outcome = await importAction(workspaceId, projectId, environmentId, {
        content,
        defaultType,
        items: choices,
        ...(category.trim() ? { category } : {}),
        tags: tags.split(/[\s,]+/).filter(Boolean),
        ...(reason.trim() ? { changeReason: reason } : {}),
      });
      if (!outcome.ok) {
        setError(outcome.message);
        setIssues(outcome.fieldErrors ?? {});
        return;
      }
      setResult(outcome.data);
      setContent('');
      setStep('done');
      notify.success(
        `Imported ${String(outcome.data.created + outcome.data.updated)} variables into ${environmentName}.`,
      );
    } finally {
      setPending(null);
    }
  }

  function setAll(status: ImportEntryStatus[], decision: Decision) {
    setDecisions((current) => {
      const next = new Map(current);
      for (const entry of entries) {
        if (!status.includes(entry.status) || !canChoose(entry)) continue;
        next.set(
          `${entry.key}@${String(entry.line)}`,
          entry.status === 'new' && decision === 'overwrite' ? 'create' : decision,
        );
      }
      return next;
    });
  }

  const footer =
    step === 'source' ? (
      <>
        <Button
          variant="outline"
          onClick={() => {
            close(false);
          }}
        >
          Cancel
        </Button>
        <Button
          disabled={content.trim() === '' || pending !== null}
          aria-busy={pending === 'preview'}
          onClick={() => void runPreview()}
        >
          {pending === 'preview' ? 'Reading…' : 'Review changes'}
        </Button>
      </>
    ) : step === 'review' ? (
      <>
        <Button
          variant="outline"
          disabled={pending !== null}
          onClick={() => {
            setStep('source');
          }}
        >
          Back
        </Button>
        <Button
          variant="outline"
          disabled={pending !== null}
          onClick={() => {
            close(false);
          }}
        >
          Cancel
        </Button>
        <Button
          disabled={choices.length === 0 || pending !== null}
          aria-busy={pending === 'import'}
          onClick={() => void runImport()}
        >
          {pending === 'import'
            ? `Encrypting and importing ${String(choices.length)}…`
            : `Import ${String(choices.length)} ${choices.length === 1 ? 'variable' : 'variables'}`}
        </Button>
      </>
    ) : (
      <Button
        onClick={() => {
          close(false);
        }}
      >
        Done
      </Button>
    );

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={close}
      title={`Import into ${environmentName}`}
      description={
        step === 'source'
          ? 'Paste .env content or choose a file. Nothing is saved until you confirm the import.'
          : step === 'review'
            ? 'Choose what to import. Existing values are never shown; values are encrypted on the server.'
            : undefined
      }
      className="sm:max-w-3xl"
      footer={footer}
    >
      {error ? (
        <p
          role="alert"
          className="mb-3 rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      ) : null}

      {step === 'source' ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".env,.txt,text/plain"
              className="sr-only"
              aria-label="Choose a .env file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              <FileUp aria-hidden="true" />
              Choose file
            </Button>
            {sourceName ? (
              <span className="text-xs text-muted-foreground">
                {sourceName} · {bytes.format(new TextEncoder().encode(content).length)}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              aria-pressed={showContent}
              onClick={() => {
                setShowContent((v) => !v);
              }}
            >
              {showContent ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
              {showContent ? 'Hide content' : 'Show content'}
            </Button>
          </div>
          <FormField
            label=".env content"
            id={textareaId}
            description="KEY=value per line. # comments, export, single, double and backtick quotes and quoted multiline values are supported. $VARIABLES and $(commands) are kept as text, never expanded or run."
          >
            {(control) => (
              <Textarea
                {...control}
                rows={10}
                value={content}
                spellCheck={false}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                placeholder={'DATABASE_URL="postgres://…"\nLOG_LEVEL=info'}
                className={cn('font-mono text-xs', !showContent && 'secret-input-hidden')}
                onChange={(e) => {
                  setContent(e.target.value);
                  setSourceName(null);
                }}
              />
            )}
          </FormField>
          <FormField
            label="Type for new variables"
            description="Values with line breaks become Multiline. Existing variables keep their type."
          >
            {(control) => (
              <NativeSelect
                {...control}
                value={defaultType}
                className="sm:w-56"
                onChange={(e) => {
                  setDefaultType(e.target.value as SecretType);
                }}
              >
                {SECRET_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {SECRET_TYPE_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          {isProtected ? (
            <p className="text-xs text-warning">
              This environment is protected. Importing needs a direct Secret writer grant here.
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 'review' && preview ? (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-wrap gap-1.5" aria-label="Summary">
            {(Object.keys(STATUS) as ImportEntryStatus[])
              .filter((s) => preview.summary[s] > 0)
              .map((s) => (
                <li key={s}>
                  <StatusBadge
                    tone={STATUS[s].tone}
                    label={`${STATUS[s].label}: ${String(preview.summary[s])}`}
                    dot={false}
                  />
                </li>
              ))}
          </ul>
          {!preview.compared ? (
            <p className="text-xs text-muted-foreground">
              Existing values were not compared, because you cannot read values here
              {isProtected ? ' without confirming your password' : ''}. They show as Exists.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setAll(['new'], 'create');
              }}
            >
              Select all new
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setAll(['changed', 'exists'], 'overwrite');
              }}
            >
              Overwrite all existing
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAll(['new', 'changed', 'exists'], 'skip');
              }}
            >
              Skip all
            </Button>
          </div>
          <div
            className="max-h-[45dvh] overflow-auto rounded-md border"
            tabIndex={0}
            role="region"
            aria-label="Import entries"
          >
            <table className="w-full text-sm">
              <caption className="sr-only">Entries found in the content</caption>
              <thead className="sticky top-0 bg-surface-muted text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Line
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Key
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Status
                  </th>
                  <th scope="col" className="hidden px-3 py-2 text-left font-medium sm:table-cell">
                    Type
                  </th>
                  <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                    Size
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const id = `${entry.key}@${String(entry.line)}`;
                  const decision = decisions.get(id) ?? 'skip';
                  const issue = issues[entry.key];
                  return (
                    <tr key={id} className="border-t align-top" data-testid="import-entry">
                      <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                        {entry.line}
                      </td>
                      <th scope="row" className="px-3 py-2 text-left font-normal">
                        <span className="font-mono text-xs break-all">{entry.key}</span>
                        {(entry.problem ?? issue) ? (
                          <span className="block text-xs text-danger">
                            {issue ?? entry.problem}
                          </span>
                        ) : null}
                      </th>
                      <td className="px-3 py-2">
                        <StatusBadge
                          tone={STATUS[entry.status].tone}
                          label={STATUS[entry.status].label}
                          dot={false}
                        />
                      </td>
                      <td className="hidden px-3 py-2 text-xs sm:table-cell">
                        {SECRET_TYPE_LABELS[entry.type]}
                      </td>
                      <td className="hidden px-3 py-2 text-right text-xs text-muted-foreground tabular-nums sm:table-cell">
                        {bytes.format(entry.valueBytes)}
                      </td>
                      <td className="px-3 py-2">
                        {canChoose(entry) ? (
                          <NativeSelect
                            aria-label={`Action for ${entry.key}`}
                            value={decision}
                            className="h-control-sm w-32"
                            onChange={(e) => {
                              const next = e.target.value as Decision;
                              setDecisions((current) => new Map(current).set(id, next));
                            }}
                          >
                            {entry.existing ? (
                              <option value="overwrite">Overwrite</option>
                            ) : (
                              <option value="create">Create</option>
                            )}
                            <option value="skip">Skip</option>
                          </NativeSelect>
                        ) : (
                          <span className="text-xs text-muted-foreground">Skipped</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {preview.ignoredLines.length > 0 ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                {preview.ignoredLines.length}{' '}
                {preview.ignoredLines.length === 1 ? 'line was' : 'lines were'} not understood and
                will be ignored
              </summary>
              <ul className="mt-1 list-inside list-disc">
                {preview.ignoredLines.map((l) => (
                  <li key={l.line}>
                    Line {l.line}: {l.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Category for new variables">
              {(control) => (
                <>
                  <Input
                    {...control}
                    list={`${textareaId}-categories`}
                    value={category}
                    onChange={(e) => {
                      setCategory(e.target.value);
                    }}
                  />
                  <datalist id={`${textareaId}-categories`}>
                    {SUGGESTED_SECRET_CATEGORIES.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </>
              )}
            </FormField>
            <FormField label="Tags for new variables">
              {(control) => (
                <Input
                  {...control}
                  value={tags}
                  placeholder="imported"
                  onChange={(e) => {
                    setTags(e.target.value);
                  }}
                />
              )}
            </FormField>
            <FormField label="Change note">
              {(control) => (
                <Input
                  {...control}
                  value={reason}
                  maxLength={500}
                  placeholder="Imported from .env"
                  onChange={(e) => {
                    setReason(e.target.value);
                  }}
                />
              )}
            </FormField>
          </div>
          {pending === 'import' ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderIcon
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              Encrypting and saving. All selected variables change together, or none do.
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 'done' && result ? (
        <div role="status" className="flex flex-col items-center gap-2 py-6 text-center">
          <CheckCircle2 aria-hidden="true" className="size-8 text-success" />
          <p className="text-sm font-medium">Import complete</p>
          <p className="text-sm text-muted-foreground">
            {result.created} created, {result.updated} updated. Every value was encrypted before it
            was stored.
          </p>
        </div>
      ) : null}
    </ResponsiveModal>
  );
}
