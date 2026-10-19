'use client';

import { Building2, ChevronsUpDown, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface WorkspaceOption {
  id: string;
  name: string;
}

export interface WorkspaceSwitcherProps {
  /** Workspaces the signed-in user belongs to. */
  workspaces?: readonly WorkspaceOption[];
  currentWorkspaceId?: string;
  onSelect?: (workspaceId: string) => void;
}

export function WorkspaceSwitcher({
  workspaces = [],
  currentWorkspaceId,
  onSelect,
}: WorkspaceSwitcherProps) {
  const current = workspaces.find((workspace) => workspace.id === currentWorkspaceId);
  const label = current?.name ?? 'No workspace';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-32 justify-start px-2 text-foreground sm:max-w-56"
          aria-label={`Switch workspace (current: ${label})`}
        >
          <span className="grid size-5 shrink-0 place-items-center rounded-sm border bg-surface text-muted-foreground">
            <Building2 aria-hidden="true" className="size-3" />
          </span>
          <span className="truncate text-sm">{label}</span>
          <ChevronsUpDown aria-hidden="true" className="ml-auto size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.length === 0 ? (
          <p className="px-2 pb-2 text-xs text-muted-foreground">
            You don’t belong to any workspace yet.
          </p>
        ) : (
          workspaces.map((workspace) => (
            <DropdownMenuItem
              key={workspace.id}
              onSelect={() => onSelect?.(workspace.id)}
              aria-current={workspace.id === currentWorkspaceId ? 'true' : undefined}
            >
              {workspace.name}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/workspaces/new">
            <PlusIcon aria-hidden="true" />
            Create workspace
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
