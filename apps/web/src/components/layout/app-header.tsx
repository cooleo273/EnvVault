'use client';

import { MenuIcon, XIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useState, useTransition } from 'react';
import { workspaceIdFromPath } from '@/lib/workspaces/landing';
import { ThemeSwitcher } from '@/components/theme/theme';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/primitives';
import { AppSidebar } from './app-sidebar';
import { GlobalSearch, NotificationsMenu, UserMenu, type UserMenuProps } from './header-menus';
import { type WorkspaceOption, WorkspaceSwitcher } from './workspace-switcher';

/** Drawer with the main navigation for screens narrower than `lg`. */
function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [openedAt, setOpenedAt] = useState(pathname);

  // Close the drawer after client-side navigation.
  if (open && pathname !== openedAt) {
    setOpen(false);
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setOpenedAt(pathname);
      }}
    >
      <DialogPrimitive.Trigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
          <MenuIcon aria-hidden="true" />
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay lg:hidden" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 w-sidebar max-w-[85vw] border-r shadow-overlay focus:outline-none lg:hidden"
        >
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          <AppSidebar
            onNavigate={() => {
              setOpen(false);
            }}
          />
          <DialogPrimitive.Close className="focus-ring absolute top-3 right-3 grid size-control-sm place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <XIcon aria-hidden="true" className="size-4" />
            <span className="sr-only">Close navigation</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface AppHeaderProps extends UserMenuProps {
  /** Undefined when the list could not be loaded. */
  workspaces?: readonly WorkspaceOption[] | undefined;
  /** The remembered workspace (already authorized by the API). */
  activeWorkspaceId?: string | undefined;
  pendingInvitationCount?: number;
  /** Server action: remembers the selection and opens the workspace. */
  selectWorkspaceAction?: (workspaceId: string) => Promise<void>;
}

export function AppHeader({
  user,
  workspaces,
  activeWorkspaceId,
  pendingInvitationCount = 0,
  signOutAction,
  selectWorkspaceAction,
}: AppHeaderProps) {
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  // The workspace in the URL wins; otherwise the remembered one.
  const currentWorkspaceId = workspaceIdFromPath(pathname) ?? activeWorkspaceId;
  return (
    <header className="sticky top-0 z-40 flex h-header shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
      <MobileNav />
      <WorkspaceSwitcher
        workspaces={workspaces ?? []}
        unavailable={workspaces === undefined}
        {...(currentWorkspaceId ? { currentWorkspaceId } : {})}
        onSelect={(id) => {
          if (!selectWorkspaceAction) return;
          startTransition(async () => {
            await selectWorkspaceAction(id);
          });
        }}
      />
      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <GlobalSearch />
        <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />
        <ThemeSwitcher />
        <NotificationsMenu pendingInvitationCount={pendingInvitationCount} />
        <UserMenu user={user} signOutAction={signOutAction} />
      </div>
    </header>
  );
}
