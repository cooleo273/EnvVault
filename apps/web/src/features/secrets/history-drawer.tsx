'use client';

import type { SecretSummary, SecretVersionDetail, VersionComparison } from '@envvault/shared';
import { EyeIcon, EyeOffIcon, GitCompare, History, LoaderIcon, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { EmptyState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { lineDiff, type DiffLine } from '@/lib/line-diff';
import { cn } from '@/lib/utils';
import {
  compareVersionsAction,
  listVersionsAction,
  revealVersionAction,
  rollbackAction,
  type SecretActionResult,
} from './actions';
import { REVEAL_DURATION_MS } from './secret-value-cell';
import { StepUpDialog } from './step-up-dialog';

const dateTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

const ORIGIN_LABELS: Record<SecretVersionDetail['origin'], string> = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  IMPORT: 'Imported',
  ROLLBACK: 'Rolled back',
};

export interface HistoryDrawerProps {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  secret: SecretSummary;
  canReveal: boolean;
  canRollback: boolean;
  archived: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Version history of one variable. The list holds metadata only. Revealed
 * historical values and diffs live in state for {@link REVEAL_DURATION_MS}
 * and are cleared when the drawer closes. Restoring encrypts the chosen
 * value again on the server as a new version; the value is not shown for that.
 */
export function HistoryDrawer({
  workspaceId,
  projectId,
  environmentId,
  secret,
  canReveal,
  canRollback,
  archived,
  open,
  onOpenChange,
}: HistoryDrawerProps) {
  const [versions, setVersions] = useState<SecretVersionDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revealed, setRevealed] = useState<Map<string, string>>(new Map());
  const [compare, setCompare] = useState<string[]>([]);
  const [comparison, setComparison] = useState<VersionComparison | null>(null);
  const [diff, setDiff] = useState<DiffLine[] | 'too-large' | null>(null);
  const [restoring, setRestoring] = useState<SecretVersionDetail | null>(null);
  const [reason, setReason] = useState('');
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (before?: number) => {
      try {
        const page = await listVersionsAction(
          workspaceId,
          projectId,
          environmentId,
          secret.id,
          before,
        );
        if (!page.ok) {
          setFailed(true);
          return;
        }
        setVersions((current) =>
          before === undefined ? page.data.items : [...current, ...page.data.items],
        );
        setTotal(page.data.total);
        setNextBefore(page.data.nextBefore);
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, projectId, environmentId, secret.id],
  );

  useEffect(() => {
    if (open) void load();
  }, [open, load, secret.revision]);

  // Plaintext leaves state after the visibility period.
  useEffect(() => {
    if (revealed.size === 0 && diff === null) return;
    const timer = setTimeout(() => {
      setRevealed(new Map());
      setDiff(null);
    }, REVEAL_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [revealed, diff]);

  function close(next: boolean) {
    if (!next) {
      setRevealed(new Map());
      setDiff(null);
      setComparison(null);
      setCompare([]);
      setReason('');
    }
    onOpenChange(next);
  }

  /** Runs an action that may need a step up first. */
  async function guarded<T>(run: () => Promise<SecretActionResult<T>>): Promise<T | null> {
    const outcome = await run();
    if (outcome.ok) return outcome.data;
    if (outcome.code === 'STEP_UP_REQUIRED') {
      setRetry(() => () => void guarded(run));
      return null;
    }
    notify.error(outcome.message);
    return null;
  }

  async function reveal(version: SecretVersionDetail) {
    if (revealed.has(version.id)) {
      setRevealed((current) => {
        const next = new Map(current);
        next.delete(version.id);
        return next;
      });
      return;
    }
    setBusy(version.id);
    try {
      const data = await guarded(() =>
        revealVersionAction(workspaceId, projectId, environmentId, secret.id, version.id),
      );
      if (data) setRevealed((current) => new Map(current).set(version.id, data.value));
    } finally {
      setBusy(null);
    }
  }

  async function runCompare() {
    const [fromVersionId, toVersionId] = [...compare].sort(
      (a, b) =>
        (versions.find((v) => v.id === a)?.version ?? 0) -
        (versions.find((v) => v.id === b)?.version ?? 0),
    );
    if (!fromVersionId || !toVersionId) return;
    setBusy('compare');
    setDiff(null);
    try {
      const data = await guarded(() =>
        compareVersionsAction(workspaceId, projectId, environmentId, secret.id, {
          fromVersionId,
          toVersionId,
        }),
      );
      if (data) setComparison(data);
    } finally {
      setBusy(null);
    }
  }

  async function showDiff() {
    if (!comparison) return;
    setBusy('diff');
    try {
      const [from, to] = await Promise.all([
        guarded(() =>
          revealVersionAction(workspaceId, projectId, environmentId, secret.id, comparison.from.id),
        ),
        guarded(() =>
          revealVersionAction(workspaceId, projectId, environmentId, secret.id, comparison.to.id),
        ),
      ]);
      if (from && to) setDiff(lineDiff(from.value, to.value) ?? 'too-large');
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    if (!restoring) return;
    const outcome = await rollbackAction(workspaceId, projectId, environmentId, secret.id, {
      versionId: restoring.id,
      expectedRevision: secret.revision,
      ...(reason.trim() ? { changeReason: reason } : {}),
    });
    if (!outcome.ok) {
      notify.error(outcome.message);
      throw new Error(outcome.message);
    }
    notify.success(outcome.message ?? 'Restored.');
    setReason('');
    setRestoring(null);
  }

  return (
    <>
      <ResponsiveModal
        open={open}
        onOpenChange={close}
        variant="drawer"
        title={`History of ${secret.key}`}
        description={`${String(total)} ${total === 1 ? 'version' : 'versions'}. Old values stay encrypted; revealing one is recorded.`}
      >
        <div className="flex flex-col gap-3">
          {canReveal && versions.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <GitCompare aria-hidden="true" className="size-4" />
              {compare.length < 2 ? 'Tick two versions to compare them.' : null}
              {compare.length === 2 ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void runCompare()}
                >
                  Compare selected
                </Button>
              ) : null}
            </div>
          ) : null}

          {comparison ? (
            <div
              role="status"
              className="flex flex-col gap-2 rounded-md border bg-surface-muted/50 px-3 py-2 text-sm"
            >
              <p>
                v{comparison.from.version} and v{comparison.to.version}{' '}
                {comparison.sameValue ? (
                  <strong>hold the same value.</strong>
                ) : (
                  <strong>
                    differ ({comparison.fromBytes} B and {comparison.toBytes} B).
                  </strong>
                )}
              </p>
              {!comparison.sameValue ? (
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void showDiff()}
                  >
                    {busy === 'diff' ? 'Revealing…' : 'Show line differences'}
                  </Button>
                  <span className="ml-2 text-xs text-muted-foreground">
                    Reveals both values (recorded).
                  </span>
                </div>
              ) : null}
              {diff === 'too-large' ? (
                <p className="text-xs text-muted-foreground">
                  These values are too large to compare line by line here.
                </p>
              ) : diff ? (
                <pre
                  className="max-h-60 overflow-auto rounded-sm border bg-surface p-2 font-mono text-xs"
                  data-testid="version-diff"
                >
                  {diff.map((line, index) => (
                    <div
                      key={index}
                      className={cn(
                        line.kind === 'added' && 'bg-success-subtle text-success',
                        line.kind === 'removed' && 'bg-danger-subtle text-danger',
                      )}
                    >
                      {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                      {line.text}
                    </div>
                  ))}
                </pre>
              ) : null}
            </div>
          ) : null}

          {failed ? (
            <EmptyState
              icon={History}
              title="History could not be loaded"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setFailed(false);
                    setLoading(true);
                    void load();
                  }}
                >
                  Try again
                </Button>
              }
            />
          ) : null}

          <ol className="flex flex-col divide-y rounded-md border" aria-label="Versions">
            {versions.map((version) => {
              const value = revealed.get(version.id);
              const checked = compare.includes(version.id);
              return (
                <li
                  key={version.id}
                  className="flex flex-col gap-1.5 px-3 py-2.5"
                  data-testid="version-row"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {canReveal && versions.length > 1 ? (
                      <input
                        type="checkbox"
                        aria-label={`Compare version ${String(version.version)}`}
                        checked={checked}
                        disabled={!checked && compare.length >= 2}
                        onChange={(e) => {
                          setComparison(null);
                          setDiff(null);
                          setCompare((current) =>
                            e.target.checked
                              ? [...current, version.id]
                              : current.filter((id) => id !== version.id),
                          );
                        }}
                      />
                    ) : null}
                    <span className="font-mono text-sm font-medium">v{version.version}</span>
                    <StatusBadge tone="neutral" label={ORIGIN_LABELS[version.origin]} dot={false} />
                    {version.isCurrent ? (
                      <StatusBadge tone="success" label="Current" dot={false} />
                    ) : null}
                    {version.restoredFromVersion !== null ? (
                      <span className="text-xs text-muted-foreground">
                        from v{version.restoredFromVersion}
                      </span>
                    ) : null}
                    <span className="ml-auto flex items-center gap-1">
                      {canReveal ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={
                            value === undefined
                              ? `Reveal version ${String(version.version)}`
                              : `Hide version ${String(version.version)}`
                          }
                          aria-pressed={value !== undefined}
                          disabled={busy === version.id}
                          onClick={() => void reveal(version)}
                        >
                          {busy === version.id ? (
                            <LoaderIcon
                              aria-hidden="true"
                              className="animate-spin motion-reduce:animate-none"
                            />
                          ) : value === undefined ? (
                            <EyeIcon aria-hidden="true" />
                          ) : (
                            <EyeOffIcon aria-hidden="true" />
                          )}
                        </Button>
                      ) : null}
                      {canRollback && !version.isCurrent && !archived ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setRestoring(version);
                          }}
                        >
                          <RotateCcw aria-hidden="true" />
                          Restore
                        </Button>
                      ) : null}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {dateTime.format(new Date(version.createdAt))}
                    {version.createdBy
                      ? ` · ${version.createdBy.displayName ?? version.createdBy.email}`
                      : ''}
                    {version.keyVersion !== null ? ` · key v${String(version.keyVersion)}` : ''}
                  </p>
                  {version.changeReason ? <p className="text-xs">{version.changeReason}</p> : null}
                  {value !== undefined ? (
                    <code
                      data-testid="version-value"
                      className="block max-h-40 overflow-auto rounded-sm bg-surface-muted px-1.5 py-1 font-mono text-xs break-all whitespace-pre-wrap"
                    >
                      {value === '' ? (
                        <span className="italic text-muted-foreground">(empty)</span>
                      ) : (
                        value
                      )}
                    </code>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {loading ? (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderIcon
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              Loading versions
            </p>
          ) : null}
          {nextBefore !== null && !loading ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoading(true);
                void load(nextBefore);
              }}
            >
              Load older versions
            </Button>
          ) : null}
        </div>
      </ResponsiveModal>

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(next) => {
          if (!next) {
            setRestoring(null);
            setReason('');
          }
        }}
        title={`Restore v${String(restoring?.version ?? '')}?`}
        description={
          <div className="flex flex-col gap-2">
            <p>
              The value of v{restoring?.version} becomes the current value as a new version. Nothing
              in the history is changed or removed. The value is not shown.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              Change note (optional)
              <Input
                value={reason}
                maxLength={500}
                onChange={(e) => {
                  setReason(e.target.value);
                }}
              />
            </label>
          </div>
        }
        confirmLabel="Restore as new version"
        onConfirm={restore}
      />
      <StepUpDialog
        open={retry !== null}
        onOpenChange={(next) => {
          if (!next) setRetry(null);
        }}
        onConfirmed={() => {
          const run = retry;
          setRetry(null);
          run?.();
        }}
      />
    </>
  );
}
