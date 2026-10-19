'use client';

import type { WorkspaceSummary } from '@envvault/shared';
import { Building2 } from 'lucide-react';
import Link from 'next/link';
import { DataTable, type DataTableColumn } from '@/components/data/data-table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

const columns: DataTableColumn<WorkspaceSummary>[] = [
  {
    id: 'name',
    header: 'Workspace',
    isRowHeader: true,
    sortValue: (row) => row.name,
    cell: (row) => (
      <Link
        href={`/workspaces/${row.id}`}
        className="focus-ring flex flex-col rounded-sm hover:underline"
      >
        <span className="flex items-center gap-2 font-medium">
          {row.name}
          {row.archivedAt ? <StatusBadge tone="warning" label="Archived" dot={false} /> : null}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{row.slug}</span>
      </Link>
    ),
  },
  {
    id: 'type',
    header: 'Type',
    hideBelow: 'sm',
    sortValue: (row) => row.type,
    cell: (row) => (row.type === 'PERSONAL' ? 'Personal' : 'Team'),
  },
  {
    id: 'role',
    header: 'Your role',
    sortValue: (row) => row.role.name,
    cell: (row) => row.role.name,
  },
  {
    id: 'created',
    header: 'Created',
    hideBelow: 'md',
    sortValue: (row) => new Date(row.createdAt),
    cell: (row) => dateFormat.format(new Date(row.createdAt)),
  },
];

export function WorkspacesView({
  workspaces,
  caption = 'Workspaces',
  emptyTitle = 'No workspaces yet',
  emptyDescription = 'Create a workspace to start organising projects and environments.',
}: {
  workspaces: WorkspaceSummary[] | null;
  caption?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  return (
    <DataTable
      caption={caption}
      columns={columns}
      data={workspaces ?? []}
      getRowId={(row) => row.id}
      status={workspaces === null ? 'error' : 'ready'}
      errorState={
        <ErrorState
          title="Workspaces could not be loaded"
          description="The EnvVault API is unavailable. Try again in a moment."
        />
      }
      emptyState={<EmptyState icon={Building2} title={emptyTitle} description={emptyDescription} />}
    />
  );
}
