'use client';

import { Bell, LogOut, Mail, SearchIcon, Settings, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { SearchInput } from '@/components/data/search-input';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { EmptyState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/primitives';

/** Global search entry point. Opens with Ctrl/⌘ + K. Not connected yet. */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
      title="Search"
      description="Find workspaces, projects, environments and secrets by name."
      trigger={
        <Button
          variant="outline"
          size="sm"
          aria-keyshortcuts="Control+K Meta+K"
          className="w-9 justify-start px-0 text-muted-foreground sm:w-64 sm:px-2.5"
        >
          <SearchIcon aria-hidden="true" className="mx-auto sm:mx-0" />
          <span className="hidden sm:inline">Search…</span>
          <span className="sr-only sm:hidden">Search</span>
          <Kbd className="ml-auto hidden sm:inline-flex">Ctrl K</Kbd>
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <SearchInput label="Search EnvVault" value={query} onValueChange={setQuery} autoFocus />
        <EmptyState
          variant="placeholder"
          title="Search is not connected yet"
          description="Results will appear here once workspaces and projects exist."
          className="py-8"
        />
      </div>
    </ResponsiveModal>
  );
}

export function NotificationsMenu({
  pendingInvitationCount = 0,
}: {
  pendingInvitationCount?: number;
}) {
  const label =
    pendingInvitationCount > 0
      ? `Notifications (${String(pendingInvitationCount)} pending invitation${pendingInvitationCount === 1 ? '' : 's'})`
      : 'Notifications';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className="relative">
          <Bell aria-hidden="true" />
          {pendingInvitationCount > 0 ? (
            <span
              aria-hidden="true"
              className="absolute top-1.5 right-1.5 size-2 rounded-full bg-brand ring-2 ring-background"
            />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        {pendingInvitationCount > 0 ? (
          <DropdownMenuItem asChild>
            <Link href="/workspaces#invitations">
              <Mail aria-hidden="true" />
              {pendingInvitationCount === 1
                ? 'You have a pending workspace invitation'
                : `You have ${String(pendingInvitationCount)} pending workspace invitations`}
            </Link>
          </DropdownMenuItem>
        ) : (
          <p className="px-2 pb-2 text-xs text-muted-foreground">
            No pending invitations. Approvals and rotation reminders are not connected yet.
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/notifications">Open notifications</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface UserMenuProps {
  user: { name: string | null; email: string };
  /** Server action that revokes API tokens and ends the Neon Auth session. */
  signOutAction: () => Promise<void>;
}

export function UserMenu({ user, signOutAction }: UserMenuProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const displayName = user.name ?? user.email;
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';
  return (
    <>
      <form ref={formRef} action={signOutAction} className="hidden" aria-hidden="true" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Account menu for ${displayName}`}>
            <span className="grid size-7 place-items-center rounded-full border bg-surface-muted text-xs font-medium text-foreground">
              {initial}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            {user.name ? (
              <span className="truncate text-sm text-foreground">{user.name}</span>
            ) : null}
            <span className="truncate font-normal">{user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/settings/profile">
              <Settings aria-hidden="true" />
              Profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/settings/security">
              <ShieldCheck aria-hidden="true" />
              Security
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              formRef.current?.requestSubmit();
            }}
          >
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
