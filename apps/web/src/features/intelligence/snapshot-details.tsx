'use client';

import {
  SECRET_TYPE_LABELS,
  type SnapshotDetail,
  type SnapshotDiff,
  type SnapshotSummary,
} from '@envvault/shared';
import { History, LoaderIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/textarea';
import { StepUpDialog } from '@/features/secrets/step-up-dialog';
import { snapshotDiffAction } from './actions';
import { DriftReport } from './drift-report';
import { SnapshotRestoreDialog } from './snapshot-restore-dialog';

const timeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/** One snapshot: its entries, drift against now or another snapshot, and restore. */
export function SnapshotDetails({
  ids,
  snapshot,
  others,
  initialDiff,
  canCompareValues,
  canRestore,
}: {
  ids: { workspaceId: string; projectId: string; environmentId: string };
  snapshot: SnapshotDetail;
  others: readonly SnapshotSummary[];
  initialDiff: SnapshotDiff | null;
  canCompareValues: boolean;
  canRestore: boolean;
}) {
  const router = useRouter();
  const [diff, setDiff] = useState<SnapshotDiff | null>(initialDiff);
  const [against, setAgainst] = useState('');
  const [values, setValues] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [restoring, setRestoring] = useState(false);

  async function load(next: { against?: string; values?: boolean } = {}) {
    const target = next.against ?? against;
    const compareValues = next.values ?? values;
    setLoading(true);
    try {
      const result = await snapshotDiffAction(
        ids.workspaceId,
        ids.projectId,
        ids.environmentId,
        snapshot.id,
        {
          ...(target ? { againstSnapshotId: target } : {}),
          compareValues,
        },
      );
      if (result.ok) {
        setDiff(result.data);
        setValues(compareValues);
      } else if (result.code === 'STEP_UP_REQUIRED') {
        setStepUp(true);
      } else {
        notify.error(result.message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border bg-surface p-4 sm:flex-row sm:items-start">
        <div className="flex flex-1 flex-col gap-1">
          <p className="text-sm font-medium">{snapshot.description ?? 'No description'}</p>
          <p className="text-xs text-muted-foreground">
            {snapshot.entryCount} variables · taken{' '}
            {timeFormat.format(new Date(snapshot.createdAt))}
            {snapshot.createdBy
              ? ` by ${snapshot.createdBy.displayName ?? snapshot.createdBy.email}`
              : ''}
          </p>
          <p className="font-mono text-2xs text-muted-foreground">{snapshot.id}</p>
        </div>
        {canRestore ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRestoring(true);
            }}
          >
            <History aria-hidden="true" />
            Restore…
          </Button>
        ) : null}
      </div>

      <section aria-labelledby="drift-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <h3 id="drift-heading" className="flex-1 text-sm font-semibold">
            Drift
          </h3>
          {loading ? (
            <LoaderIcon
              aria-label="Loading"
              className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
            />
          ) : null}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Compare with
            <NativeSelect
              aria-label="Compare with"
              className="h-control-sm w-56"
              value={against}
              disabled={loading}
              onChange={(e) => {
                setAgainst(e.target.value);
                void load({ against: e.target.value, values: false });
              }}
            >
              <option value="">Current state</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.description ?? 'Snapshot'} ({timeFormat.format(new Date(o.createdAt))})
                </option>
              ))}
            </NativeSelect>
          </label>
          {canCompareValues ? (
            <Button
              variant={values ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={values}
              disabled={loading}
              onClick={() => void load({ values: !values })}
            >
              {values ? 'Hide value comparison' : 'Compare values'}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showUnchanged}
            onClick={() => {
              setShowUnchanged(!showUnchanged);
            }}
          >
            {showUnchanged ? 'Hide unchanged' : 'Show unchanged'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          A new version does not mean a new value. Compare values checks on the server whether the
          referenced versions hold the same value, without showing either.
        </p>
        {diff ? (
          <DriftReport diff={diff} showUnchanged={showUnchanged} />
        ) : (
          <div className="rounded-lg border bg-surface">
            <ErrorState
              title="Drift unavailable"
              description="The comparison could not be loaded."
              onRetry={() => void load()}
            />
          </div>
        )}
      </section>

      <section aria-labelledby="entries-heading" className="rounded-lg border bg-surface">
        <h3 id="entries-heading" className="border-b px-4 py-2.5 text-sm font-semibold">
          Recorded variables
        </h3>
        <ul className="divide-y text-sm">
          {snapshot.entries.map((e) => (
            <li
              key={e.secretId}
              className="flex flex-wrap items-center gap-2 px-4 py-1.5"
              data-testid="snapshot-entry"
            >
              <code className="font-mono text-xs font-medium">{e.key}</code>
              <StatusBadge tone="neutral" label={SECRET_TYPE_LABELS[e.type]} dot={false} />
              {e.isRequired ? <span className="text-xs">Required</span> : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {e.version === null ? 'No value' : `Version ${String(e.version)}`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <StepUpDialog
        open={stepUp}
        onOpenChange={setStepUp}
        onConfirmed={() => void load({ values: true })}
        description="This environment is protected. Confirm your password so the server can compare values. Values are never shown."
      />
      {canRestore && restoring ? (
        <SnapshotRestoreDialog
          open
          onOpenChange={setRestoring}
          ids={ids}
          snapshotId={snapshot.id}
          onRestored={() => {
            router.refresh();
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
