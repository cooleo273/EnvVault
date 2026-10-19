'use client';

import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isActivePath, type NavItem, PRIMARY_NAV, SECONDARY_NAV } from '@/config/navigation';
import { cn } from '@/lib/utils';

function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = isActivePath(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      {...(onNavigate ? { onClick: onNavigate } : {})}
      className={cn(
        'focus-ring flex h-control-sm items-center gap-2.5 rounded-md px-2 text-sm transition-colors',
        active
          ? 'bg-accent font-medium text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
      {item.status === 'preview' ? (
        <span className="ml-auto text-2xs text-muted-foreground" title="Not connected yet">
          Preview
        </span>
      ) : null}
    </Link>
  );
}

export interface AppSidebarProps {
  /** Called after navigating (closes the mobile drawer). */
  onNavigate?: () => void;
  className?: string;
}

/** Primary navigation. Rendered fixed on large screens and inside the mobile drawer. */
export function AppSidebar({ onNavigate, className }: AppSidebarProps) {
  const pathname = usePathname();
  return (
    <div className={cn('flex h-full flex-col bg-surface-muted', className)}>
      <div className="flex h-header shrink-0 items-center border-b px-4">
        <Link
          href="/dashboard"
          {...(onNavigate ? { onClick: onNavigate } : {})}
          className="focus-ring flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight"
        >
          <span className="grid size-6 place-items-center rounded-md bg-brand text-brand-foreground">
            <KeyRound aria-hidden="true" className="size-3.5" />
          </span>
          EnvVault
        </Link>
      </div>
      <nav aria-label="Main" className="flex flex-1 flex-col gap-6 overflow-y-auto p-3">
        <ul className="flex flex-col gap-0.5">
          {PRIMARY_NAV.map((item) => (
            <li key={item.href}>
              <NavLink item={item} pathname={pathname} {...(onNavigate ? { onNavigate } : {})} />
            </li>
          ))}
        </ul>
        <ul className="mt-auto flex flex-col gap-0.5">
          {SECONDARY_NAV.map((item) => (
            <li key={item.href}>
              <NavLink item={item} pathname={pathname} {...(onNavigate ? { onNavigate } : {})} />
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
