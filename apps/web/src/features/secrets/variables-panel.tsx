'use client';

import {
  type EnvironmentSummary,
  SECRET_TYPE_LABELS,
  SECRET_TYPES,
  type SecretList,
  type SecretSummary,
  type SecretType,
} from '@envvault/shared';
import {
  Download,
  FileUp,
  KeyRound,
  MoreHorizontal,
  PlusIcon,
  RotateCcw,
  SearchX,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { type DataTableColumn, DataTable } from '@/components/data/data-table';
import { FilterDropdown } from '@/components/data/filter-dropdown';
import { Pagination } from '@/components/data/pagination';
import { SearchInput } from '@/components/data/search-input';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { copyToClipboard } from '@/components/forms/clipboard';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NativeSelect } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { deleteSecretAction, restoreSecretAction, type SecretActionResult } from './actions';
import { BulkBar, type SelectedSecret } from './bulk-bar';
import { ExportDialog } from './export-dialog';
import { HistoryDrawer } from './history-drawer';
import { ImportWizard } from './import-wizard';
import { SecretValueCell } from './secret-value-cell';
import { VariableDialog } from './variable-dialog';

const NO_CATEGORY = 'none';
const NO_SELECTION: ReadonlyMap<string, SelectedSecret> = new Map();
const dateTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function ago(iso: string): string {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

/** ConfirmDialog stays open on a thrown error, so failures are reported and rethrown. */
async function report(result: Promise<SecretActionResult>): Promise<void> {
  const outcome = await result;
  if (!outcome.ok) {
    notify.error(outcome.message);
    throw new Error(outcome.message);
  }
  if (outcome.message) notify.success(outcome.message);
}

export interface VariablesPanelProps {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  /** Null when loading the list failed. */
  list: SecretList | null;
  permissions: readonly string[];
  isProtected: boolean;
  archived: boolean;
  /** Expected key names from the environment template that have no variable yet. */
  missingKeys: readonly string[];
  environmentName: string;
  /** Environments the caller can see (for exporting another one). */
  environments: readonly Pick<EnvironmentSummary, 'id' | 'name' | 'isProtected'>[];
}

type DialogState = { mode: 'add'; key?: string } | { mode: 'edit'; secret: SecretSummary } | null;

/**
 * Variables of one environment. Search, filters, sort and page live in the
 * URL; the server fetches one page of metadata (never values). Values are
 * fetched one at a time on reveal.
 */
export function VariablesPanel({
  workspaceId,
  projectId,
  environmentId,
  list,
  permissions,
  isProtected,
  archived,
  missingKeys,
  environmentName,
  environments,
}: VariablesPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [loading, startTransition] = useTransition();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleting, setDeleting] = useState<SecretSummary | null>(null);
  // A selection belongs to one view (Active or Deleted); switching starts over.
  const [selection, setSelection] = useState<{ view: string; items: Map<string, SelectedSecret> }>({
    view: 'active',
    items: new Map(),
  });
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [historyOf, setHistoryOf] = useState<SecretSummary | null>(null);

  const can = (permission: string) => permissions.includes(permission);
  const canWrite = can('secret:write') && !archived;
  const canDelete = can('secret:delete') && !archived;
  const canReveal = can('secret:read');
  const canExport = can('secret:export') && can('secret:read');
  const canRollback = can('secret:rollback') && !archived;
  const status = params.get('status') === 'deleted' ? 'deleted' : 'active';
  const types = (params.get('type') ?? '')
    .split(',')
    .filter((t): t is SecretType => (SECRET_TYPES as readonly string[]).includes(t));
  const categories = (params.get('category') ?? '').split(',').filter(Boolean);
  const tag = params.get('tag') ?? '';
  const sort = params.get('sort') ?? 'name';
  const pageSize = list?.pageSize ?? 50;
  const filtered =
    Boolean(params.get('q')) || types.length > 0 || categories.length > 0 || tag !== '';

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page');
    startTransition(() => {
      router.replace(`${pathname}${next.size ? `?${next.toString()}` : ''}`, { scroll: false });
    });
  }

  // Debounced server side search.
  useEffect(() => {
    if ((params.get('q') ?? '') === query) return;
    const timer = setTimeout(() => {
      update({ q: query.trim() || null });
    }, 300);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the query drives this effect
  }, [query]);

  const selected = selection.view === status ? selection.items : NO_SELECTION;
  function setSelected(
    update:
      | Map<string, SelectedSecret>
      | ((current: ReadonlyMap<string, SelectedSecret>) => Map<string, SelectedSecret>),
  ) {
    setSelection((current) => ({
      view: status,
      items:
        typeof update === 'function'
          ? update(current.view === status ? current.items : NO_SELECTION)
          : update,
    }));
  }

  const items = list?.items ?? [];
  const knownKeys = items.map((s) => s.key);
  const allVisibleSelected = items.length > 0 && items.every((s) => selected.has(s.id));

  function toggle(rows: readonly SecretSummary[], on: boolean) {
    setSelected((current) => {
      const next = new Map(current);
      for (const row of rows) {
        if (on) next.set(row.id, { id: row.id, key: row.key, revision: row.revision });
        else next.delete(row.id);
      }
      return next;
    });
  }

  const columns: DataTableColumn<SecretSummary>[] = [
    {
      id: 'select',
      header: 'Select',
      className: 'w-8',
      headerContent: (
        <input
          type="checkbox"
          aria-label="Select all visible variables"
          checked={allVisibleSelected}
          disabled={items.length === 0}
          onChange={(e) => {
            toggle(items, e.target.checked);
          }}
        />
      ),
      cell: (s) => (
        <input
          type="checkbox"
          aria-label={`Select ${s.key}`}
          checked={selected.has(s.id)}
          onChange={(e) => {
            toggle([s], e.target.checked);
          }}
        />
      ),
    },
    {
      id: 'key',
      header: 'Key',
      isRowHeader: true,
      className: 'w-[28%] min-w-48',
      cell: (s) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-mono text-xs font-medium" data-testid="secret-key">
              {s.key}
            </span>
            {s.isRequired ? <StatusBadge tone="neutral" label="Required" dot={false} /> : null}
          </span>
          {s.description ? (
            <span className="truncate text-xs text-muted-foreground" title={s.description}>
              {s.description}
            </span>
          ) : null}
          {s.tags.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {s.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="focus-ring rounded-sm border px-1 text-2xs text-muted-foreground hover:text-foreground"
                  aria-label={`Filter by tag ${t}`}
                  onClick={() => {
                    update({ tag: t });
                  }}
                >
                  {t}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'value',
      header: 'Value',
      className: 'min-w-56',
      cell: (s) =>
        status === 'deleted' ? (
          <span className="text-xs text-muted-foreground italic">Deleted</span>
        ) : (
          <SecretValueCell
            workspaceId={workspaceId}
            projectId={projectId}
            environmentId={environmentId}
            secretId={s.id}
            secretKey={s.key}
            hasValue={s.hasValue}
            canReveal={canReveal}
            multiline={s.type === 'MULTILINE' || s.type === 'JSON'}
          />
        ),
    },
    {
      id: 'type',
      header: 'Type',
      hideBelow: 'sm',
      cell: (s) => (
        <span className="flex items-center gap-1.5">
          <StatusBadge tone="neutral" label={SECRET_TYPE_LABELS[s.type]} dot={false} />
          {s.currentVersion !== null ? (
            <span
              className="font-mono text-2xs text-muted-foreground"
              title={`Version ${String(s.currentVersion)}`}
              data-testid="secret-version"
            >
              v{s.currentVersion}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'category',
      header: 'Category',
      hideBelow: 'md',
      cell: (s) =>
        s.category ? (
          <span className="text-xs">{s.category}</span>
        ) : (
          <span className="text-xs text-muted-foreground">None</span>
        ),
    },
    {
      id: 'updated',
      header: status === 'deleted' ? 'Deleted' : 'Updated',
      hideBelow: 'lg',
      cell: (s) => {
        const when = status === 'deleted' && s.deletedAt ? s.deletedAt : s.updatedAt;
        const who = status === 'deleted' ? s.deletedBy : s.updatedBy;
        return (
          <span
            className="text-xs whitespace-nowrap text-muted-foreground"
            title={`${dateTime.format(new Date(when))}${who ? ` by ${who.displayName ?? who.email}` : ''}`}
          >
            {ago(when)}
          </span>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      className: 'w-16',
      cell: (s) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.key}`}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                void copyToClipboard(s.key).then((copied) => {
                  if (copied) notify.success('Name copied');
                });
              }}
            >
              Copy name
            </DropdownMenuItem>
            {status === 'active' && canWrite ? (
              <DropdownMenuItem
                onSelect={() => {
                  setDialog({ mode: 'edit', secret: s });
                }}
              >
                Edit
              </DropdownMenuItem>
            ) : null}
            {status === 'active' && s.hasValue ? (
              <DropdownMenuItem
                onSelect={() => {
                  setHistoryOf(s);
                }}
              >
                History
              </DropdownMenuItem>
            ) : null}
            {status === 'active' && canDelete ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-danger"
                  onSelect={() => {
                    setDeleting(s);
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </>
            ) : null}
            {status === 'deleted' && canDelete ? (
              <DropdownMenuItem
                onSelect={() => {
                  void report(
                    restoreSecretAction(workspaceId, projectId, environmentId, s.id),
                  ).catch(() => undefined);
                }}
              >
                <RotateCcw aria-hidden="true" />
                Restore
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const typeOptions = SECRET_TYPES.map((t) => ({ value: t, label: SECRET_TYPE_LABELS[t] }));
  const categoryOptions = [
    ...(list?.facets.categories ?? []).map((c) => ({ value: c, label: c })),
    { value: NO_CATEGORY, label: 'No category' },
  ];

  let emptyState = (
    <EmptyState
      icon={KeyRound}
      title="No variables yet"
      description={
        canWrite
          ? 'Add the first variable for this environment. Values are encrypted before they are stored.'
          : 'Nobody has added variables to this environment yet.'
      }
      {...(canWrite
        ? {
            action: (
              <Button
                size="sm"
                onClick={() => {
                  setDialog({ mode: 'add' });
                }}
              >
                <PlusIcon aria-hidden="true" />
                Add variable
              </Button>
            ),
          }
        : {})}
    />
  );
  if (filtered) {
    emptyState = (
      <EmptyState
        icon={SearchX}
        title="No matching variables"
        description="Try another search or clear the filters."
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setQuery('');
              update({ q: null, type: null, category: null, tag: null });
            }}
          >
            Clear filters
          </Button>
        }
      />
    );
  } else if (status === 'deleted') {
    emptyState = <EmptyState icon={KeyRound} title="No deleted variables" />;
  }

  return (
    <section aria-labelledby="variables-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="variables-heading" className="text-sm font-semibold">
          Variables
        </h3>
        {list ? (
          <span className="text-xs text-muted-foreground tabular-nums" data-testid="variable-count">
            {list.total} {list.total === 1 ? 'variable' : 'variables'}
            {status === 'deleted' ? ' deleted' : ''}
          </span>
        ) : null}
        {isProtected ? (
          <StatusBadge
            tone="warning"
            label={
              canReveal
                ? 'Protected: reveals need your password'
                : 'Protected: values need a direct grant'
            }
            dot={false}
          />
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-md border" role="group" aria-label="Show">
            {(['active', 'deleted'] as const).map((value) => (
              <Button
                key={value}
                variant="ghost"
                size="sm"
                aria-pressed={status === value}
                className={cn(
                  'rounded-none first:rounded-l-md last:rounded-r-md',
                  status === value && 'bg-accent',
                )}
                onClick={() => {
                  update({ status: value === 'active' ? null : value });
                }}
              >
                {value === 'active' ? 'Active' : 'Deleted'}
              </Button>
            ))}
          </div>
          {canWrite && status === 'active' ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setImporting(true);
              }}
            >
              <FileUp aria-hidden="true" />
              Import
            </Button>
          ) : null}
          {canExport ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setExporting(true);
              }}
            >
              <Download aria-hidden="true" />
              Export
            </Button>
          ) : null}
          {canWrite ? (
            <Button
              size="sm"
              onClick={() => {
                setDialog({ mode: 'add' });
              }}
            >
              <PlusIcon aria-hidden="true" />
              Add variable
            </Button>
          ) : null}
        </div>
      </div>

      {selected.size > 0 ? (
        <BulkBar
          workspaceId={workspaceId}
          projectId={projectId}
          environmentId={environmentId}
          selected={[...selected.values()]}
          status={status}
          matching={list?.total ?? selected.size}
          filters={{
            ...(params.get('q') ? { q: params.get('q') ?? '' } : {}),
            ...(types.length ? { type: types } : {}),
            ...(categories.length ? { category: categories } : {}),
            ...(tag ? { tag } : {}),
          }}
          canWrite={canWrite}
          canDelete={canDelete}
          canExport={canExport}
          onSelect={(rows) => {
            setSelected(new Map(rows.map((r) => [r.id, r])));
          }}
          onClear={() => {
            setSelected(new Map());
          }}
          onExport={() => {
            setExporting(true);
          }}
        />
      ) : null}

      {missingKeys.length > 0 && status === 'active' && canWrite ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed px-3 py-2">
          <span className="text-xs text-muted-foreground">
            Expected by the template, not added yet:
          </span>
          {missingKeys.map((key) => (
            <Button
              key={key}
              variant="outline"
              size="sm"
              className="h-6 font-mono text-2xs"
              onClick={() => {
                setDialog({ mode: 'add', key });
              }}
            >
              <PlusIcon aria-hidden="true" />
              {key}
            </Button>
          ))}
        </div>
      ) : null}

      <div aria-busy={loading} className={cn('transition-opacity', loading && 'opacity-60')}>
        <DataTable
          caption="Environment variables"
          columns={columns}
          data={items}
          getRowId={(s) => s.id}
          pageSize={false}
          status={list ? 'ready' : 'error'}
          emptyState={emptyState}
          errorState={
            <ErrorState
              title="Variables could not be loaded"
              description="The list is unavailable right now. Nothing has changed."
              onRetry={() => {
                router.refresh();
              }}
            />
          }
          toolbar={
            <>
              <SearchInput
                label="Search variables"
                placeholder="Search names and descriptions…"
                value={query}
                onValueChange={setQuery}
                className="sm:max-w-xs"
              />
              <FilterDropdown
                label="Type"
                options={typeOptions}
                selected={types}
                onSelectedChange={(selected) => {
                  update({ type: selected.join(',') || null });
                }}
              />
              <FilterDropdown
                label="Category"
                options={categoryOptions}
                selected={categories}
                onSelectedChange={(selected) => {
                  update({ category: selected.join(',') || null });
                }}
              />
              {(list?.facets.tags.length ?? 0) > 0 || tag ? (
                <NativeSelect
                  aria-label="Tag"
                  value={tag}
                  className="h-control-sm w-auto"
                  onChange={(e) => {
                    update({ tag: e.target.value || null });
                  }}
                >
                  <option value="">All tags</option>
                  {[...new Set([...(list?.facets.tags ?? []), ...(tag ? [tag] : [])])].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}
              <NativeSelect
                aria-label="Sort by"
                value={sort}
                className="h-control-sm w-auto sm:ml-auto"
                onChange={(e) => {
                  update({ sort: e.target.value === 'name' ? null : e.target.value });
                }}
              >
                <option value="name">Name</option>
                <option value="type">Type</option>
                <option value="category">Category</option>
                <option value="updated">Recently updated</option>
                <option value="created">Recently created</option>
              </NativeSelect>
            </>
          }
        />
      </div>

      {list && list.total > pageSize ? (
        <Pagination
          page={list.page}
          pageCount={Math.ceil(list.total / pageSize)}
          totalItems={list.total}
          pageSize={pageSize}
          onPageChange={(page) => {
            update({ page: page === 1 ? null : String(page) });
          }}
        />
      ) : null}

      {dialog ? (
        <VariableDialog
          key={
            dialog.mode === 'edit'
              ? `${dialog.secret.id}:${String(dialog.secret.revision)}`
              : `add:${dialog.key ?? ''}`
          }
          workspaceId={workspaceId}
          projectId={projectId}
          environmentId={environmentId}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          {...(dialog.mode === 'edit' ? { secret: dialog.secret } : {})}
          {...(dialog.mode === 'add' && dialog.key ? { initialKey: dialog.key } : {})}
          knownKeys={knownKeys}
          categories={list?.facets.categories ?? []}
        />
      ) : null}

      {importing ? (
        <ImportWizard
          workspaceId={workspaceId}
          projectId={projectId}
          environmentId={environmentId}
          environmentName={environmentName}
          isProtected={isProtected}
          open
          onOpenChange={setImporting}
        />
      ) : null}
      {exporting ? (
        <ExportDialog
          workspaceId={workspaceId}
          projectId={projectId}
          currentEnvironmentId={environmentId}
          environments={
            environments.length > 0
              ? environments
              : [{ id: environmentId, name: environmentName, isProtected }]
          }
          selectedIds={[...selected.keys()]}
          open
          onOpenChange={setExporting}
        />
      ) : null}
      {historyOf ? (
        <HistoryDrawer
          key={historyOf.id}
          workspaceId={workspaceId}
          projectId={projectId}
          environmentId={environmentId}
          secret={items.find((s) => s.id === historyOf.id) ?? historyOf}
          canReveal={canReveal}
          canRollback={canRollback}
          archived={archived}
          open
          onOpenChange={(open) => {
            if (!open) setHistoryOf(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.key ?? 'variable'}?`}
        description={
          <>
            The variable disappears from this environment. Its encrypted versions are kept, and
            anyone allowed to delete variables can restore it from <strong>Deleted</strong>.
            {isProtected ? ' This is a protected environment.' : ''}
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await report(
            deleteSecretAction(
              workspaceId,
              projectId,
              environmentId,
              deleting.id,
              deleting.revision,
            ),
          );
          setDeleting(null);
        }}
      />
    </section>
  );
}
