'use client';

import type { EnvironmentSummary, ExportFormat } from '@envvault/shared';
import { Download, ShieldAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/textarea';
import { downloadText } from '@/lib/download';
import { exportAction } from './actions';
import { StepUpDialog } from './step-up-dialog';

const FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: 'dotenv', label: '.env', hint: 'KEY=value lines, quoted where needed' },
  { value: 'json', label: 'JSON', hint: 'One object of name to value' },
  { value: 'yaml', label: 'YAML', hint: 'A mapping of quoted strings' },
];

export interface ExportDialogProps {
  workspaceId: string;
  projectId: string;
  currentEnvironmentId: string;
  /** Environments the caller may see; the server decides which may be exported. */
  environments: readonly Pick<EnvironmentSummary, 'id' | 'name' | 'isProtected'>[];
  /** Selected variables of the current environment; empty exports everything. */
  selectedIds: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Downloads decrypted values. The server checks `secret:export` (not just
 * read access), a step up for protected environments and a rate limit, and
 * audits the export. The content goes straight into a browser download and
 * is not kept in state.
 */
export function ExportDialog({
  workspaceId,
  projectId,
  currentEnvironmentId,
  environments,
  selectedIds,
  open,
  onOpenChange,
}: ExportDialogProps) {
  const ackId = useId();
  const [environmentId, setEnvironmentId] = useState(currentEnvironmentId);
  const [format, setFormat] = useState<ExportFormat>('dotenv');
  const [onlySelected, setOnlySelected] = useState(selectedIds.length > 0);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const target = environments.find((e) => e.id === environmentId);
  const useSelection =
    onlySelected && environmentId === currentEnvironmentId && selectedIds.length > 0;

  function close(next: boolean) {
    if (pending) return;
    if (!next) {
      setAcknowledged(false);
      setError(null);
    }
    onOpenChange(next);
  }

  async function run() {
    setPending(true);
    setError(null);
    try {
      const outcome = await exportAction(workspaceId, projectId, environmentId, {
        format,
        ...(useSelection ? { secretIds: [...selectedIds] } : {}),
      });
      if (!outcome.ok) {
        if (outcome.code === 'STEP_UP_REQUIRED') setStepUp(true);
        else setError(outcome.message);
        return;
      }
      const { filename, mediaType, content, count, skipped } = outcome.data;
      downloadText(filename, mediaType, content);
      notify.success(
        `Downloaded ${String(count)} ${count === 1 ? 'variable' : 'variables'} as ${filename}`,
        {
          description:
            skipped.length > 0
              ? `Left out: ${skipped
                  .map((s) => s.key)
                  .slice(0, 5)
                  .join(', ')}${skipped.length > 5 ? ' …' : ''}`
              : 'The file holds plaintext secrets. Delete it when you are done.',
        },
      );
      setAcknowledged(false);
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <ResponsiveModal
        open={open}
        onOpenChange={close}
        title="Export variables"
        description="Downloads decrypted values as a file on this device."
        footer={
          <>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                close(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!acknowledged || pending}
              aria-busy={pending}
              onClick={() => void run()}
            >
              <Download aria-hidden="true" />
              {pending ? 'Preparing…' : 'Download'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger"
            >
              {error}
            </p>
          ) : null}
          <FormField label="Environment">
            {(control) => (
              <NativeSelect
                {...control}
                value={environmentId}
                onChange={(e) => {
                  setEnvironmentId(e.target.value);
                }}
              >
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                    {env.isProtected ? ' (protected)' : ''}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Format</legend>
            {FORMATS.map((f) => (
              <label key={f.value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="export-format"
                  value={f.value}
                  checked={format === f.value}
                  onChange={() => {
                    setFormat(f.value);
                  }}
                  className="mt-1"
                />
                <span>
                  {f.label} <span className="text-xs text-muted-foreground">· {f.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {selectedIds.length > 0 && environmentId === currentEnvironmentId ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Variables</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="export-scope"
                  checked={onlySelected}
                  onChange={() => {
                    setOnlySelected(true);
                  }}
                />
                The {selectedIds.length} selected
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="export-scope"
                  checked={!onlySelected}
                  onChange={() => {
                    setOnlySelected(false);
                  }}
                />
                Every variable with a value
              </label>
            </fieldset>
          ) : (
            <p className="text-xs text-muted-foreground">
              Every variable with a value is exported.
            </p>
          )}
          {target?.isProtected ? (
            <p className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning">
              <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {target.name} is protected. Exporting needs a direct Secret exporter grant there and a
              recent password confirmation.
            </p>
          ) : null}
          <label htmlFor={ackId} className="flex items-start gap-2 text-sm">
            <input
              id={ackId}
              type="checkbox"
              className="mt-1"
              checked={acknowledged}
              onChange={(e) => {
                setAcknowledged(e.target.checked);
              }}
            />
            <span>
              I understand the file contains plaintext secrets. I will not commit, share or keep it
              longer than needed.
            </span>
          </label>
        </div>
      </ResponsiveModal>
      <StepUpDialog open={stepUp} onOpenChange={setStepUp} onConfirmed={() => void run()} />
    </>
  );
}
