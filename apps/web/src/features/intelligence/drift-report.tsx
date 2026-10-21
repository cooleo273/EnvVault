'use client';

import type { DiffRow, SnapshotDiff } from '@envvault/shared';
import { GitCompare } from 'lucide-react';
import { EmptyState } from '@/components/feedback/states';
import { StatusBadge, type StatusBadgeProps } from '@/components/feedback/status-badge';

const CHANGE: Record<DiffRow['change'], { tone: StatusBadgeProps['tone']; label: string }> = {
  added: { tone: 'success', label: 'Added since' },
  removed: { tone: 'danger', label: 'Removed since' },
  modified: { tone: 'warning', label: 'Changed' },
  unchanged: { tone: 'neutral', label: 'Unchanged' },
};

const FIELD_LABELS: Record<string, string> = {
  key: 'name',
  type: 'type',
  isRequired: 'required',
  category: 'category',
  tags: 'tags',
  description: 'description',
  inheritable: 'inheritable',
  hasValue: 'value set',
};

function valueNote(row: DiffRow, valuesCompared: boolean): string | null {
  if (row.change === 'added' || row.change === 'removed') return null;
  if (valuesCompared) {
    if (row.value === 'equal') return row.versionChanged ? 'New version, same value' : 'Same value';
    if (row.value === 'different') return 'Value differs';
    if (row.value === 'not_comparable') return 'No value on one side';
  }
  // A new version can hold the same value, so this never claims the value changed.
  return row.versionChanged ? 'Different version (value not compared)' : null;
}

/** What changed between a snapshot and the current state (or a later snapshot). */
export function DriftReport({
  diff,
  showUnchanged = false,
}: {
  diff: SnapshotDiff;
  showUnchanged?: boolean;
}) {
  const rows = showUnchanged ? diff.items : diff.items.filter((r) => r.change !== 'unchanged');
  const s = diff.summary;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-1.5" aria-label="Drift summary" data-testid="drift-summary">
        <li>
          <StatusBadge tone="success" label={`Added: ${String(s.added)}`} dot={false} />
        </li>
        <li>
          <StatusBadge tone="danger" label={`Removed: ${String(s.removed)}`} dot={false} />
        </li>
        <li>
          <StatusBadge tone="warning" label={`Changed: ${String(s.modified)}`} dot={false} />
        </li>
        <li>
          <StatusBadge tone="neutral" label={`Unchanged: ${String(s.unchanged)}`} dot={false} />
        </li>
        <li>
          <StatusBadge
            tone="neutral"
            label={`New versions: ${String(s.versionChanged)}`}
            dot={false}
          />
        </li>
      </ul>
      {rows.length === 0 ? (
        <div className="rounded-lg border bg-surface">
          <EmptyState
            icon={GitCompare}
            title="No drift"
            description="Names, metadata and value versions match."
          />
        </div>
      ) : (
        <div
          className="overflow-x-auto rounded-lg border bg-surface"
          tabIndex={0}
          role="region"
          aria-label="Drift"
        >
          <table className="w-full text-sm">
            <caption className="sr-only">Changes since the snapshot</caption>
            <thead className="bg-surface-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Key
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Change
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const note = valueNote(row, diff.valuesCompared);
                return (
                  <tr
                    key={`${row.from?.secretId ?? ''}:${row.to?.secretId ?? ''}:${row.key}`}
                    className="border-t align-top"
                    data-testid="drift-row"
                  >
                    <th scope="row" className="px-3 py-2 text-left font-mono text-xs font-medium">
                      {row.key}
                      {row.fields.includes('key') &&
                      row.from &&
                      row.to &&
                      row.from.key !== row.to.key ? (
                        <span className="block font-sans font-normal text-muted-foreground">
                          was {row.from.key}
                        </span>
                      ) : null}
                    </th>
                    <td className="px-3 py-2">
                      <StatusBadge
                        tone={CHANGE[row.change].tone}
                        label={CHANGE[row.change].label}
                        dot={false}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {row.fields.length > 0 ? (
                        <span>
                          Changed: {row.fields.map((f) => FIELD_LABELS[f] ?? f).join(', ')}
                        </span>
                      ) : null}
                      {row.fields.length > 0 && note ? ' · ' : null}
                      {note ? <span className="text-muted-foreground">{note}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
