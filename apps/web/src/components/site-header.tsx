import { KeyRound } from 'lucide-react';
import Link from 'next/link';

const NAV_ITEMS = [
  { href: '#capabilities', label: 'Capabilities' },
  { href: '#security', label: 'Security' },
  { href: '#roadmap', label: 'Roadmap' },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <a
        href="#main-content"
        className="sr-only rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
      >
        Skip to main content
      </a>
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-ring"
        >
          <span className="grid size-7 place-items-center rounded-md bg-brand text-brand-foreground">
            <KeyRound aria-hidden="true" className="size-4" />
          </span>
          EnvVault
        </Link>
        <nav aria-label="Primary">
          <ul className="flex items-center gap-1 text-sm">
            {NAV_ITEMS.map((item) => (
              <li key={item.href} className="hidden sm:block">
                <a
                  href={item.href}
                  className="rounded-md px-3 py-2 text-muted-foreground transition-colors hover:text-foreground focus-ring"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
