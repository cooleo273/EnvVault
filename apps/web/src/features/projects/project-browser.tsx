'use client';

import type { Paginated, ProjectSummary } from '@envvault/shared';
import { FolderGit2, LayoutGrid, List, Star } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Pagination } from '@/components/data/pagination';
import { SearchInput } from '@/components/data/search-input';
import { EmptyState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { setFavoriteAction } from './actions';
import { ProjectAvatar } from './visual';

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function ago(iso: string): string {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

function FavoriteButton({
  workspaceId,
  project,
}: {
  workspaceId: string;
  project: ProjectSummary;
}) {
  const [favorite, setFavorite] = useState(project.isFavorite);
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      disabled={pending}
      aria-pressed={favorite}
      aria-label={
        favorite ? `Remove ${project.name} from favorites` : `Add ${project.name} to favorites`
      }
      onClick={(event) => {
        event.preventDefault();
        const next = !favorite;
        setFavorite(next);
        startTransition(async () => {
          const result = await setFavoriteAction(workspaceId, project.id, next);
          if (!result.ok) {
            setFavorite(!next);
            notify.error(result.message);
          }
        });
      }}
    >
      <Star
        aria-hidden="true"
        className={cn('size-4', favorite && 'fill-amber-400 text-amber-500')}
      />
    </Button>
  );
}

function Meta({ project }: { project: ProjectSummary }) {
  return (
    <span className="text-xs text-muted-foreground">
      {project.environmentCount} {project.environmentCount === 1 ? 'environment' : 'environments'}
      {project.protectedEnvironmentCount > 0
        ? ` · ${String(project.protectedEnvironmentCount)} protected`
        : ''}
      {' · '}
      {project.memberCount} {project.memberCount === 1 ? 'member' : 'members'}
    </span>
  );
}

function AccessLabel({ project }: { project: ProjectSummary }) {
  if (project.access.role) return <>{project.access.role.name}</>;
  return <>Workspace admin</>;
}

export function ProjectCard({
  workspaceId,
  project,
}: {
  workspaceId: string;
  project: ProjectSummary;
}) {
  return (
    <li className="group relative flex flex-col gap-3 rounded-lg border bg-surface p-4 transition-colors hover:border-ring/60">
      <div className="flex items-start gap-3">
        <ProjectAvatar icon={project.icon} color={project.color} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Link
            href={`/workspaces/${workspaceId}/projects/${project.id}`}
            className="focus-ring truncate rounded-sm text-sm font-medium after:absolute after:inset-0 hover:underline"
          >
            {project.name}
          </Link>
          <span className="truncate font-mono text-xs text-muted-foreground">{project.slug}</span>
        </div>
        <div className="relative z-10">
          <FavoriteButton workspaceId={workspaceId} project={project} />
        </div>
      </div>
      {project.description ? (
        <p className="line-clamp-2 text-xs text-muted-foreground">{project.description}</p>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        {project.status === 'ARCHIVED' ? (
          <StatusBadge tone="warning" label="Archived" dot={false} />
        ) : null}
        <Meta project={project} />
      </div>
    </li>
  );
}

export interface ProjectBrowserProps {
  workspaceId: string;
  result: Paginated<ProjectSummary> | null;
  recent: ProjectSummary[];
  view: 'grid' | 'list';
  canCreate: boolean;
}

/**
 * Search, filters, sort and pagination live in the URL; the server fetches
 * one page from the API. View mode (grid/list) is also a URL parameter.
 */
export function ProjectBrowser({
  workspaceId,
  result,
  recent,
  view,
  canCreate,
}: ProjectBrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState(params.get('q') ?? '');

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

  // Debounced server-side search.
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

  const status = params.get('status') ?? 'active';
  const sort = params.get('sort') ?? 'name';
  const favorites = params.get('favorite') === 'true';
  const filtered = Boolean(params.get('q')) || status !== 'active' || favorites;

  return (
    <div className="flex flex-col gap-4">
      {recent.length > 0 && !filtered ? (
        <section aria-labelledby="recent-projects" className="flex flex-col gap-2">
          <h2
            id="recent-projects"
            className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            Recently opened
          </h2>
          <ul className="flex gap-2 overflow-x-auto pb-1">
            {recent.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/workspaces/${workspaceId}/projects/${p.id}`}
                  className="focus-ring flex items-center gap-2 rounded-md border bg-surface py-1.5 pr-3 pl-1.5 text-sm whitespace-nowrap hover:bg-accent"
                >
                  <ProjectAvatar icon={p.icon} color={p.color} size="sm" />
                  {p.name}
                  {p.lastVisitedAt ? (
                    <span className="text-xs text-muted-foreground">{ago(p.lastVisitedAt)}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput
          label="Search projects"
          placeholder="Search projects…"
          value={query}
          onValueChange={setQuery}
          className="sm:max-w-xs"
        />
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <NativeSelect
            aria-label="Status"
            value={status}
            className="h-control-sm w-auto"
            onChange={(e) => {
              update({ status: e.target.value === 'active' ? null : e.target.value });
            }}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </NativeSelect>
          <NativeSelect
            aria-label="Sort by"
            value={sort}
            className="h-control-sm w-auto"
            onChange={(e) => {
              update({ sort: e.target.value === 'name' ? null : e.target.value });
            }}
          >
            <option value="name">Name</option>
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="recent">Recently opened</option>
          </NativeSelect>
          <Button
            variant={favorites ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={favorites}
            onClick={() => {
              update({ favorite: favorites ? null : 'true' });
            }}
          >
            <Star aria-hidden="true" className={cn(favorites && 'fill-amber-400 text-amber-500')} />
            Favorites
          </Button>
          <div className="flex rounded-md border" role="group" aria-label="View">
            {(
              [
                ['grid', LayoutGrid, 'Grid view'],
                ['list', List, 'List view'],
              ] as const
            ).map(([value, Icon, label]) => (
              <Button
                key={value}
                variant="ghost"
                size="icon"
                className={cn(
                  'size-8 rounded-none first:rounded-l-md last:rounded-r-md',
                  view === value && 'bg-accent',
                )}
                aria-label={label}
                aria-pressed={view === value}
                onClick={() => {
                  update({ view: value === 'grid' ? null : value, page: params.get('page') });
                }}
              >
                <Icon aria-hidden="true" />
              </Button>
            ))}
          </div>
        </div>
      </div>

      {result === null ? (
        <div className="rounded-lg border bg-surface">
          <EmptyState
            title="Projects could not be loaded"
            description="The EnvVault API is unavailable. Try again shortly."
          />
        </div>
      ) : result.items.length === 0 ? (
        <div className="rounded-lg border bg-surface">
          <EmptyState
            icon={FolderGit2}
            title={filtered ? 'No projects match' : 'No projects yet'}
            description={
              filtered
                ? 'Try another search or filter.'
                : canCreate
                  ? 'Create a project to organise environments such as Development, QA and Production.'
                  : 'Ask a workspace admin to add you to a project.'
            }
            action={
              !filtered && canCreate ? (
                <Button asChild>
                  <Link href={`/workspaces/${workspaceId}/projects/new`}>New project</Link>
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : view === 'grid' ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Projects">
          {result.items.map((p) => (
            <ProjectCard key={p.id} workspaceId={workspaceId} project={p} />
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">Projects</caption>
            <thead className="border-b bg-surface-muted text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Project
                </th>
                <th scope="col" className="hidden px-4 py-2 font-medium md:table-cell">
                  Environments
                </th>
                <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">
                  Your access
                </th>
                <th scope="col" className="hidden px-4 py-2 font-medium lg:table-cell">
                  Updated
                </th>
                <th scope="col" className="w-10 px-2 py-2">
                  <span className="sr-only">Favorite</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((p) => (
                <tr key={p.id} className="border-b last:border-b-0 hover:bg-accent/40">
                  <th scope="row" className="px-4 py-2 text-left font-normal">
                    <div className="flex items-center gap-3">
                      <ProjectAvatar icon={p.icon} color={p.color} size="sm" />
                      <div className="flex min-w-0 flex-col">
                        <Link
                          href={`/workspaces/${workspaceId}/projects/${p.id}`}
                          className="focus-ring truncate rounded-sm font-medium hover:underline"
                        >
                          {p.name}
                        </Link>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {p.slug}
                        </span>
                      </div>
                      {p.status === 'ARCHIVED' ? (
                        <StatusBadge tone="warning" label="Archived" dot={false} />
                      ) : null}
                    </div>
                  </th>
                  <td className="hidden px-4 py-2 md:table-cell">
                    <Meta project={p} />
                  </td>
                  <td className="hidden px-4 py-2 text-xs sm:table-cell">
                    <AccessLabel project={p} />
                  </td>
                  <td className="hidden px-4 py-2 text-xs text-muted-foreground lg:table-cell">
                    {ago(p.updatedAt)}
                  </td>
                  <td className="px-2 py-2">
                    <FavoriteButton workspaceId={workspaceId} project={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result && result.total > result.pageSize ? (
        <Pagination
          page={result.page}
          pageCount={Math.ceil(result.total / result.pageSize)}
          totalItems={result.total}
          pageSize={result.pageSize}
          onPageChange={(page) => {
            update({ page: page === 1 ? null : String(page) });
          }}
        />
      ) : null}
    </div>
  );
}
