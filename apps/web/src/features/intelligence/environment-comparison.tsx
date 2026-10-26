'use client';

import {
  type ComparisonRow,
  type EnvironmentComparison as Comparison,
  type EnvironmentSummary,
  SECRET_TYPE_LABELS,
} from '@envvault/shared';
import { ArrowLeftRight, GitCompare, LoaderIcon } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Pagination } from '@/components/data/pagination';
import { SearchInput } from '@/components/data/search-input';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { StatusBadge, type StatusBadgeProps } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { StepUpDialog } from '@/features/secrets/step-up-dialog';
import { compareEnvironmentsAction } from './actions';

type Filter = 'all' | 'differences' | 'only_source' | 'only_target' | 'metadata';

const FIELD_LABELS: Record<string, string> = {
  type: 'type',
  isRequired: 'required',
  category: 'category',
  tags: 'tags',
  description: 'description',
  inheritable: 'inheritable',
  hasValue: 'value set',
};

const VALUE_LABELS: Record<
  ComparisonRow['value'],
  { label: string; tone: StatusBadgeProps['tone'] }
> = {
  not_checked: { label: 'Value not checked', tone: 'neutral' },
  equal: { label: 'Same value', tone: 'success' },
  different: { label: 'Different value', tone: 'warning' },
  not_comparable: { label: 'No value on one side', tone: 'neutral' },
};

/** Totals for a comparison. "Present in both" never implies the same value. */
export function ComparisonSummary({ comparison }: { comparison: Comparison }) {
  const s = comparison.summary;
  const items: [string, number, StatusBadgeProps['tone']][] = [
    ['In both', s.both, 'neutral'],
    [`Only in ${comparison.source.name}`, s.onlySource, 'warning'],
    [`Only in ${comparison.target.name}`, s.onlyTarget, 'warning'],
    ['Type differs', s.typeMismatch, s.typeMismatch > 0 ? 'danger' : 'neutral'],
    ['Required differs', s.requiredMismatch, s.requiredMismatch > 0 ? 'warning' : 'neutral'],
    ['Metadata differs', s.metadataMismatch, 'neutral'],
  ];
  if (comparison.valuesCompared) {
    items.push(
      ['Same value', s.valuesEqual, 'success'],
      ['Different value', s.valuesDifferent, 'warning'],
    );
  }
  return (
    <ul
      className="flex flex-wrap gap-1.5"
      aria-label="Comparison summary"
      data-testid="comparison-summary"
    >
      {items.map(([label, count, tone]) => (
        <li key={label}>
          <StatusBadge tone={tone} label={`${label}: ${String(count)}`} dot={false} />
        </li>
      ))}
    </ul>
  );
}

function Side({ meta }: { meta: ComparisonRow['source'] }) {
  if (!meta) return <span className="text-xs text-muted-foreground italic">Missing</span>;
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs">
      <StatusBadge tone="neutral" label={SECRET_TYPE_LABELS[meta.type]} dot={false} />
      {meta.isRequired ? <span>Required</span> : null}
      {meta.category ? <span className="text-muted-foreground">{meta.category}</span> : null}
      {!meta.hasValue ? <span className="text-muted-foreground italic">no value</span> : null}
    </span>
  );
}

/** One row per variable name across both environments. */
export function DifferenceTable({ comparison }: { comparison: Comparison }) {
  if (comparison.items.length === 0) {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState
          icon={GitCompare}
          title="Nothing to show"
          description="No variables match this view."
        />
      </div>
    );
  }
  return (
    <div
      className="overflow-x-auto rounded-lg border bg-surface"
      tabIndex={0}
      role="region"
      aria-label="Differences"
    >
      <table className="w-full text-sm">
        <caption className="sr-only">
          Variables of {comparison.source.name} and {comparison.target.name}
        </caption>
        <thead className="bg-surface-muted text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Key
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {comparison.source.name}
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {comparison.target.name}
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Differences
            </th>
          </tr>
        </thead>
        <tbody>
          {comparison.items.map((row) => (
            <tr key={row.key} className="border-t align-top" data-testid="comparison-row">
              <th scope="row" className="px-3 py-2 text-left font-mono text-xs font-medium">
                {row.key}
              </th>
              <td className="px-3 py-2">
                <Side meta={row.source} />
              </td>
              <td className="px-3 py-2">
                <Side meta={row.target} />
              </td>
              <td className="px-3 py-2">
                <span className="flex flex-wrap items-center gap-1 text-xs">
                  {row.status === 'only_source' ? (
                    <StatusBadge
                      tone="warning"
                      label={`Missing from ${comparison.target.name}`}
                      dot={false}
                    />
                  ) : row.status === 'only_target' ? (
                    <StatusBadge
                      tone="warning"
                      label={`Missing from ${comparison.source.name}`}
                      dot={false}
                    />
                  ) : row.differences.length > 0 ? (
                    <StatusBadge
                      tone={row.differences.includes('type') ? 'danger' : 'neutral'}
                      label={`Differs: ${row.differences.map((f) => FIELD_LABELS[f] ?? f).join(', ')}`}
                      dot={false}
                    />
                  ) : (
                    <span className="text-muted-foreground">Metadata matches</span>
                  )}
                  {row.status === 'both' ? (
                    <StatusBadge
                      tone={VALUE_LABELS[row.value].tone}
                      label={VALUE_LABELS[row.value].label}
                      dot={false}
                    />
                  ) : null}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface EnvironmentComparisonProps {
  workspaceId: string;
  projectId: string;
  environments: readonly Pick<EnvironmentSummary, 'id' | 'name' | 'isProtected'>[];
  initial: Comparison | null;
  sourceId: string;
  targetId: string;
}

/**
 * Side by side comparison of two environments. Metadata only unless the
 * user asks to compare values, which the server does after checking value
 * read access in both (and a password confirmation for protected ones).
 */
export function EnvironmentComparison({
  workspaceId,
  projectId,
  environments,
  initial,
  sourceId,
  targetId,
}: EnvironmentComparisonProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [source, setSource] = useState(sourceId);
  const [target, setTarget] = useState(targetId);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [values, setValues] = useState(false);
  const [comparison, setComparison] = useState<Comparison | null>(initial);
  const [error, setError] = useState<string | null>(
    initial ? null : 'The comparison could not be loaded.',
  );
  const [loading, setLoading] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const first = useRef(true);

  async function load(next: { values?: boolean } = {}) {
    if (source === target) return;
    setLoading(true);
    try {
      const result = await compareEnvironmentsAction(workspaceId, projectId, {
        sourceEnvironmentId: source,
        targetEnvironmentId: target,
        compareValues: next.values ?? values,
        filter,
        page,
        pageSize: 100,
        ...(q.trim() ? { q: q.trim() } : {}),
      });
      if (result.ok) {
        setComparison(result.data);
        setError(null);
      } else if (result.code === 'STEP_UP_REQUIRED') {
        setStepUp(true);
      } else {
        setValues(false);
        if (next.values) notify.error(result.message);
        else setError(result.message);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => void load(), q ? 300 : 0);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the view changes
  }, [source, target, filter, q, page]);

  function choose(nextSource: string, nextTarget: string) {
    setSource(nextSource);
    setTarget(nextTarget);
    setPage(1);
    setValues(false);
    router.replace(`${pathname}?source=${nextSource}&target=${nextTarget}`, { scroll: false });
  }

  const options = environments.map((e) => (
    <option key={e.id} value={e.id}>
      {e.name}
      {e.isProtected ? ' (protected)' : ''}
    </option>
  ));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Source
          <NativeSelect
            aria-label="Source environment"
            value={source}
            className="h-control-sm w-48"
            onChange={(e) => {
              choose(e.target.value, target);
            }}
          >
            {options}
          </NativeSelect>
        </label>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Swap environments"
          onClick={() => {
            choose(target, source);
          }}
        >
          <ArrowLeftRight aria-hidden="true" />
        </Button>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Target
          <NativeSelect
            aria-label="Target environment"
            value={target}
            className="h-control-sm w-48"
            onChange={(e) => {
              choose(source, e.target.value);
            }}
          >
            {options}
          </NativeSelect>
        </label>
        <div className="ml-auto flex items-center gap-2">
          {loading ? (
            <LoaderIcon
              aria-label="Loading"
              className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
            />
          ) : null}
          <Button
            variant={values ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={values}
            disabled={loading || source === target}
            onClick={() => {
              const next = !values;
              setValues(next);
              void load({ values: next });
            }}
          >
            {values ? 'Hide value comparison' : 'Compare values'}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        By default only names and metadata are compared. Compare values checks on the server whether
        values match, without showing them; it needs value access to both environments and is
        recorded.
      </p>

      {source === target ? (
        <p role="alert" className="text-sm text-danger">
          Pick two different environments.
        </p>
      ) : error ? (
        <ErrorState
          title="Comparison unavailable"
          description={error}
          onRetry={() => void load()}
        />
      ) : comparison ? (
        <div className={cn('flex flex-col gap-3', loading && 'opacity-60')} aria-busy={loading}>
          <ComparisonSummary comparison={comparison} />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              label="Search keys"
              placeholder="Search keys…"
              value={q}
              onValueChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              className="sm:max-w-xs"
            />
            <div className="flex rounded-md border" role="group" aria-label="Show">
              {(
                [
                  ['all', 'All'],
                  ['differences', 'Differences'],
                  ['only_source', `Only ${comparison.source.name}`],
                  ['only_target', `Only ${comparison.target.name}`],
                  ['metadata', 'Metadata'],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="sm"
                  aria-pressed={filter === value}
                  className={cn(
                    'rounded-none first:rounded-l-md last:rounded-r-md',
                    filter === value && 'bg-accent',
                  )}
                  onClick={() => {
                    setFilter(value);
                    setPage(1);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <DifferenceTable comparison={comparison} />
          {comparison.total > comparison.pageSize ? (
            <Pagination
              page={comparison.page}
              pageCount={Math.ceil(comparison.total / comparison.pageSize)}
              totalItems={comparison.total}
              pageSize={comparison.pageSize}
              onPageChange={setPage}
            />
          ) : null}
        </div>
      ) : null}
      <StepUpDialog
        open={stepUp}
        onOpenChange={setStepUp}
        onConfirmed={() => void load({ values: true })}
      />
    </div>
  );
}
