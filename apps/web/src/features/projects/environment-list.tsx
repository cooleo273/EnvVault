'use client';

import {
  ENVIRONMENT_KIND_LABELS,
  ENVIRONMENT_KINDS,
  type EnvironmentSummary,
  type EnvironmentTemplate,
} from '@envvault/shared';
import { ArrowDown, ArrowUp, Layers, PlusIcon, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { SearchInput } from '@/components/data/search-input';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { EmptyState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/textarea';
import { reorderEnvironmentsAction } from './actions';
import { templateChoices } from './pickers';
import { EnvironmentIcon } from './visual';

/** EnvironmentCreateDialog: start from a template or from scratch. */
export function EnvironmentCreateDialog({
  newHref,
  templates,
}: {
  newHref: string;
  templates: EnvironmentTemplate[];
}) {
  const [open, setOpen] = useState(false);
  const choices = templateChoices(templates);
  return (
    <ResponsiveModal
      open={open}
      onOpenChange={setOpen}
      title="New environment"
      description="Start from a template or create a custom environment. You can rename it later; its id never changes."
      trigger={
        <Button>
          <PlusIcon aria-hidden="true" />
          New environment
        </Button>
      }
    >
      <ul className="grid gap-2 sm:grid-cols-2">
        {choices.map((choice) => (
          <li key={choice.id}>
            <Link
              href={`${newHref}?template=${encodeURIComponent(choice.id)}`}
              className="focus-ring flex items-center gap-2 rounded-md border bg-surface px-3 py-2 text-sm hover:bg-accent"
            >
              {choice.entry.name}
              {choice.entry.isProtected ? (
                <ShieldCheck aria-label="protected" className="size-3.5 text-muted-foreground" />
              ) : null}
              {!choice.template.builtIn ? (
                <span className="ml-auto text-2xs text-muted-foreground">
                  {choice.template.name}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
        <li className="sm:col-span-2">
          <Link
            href={newHref}
            className="focus-ring flex items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm hover:bg-accent"
          >
            <PlusIcon aria-hidden="true" className="size-4" />
            Custom environment
          </Link>
        </li>
      </ul>
    </ResponsiveModal>
  );
}

export interface EnvironmentListProps {
  workspaceId: string;
  projectId: string;
  environments: EnvironmentSummary[];
  total: number;
  canReorder: boolean;
}

/** EnvironmentList: filterable, reorderable list of a project's environments. */
export function EnvironmentList({
  workspaceId,
  projectId,
  environments,
  total,
  canReorder,
}: EnvironmentListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [order, setOrder] = useState(environments);
  const [saving, setSaving] = useState(false);
  const filtered = ['q', 'kind', 'status'].some((key) => Boolean(params.get(key)));

  // Keep local order in sync when the server sends a new list.
  const [previous, setPrevious] = useState(environments);
  if (previous !== environments) {
    setPrevious(environments);
    setOrder(environments);
  }

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    startTransition(() => {
      router.replace(`${pathname}${next.size ? `?${next.toString()}` : ''}`, { scroll: false });
    });
  }

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

  async function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(target, 0, item);
    setOrder(next);
    setSaving(true);
    const result = await reorderEnvironmentsAction(
      workspaceId,
      projectId,
      next.map((e) => e.id),
    );
    setSaving(false);
    if (!result.ok) {
      setOrder(order);
      notify.error(result.message);
    }
  }

  const base = `/workspaces/${workspaceId}/projects/${projectId}/environments`;
  // Reordering applies to the full, unfiltered list only.
  const reorderable = canReorder && !filtered && order.length === total;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput
          label="Search environments"
          placeholder="Search environments…"
          value={query}
          onValueChange={setQuery}
          className="sm:max-w-xs"
        />
        <div className="flex gap-2 sm:ml-auto">
          <NativeSelect
            aria-label="Type"
            value={params.get('kind') ?? ''}
            className="h-control-sm w-auto"
            onChange={(e) => {
              update({ kind: e.target.value || null });
            }}
          >
            <option value="">All types</option>
            {ENVIRONMENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {ENVIRONMENT_KIND_LABELS[kind]}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Status"
            value={params.get('status') ?? 'active'}
            className="h-control-sm w-auto"
            onChange={(e) => {
              update({ status: e.target.value === 'active' ? null : e.target.value });
            }}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </NativeSelect>
        </div>
      </div>

      {order.length === 0 ? (
        <div className="rounded-lg border bg-surface">
          <EmptyState
            icon={Layers}
            title={filtered ? 'No environments match' : 'No environments yet'}
            description={
              filtered
                ? 'Try another search or filter.'
                : 'Create Development, QA, Production or any custom environment.'
            }
          />
        </div>
      ) : (
        <ol
          className="divide-y rounded-lg border bg-surface"
          aria-label="Environments"
          aria-busy={saving}
        >
          {order.map((env, index) => (
            <li key={env.id} className="flex items-center gap-3 px-3 py-2.5">
              <EnvironmentIcon icon={env.icon} kind={env.kind} color={env.color} />
              <div className="flex min-w-0 flex-1 flex-col">
                <Link
                  href={`${base}/${env.id}`}
                  className="focus-ring flex items-center gap-1.5 truncate rounded-sm text-sm font-medium hover:underline"
                >
                  {env.name}
                  {env.isProtected ? (
                    <ShieldCheck
                      aria-label="Protected"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                </Link>
                <span className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{env.slug}</span> ·{' '}
                  {ENVIRONMENT_KIND_LABELS[env.kind]}
                  {env.description ? ` · ${env.description}` : ''}
                </span>
              </div>
              {env.status === 'ARCHIVED' ? (
                <StatusBadge tone="warning" label="Archived" dot={false} />
              ) : null}
              {reorderable ? (
                <div className="flex shrink-0 gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={index === 0 || saving}
                    aria-label={`Move ${env.name} up`}
                    onClick={() => void move(index, -1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={index === order.length - 1 || saving}
                    aria-label={`Move ${env.name} down`}
                    onClick={() => void move(index, 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {total > order.length ? (
        <p className="text-xs text-muted-foreground">
          Showing {order.length} of {total}. Refine the search to narrow the list.
        </p>
      ) : null}
    </div>
  );
}
