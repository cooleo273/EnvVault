'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export interface WorkspaceTab {
  href: string;
  label: string;
}

/** Section navigation inside a workspace (only tabs the caller may use are passed in). */
export function WorkspaceTabs({ tabs }: { tabs: WorkspaceTab[] }) {
  const pathname = usePathname();
  const [overview] = tabs;
  return (
    <nav aria-label="Workspace sections" className="-mb-px flex gap-1 overflow-x-auto border-b">
      {tabs.map((tab) => {
        const active =
          tab === overview
            ? pathname === tab.href
            : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'focus-ring shrink-0 rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-brand font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
