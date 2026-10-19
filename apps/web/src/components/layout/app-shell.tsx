import type * as React from 'react';
import { AppHeader, type AppHeaderProps } from './app-header';
import { AppSidebar } from './app-sidebar';

/** Dashboard frame: fixed sidebar on large screens, drawer below `lg`. */
export function AppShell({ children, ...header }: AppHeaderProps & { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh lg:pl-sidebar">
      <a
        href="#main-content"
        className="focus-ring sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>
      <aside className="fixed inset-y-0 left-0 hidden w-sidebar border-r lg:block">
        <AppSidebar />
      </aside>
      <div className="flex min-h-dvh flex-col">
        <AppHeader {...header} />
        <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
          <div className="mx-auto flex w-full max-w-content flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
