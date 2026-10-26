'use client';

import type { RestorePreview } from '@envvault/shared';
import { LoaderIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SwitchField } from '@/components/ui/switch';
import { StepUpDialog } from '@/features/secrets/step-up-dialog';
import { previewRestoreAction, restoreSnapshotAction } from './actions';

const ACTION_LABELS = {
  update: 'Updated',
  undelete: 'Restored from trash',
  delete: 'Moved to trash',
  unchanged: 'Unchanged',
} as const;

/**
 * Preview and confirm a snapshot restore. The preview is built on the
 * server; the restore sends back the state it was built from, so a change in
 * between is refused rather than overwritten.
 */
export function SnapshotRestoreDialog({
  open,
  onOpenChange,
  ids,
  snapshotId,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ids: { workspaceId: string; projectId: string; environmentId: string };
  snapshotId: string;
  onRestored: () => void;
}) {
  const [removeAdded, setRemoveAdded] = useState(true);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [stepUp, setStepUp] = useState(false);

  // The dialog is mounted when opened, so the first preview starts in the loading state.
  const [loading, setLoading] = useState(true);

  const fetchPreview = useCallback(
    async (nextRemoveAdded: boolean) => {
      try {
        const result = await previewRestoreAction(
          ids.workspaceId,
          ids.projectId,
          ids.environmentId,
          snapshotId,
          { removeAdded: nextRemoveAdded },
        );
        if (result.ok) {
          setPreview(result.data);
          setError(null);
        } else {
          setPreview(null);
          setError(result.message);
        }
      } finally {
        setLoading(false);
      }
    },
    [ids.workspaceId, ids.projectId, ids.environmentId, snapshotId],
  );

  useEffect(() => {
    void fetchPreview(true);
  }, [fetchPreview]);

  function load(nextRemoveAdded: boolean) {
    setLoading(true);
    return fetchPreview(nextRemoveAdded);
  }

  async function restore() {
    if (!preview) return;
    setLoading(true);
    try {
      const result = await restoreSnapshotAction(
        ids.workspaceId,
        ids.projectId,
        ids.environmentId,
        snapshotId,
        {
          expectedState: preview.expectedState,
          removeAdded,
          ...(reason.trim() ? { changeReason: reason.trim() } : {}),
        },
      );
      if (result.ok) {
        const r = result.data;
        notify.success(
          `Snapshot restored: ${String(r.updated)} updated, ${String(r.undeleted)} restored, ${String(r.deleted)} moved to trash.`,
        );
        setReason('');
        onOpenChange(false);
        onRestored();
      } else if (result.code === 'STEP_UP_REQUIRED') {
        setStepUp(true);
      } else if (result.code === 'SNAPSHOT_STALE') {
        notify.error(result.message);
        await load(removeAdded);
      } else {
        setError(result.message);
      }
    } finally {
      setLoading(false);
    }
  }

  const changes = preview?.actions.filter((a) => a.action !== 'unchanged') ?? [];
  const blocked = !preview || preview.conflicts.length > 0 || changes.length === 0;

  return (
    <>
      <ResponsiveModal
        open={open}
        onOpenChange={(next) => {
          if (!loading) onOpenChange(next);
        }}
        title="Restore snapshot"
        description="Restoring creates new versions from the snapshot's versions. History is kept, so the restore itself can be undone."
        footer={
          <>
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={loading || blocked}
              onClick={() => void restore()}
              data-testid="confirm-restore"
            >
              {loading ? 'Working…' : `Restore ${String(changes.length)} changes`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4" aria-busy={loading}>
          <SwitchField
            checked={removeAdded}
            onCheckedChange={(next) => {
              setRemoveAdded(next);
              void load(next);
            }}
            disabled={loading}
            label="Move variables created after the snapshot to trash"
            description="Turn off to keep newer variables and only restore the ones in the snapshot."
          />
          {loading && !preview ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderIcon
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />{' '}
              Building preview…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {preview ? (
            <>
              <p className="text-sm" data-testid="restore-counts">
                {preview.counts.update} updated · {preview.counts.undelete} restored from trash ·{' '}
                {preview.counts.delete} moved to trash · {preview.counts.valueRestores} values
                restored · {preview.counts.unchanged} unchanged
              </p>
              {preview.conflicts.length > 0 ? (
                <div
                  role="alert"
                  className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm"
                >
                  <p className="font-medium text-danger">
                    The restore is blocked until these are resolved:
                  </p>
                  <ul className="mt-1 list-disc pl-5">
                    {preview.conflicts.map((c) => (
                      <li key={`${c.key}:${c.reason}`}>
                        <code className="font-mono text-xs">{c.key}</code>: {c.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.warnings.length > 0 ? (
                <div className="rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm">
                  <p className="font-medium text-warning">Not restored exactly:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {preview.warnings.map((w) => (
                      <li key={`${w.key}:${w.reason}`}>
                        <code className="font-mono text-xs">{w.key}</code>: {w.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {changes.length === 0 && preview.conflicts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  The environment already matches this snapshot.
                </p>
              ) : (
                <ul
                  className="max-h-60 divide-y overflow-y-auto rounded-md border text-sm"
                  aria-label="Planned changes"
                >
                  {changes.map((a) => (
                    <li
                      key={a.secretId}
                      className="flex flex-wrap items-center gap-2 px-3 py-1.5"
                      data-testid="restore-action"
                    >
                      <code className="font-mono text-xs">{a.key}</code>
                      <span className="text-xs text-muted-foreground">
                        {ACTION_LABELS[a.action]}
                        {a.fields.length > 0 ? ` (${a.fields.join(', ')})` : ''}
                        {a.restoresValue ? ' · value from snapshot version' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <FormField
                label="Reason"
                description="Saved with the new versions and the audit log."
              >
                {(control) => (
                  <Input
                    {...control}
                    maxLength={500}
                    value={reason}
                    disabled={loading}
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                  />
                )}
              </FormField>
              {preview.requiresStepUp ? (
                <p className="text-xs text-muted-foreground">
                  This environment is protected; you will be asked for your password.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </ResponsiveModal>
      <StepUpDialog
        open={stepUp}
        onOpenChange={setStepUp}
        onConfirmed={() => void restore()}
        description="This environment is protected. Confirm your password to restore the snapshot."
      />
    </>
  );
}
