'use client';

import { ENVIRONMENT_KIND_LABELS, ENVIRONMENT_KINDS, type EnvironmentKind } from '@envvault/shared';
import { FolderGit2 } from 'lucide-react';
import { useState } from 'react';
import { DataTable, type DataTableColumn } from '@/components/data/data-table';
import { FilterDropdown } from '@/components/data/filter-dropdown';
import { SearchInput } from '@/components/data/search-input';
import { EnvironmentBadge } from '@/components/domain/badges';
import { EmptyState } from '@/components/feedback/states';

/** Shape of a project row once the API exists. No rows are fabricated. */
export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  environments: { id: string; name: string; kind: EnvironmentKind; isProtected: boolean }[];
  secretCount: number;
  updatedAt: Date;
}

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

const columns: DataTableColumn<ProjectRow>[] = [
  {
    id: 'name',
    header: 'Project',
    isRowHeader: true,
    sortValue: (row) => row.name,
    cell: (row) => (
      <span className="flex flex-col">
        <span className="font-medium">{row.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{row.slug}</span>
      </span>
    ),
  },
  {
    id: 'environments',
    header: 'Environments',
    hideBelow: 'md',
    cell: (row) => (
      <span className="flex flex-wrap gap-1">
        {row.environments.map((environment) => (
          <EnvironmentBadge
            key={environment.id}
            kind={environment.kind}
            name={environment.name}
            isProtected={environment.isProtected}
          />
        ))}
      </span>
    ),
  },
  {
    id: 'secrets',
    header: 'Secrets',
    align: 'end',
    sortValue: (row) => row.secretCount,
    cell: (row) => row.secretCount,
  },
  {
    id: 'updated',
    header: 'Updated',
    hideBelow: 'sm',
    sortValue: (row) => row.updatedAt,
    cell: (row) => dateFormat.format(row.updatedAt),
  },
];

const kindOptions = ENVIRONMENT_KINDS.map((kind) => ({
  value: kind,
  label: ENVIRONMENT_KIND_LABELS[kind],
}));

export function ProjectsView() {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<EnvironmentKind[]>([]);
  // Controls are disabled until projects can be loaded; their state wiring is final.
  const unavailable = true;

  return (
    <DataTable
      caption="Projects"
      columns={columns}
      data={[]}
      getRowId={(row) => row.id}
      toolbar={
        <>
          <SearchInput
            label="Search projects"
            placeholder="Search projects…"
            value={query}
            onValueChange={setQuery}
            disabled={unavailable}
            className="sm:max-w-xs"
          />
          <FilterDropdown
            label="Environment"
            options={kindOptions}
            selected={kinds}
            onSelectedChange={setKinds}
            disabled={unavailable}
          />
        </>
      }
      emptyState={
        <EmptyState
          variant="placeholder"
          icon={FolderGit2}
          title="No projects to show"
          description="Projects belong to a workspace. Once workspaces exist you will create projects here and define custom environments for each."
        />
      }
    />
  );
}
