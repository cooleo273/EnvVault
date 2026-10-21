'use client';

import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import type * as React from 'react';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/feedback/states';
import { useTableDensity } from '@/components/preferences/use-table-density';
import type { TableDensity } from '@/design/tokens';
import { cn } from '@/lib/utils';
import { Pagination } from './pagination';

export type SortDirection = 'asc' | 'desc';
export type SortValue = string | number | Date | null | undefined;

export interface DataTableColumn<T> {
  id: string;
  header: string;
  /** Rendered instead of `header` (for example a select all checkbox); `header` stays the accessible name. */
  headerContent?: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Enables sorting on this column. */
  sortValue?: (row: T) => SortValue;
  align?: 'start' | 'end';
  /** Hide on narrow screens to keep tables readable. */
  hideBelow?: 'sm' | 'md' | 'lg';
  /** Tailwind width utility, e.g. `w-40`. */
  className?: string;
  /** Render cells as row headers (`<th scope="row">`), typically the name column. */
  isRowHeader?: boolean;
}

export interface DataTableSort {
  columnId: string;
  direction: SortDirection;
}

export interface DataTableProps<T> {
  /** Accessible table name (rendered as a visually hidden caption). */
  caption: string;
  columns: readonly DataTableColumn<T>[];
  data: readonly T[];
  getRowId: (row: T) => string;
  status?: 'ready' | 'loading' | 'error';
  /** Shown when status is ready and there are no rows. */
  emptyState?: React.ReactNode;
  /** Shown when status is error. */
  errorState?: React.ReactNode;
  /** Overrides the user's density preference. */
  density?: TableDensity;
  /** Rows per page; `false` disables pagination. */
  pageSize?: number | false;
  initialSort?: DataTableSort;
  /** Filters, search and actions rendered above the table. */
  toolbar?: React.ReactNode;
  className?: string;
}

const HIDE_BELOW: Record<NonNullable<DataTableColumn<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compare(a: SortValue, b: SortValue): number {
  // Empty values always sort last.
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/**
 * Accessible, sortable, paginated table for up to a few thousand client-side
 * rows. Larger datasets should be paginated server-side and passed one page
 * at a time with `pageSize={false}` plus an external <Pagination />.
 */
export function DataTable<T>({
  caption,
  columns,
  data,
  getRowId,
  status = 'ready',
  emptyState,
  errorState,
  density: densityOverride,
  pageSize = 25,
  initialSort,
  toolbar,
  className,
}: DataTableProps<T>) {
  const [preferredDensity] = useTableDensity();
  const density = densityOverride ?? preferredDensity;
  const [sort, setSort] = useState<DataTableSort | undefined>(initialSort);
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    const column = sort ? columns.find((c) => c.id === sort.columnId) : undefined;
    const getValue = column?.sortValue;
    if (!sort || !getValue) return data;
    const factor = sort.direction === 'asc' ? 1 : -1;
    // Array.prototype.toSorted is stable; empty values stay last in both directions.
    return data.toSorted((a, b) => {
      const va = getValue(a);
      const vb = getValue(b);
      const emptyA = va === null || va === undefined;
      const emptyB = vb === null || vb === undefined;
      if (emptyA || emptyB) return compare(va, vb);
      return compare(va, vb) * factor;
    });
  }, [data, columns, sort]);

  const paginated = pageSize !== false;
  const pageCount = paginated ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const currentPage = Math.min(page, pageCount);
  const rows = paginated
    ? sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : sorted;

  function toggleSort(columnId: string) {
    setSort((current) => {
      if (current?.columnId !== columnId) return { columnId, direction: 'asc' };
      if (current.direction === 'asc') return { columnId, direction: 'desc' };
      return undefined;
    });
    setPage(1);
  }

  let body: React.ReactNode = null;
  if (status === 'loading') {
    body = <LoadingSkeleton variant="table" rows={5} label={`Loading ${caption.toLowerCase()}`} />;
  } else if (status === 'error') {
    body = <div className="rounded-lg border bg-surface">{errorState ?? <ErrorState />}</div>;
  } else if (data.length === 0) {
    body = (
      <div className="rounded-lg border bg-surface">
        {emptyState ?? <EmptyState title="No results" />}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {toolbar ? <div className="flex flex-wrap items-center gap-2">{toolbar}</div> : null}
      {body ?? (
        <>
          <div
            data-density={density}
            className="overflow-x-auto rounded-lg border bg-surface"
            // Scrollable region must be keyboard reachable.
            tabIndex={0}
            role="region"
            aria-label={caption}
          >
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">{caption}</caption>
              <thead className="sticky top-0 z-10 bg-surface-muted">
                <tr className="border-b">
                  {columns.map((column) => {
                    const sortedBy = sort?.columnId === column.id ? sort.direction : undefined;
                    let ariaSort: React.AriaAttributes['aria-sort'];
                    if (column.sortValue) {
                      ariaSort =
                        sortedBy === 'asc'
                          ? 'ascending'
                          : sortedBy === 'desc'
                            ? 'descending'
                            : 'none';
                    }
                    let SortIcon = ArrowUpDownIcon;
                    if (sortedBy === 'asc') SortIcon = ArrowUpIcon;
                    else if (sortedBy === 'desc') SortIcon = ArrowDownIcon;
                    return (
                      <th
                        key={column.id}
                        scope="col"
                        aria-sort={ariaSort}
                        className={cn(
                          'h-(--table-row-h) px-3 text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4',
                          column.align === 'end' ? 'text-right' : 'text-left',
                          column.hideBelow && HIDE_BELOW[column.hideBelow],
                          column.className,
                        )}
                      >
                        {column.sortValue ? (
                          <button
                            type="button"
                            onClick={() => {
                              toggleSort(column.id);
                            }}
                            className={cn(
                              'focus-ring -mx-1 inline-flex items-center gap-1 rounded-sm px-1 hover:text-foreground',
                              sortedBy && 'text-foreground',
                            )}
                          >
                            {column.header}
                            <SortIcon aria-hidden="true" className="size-3.5" />
                          </button>
                        ) : (
                          (column.headerContent ?? column.header)
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={getRowId(row)} className="border-b last:border-b-0 hover:bg-accent/60">
                    {columns.map((column) => {
                      const Cell = column.isRowHeader ? 'th' : 'td';
                      return (
                        <Cell
                          key={column.id}
                          {...(column.isRowHeader ? { scope: 'row' } : {})}
                          className={cn(
                            'h-(--table-row-h) px-3 align-middle font-normal first:pl-4 last:pr-4',
                            column.align === 'end' ? 'text-right tabular-nums' : 'text-left',
                            column.hideBelow && HIDE_BELOW[column.hideBelow],
                            column.className,
                          )}
                        >
                          {column.cell(row)}
                        </Cell>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {paginated && sorted.length > pageSize ? (
            <Pagination
              page={currentPage}
              pageCount={pageCount}
              onPageChange={setPage}
              totalItems={sorted.length}
              pageSize={pageSize}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
