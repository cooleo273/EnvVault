import { KeyRound } from 'lucide-react';
import Link from 'next/link';

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-surface-muted px-4 py-12 sm:py-20">
      <Link
        href="/"
        className="focus-ring mb-8 flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight"
      >
        <span className="grid size-7 place-items-center rounded-md bg-brand text-brand-foreground">
          <KeyRound aria-hidden="true" className="size-4" />
        </span>
        EnvVault
      </Link>
      <main
        id="main-content"
        className="w-full max-w-sm rounded-xl border bg-surface p-6 shadow-sm sm:p-8"
      >
        {children}
      </main>
      <p className="mt-6 max-w-sm text-center text-xs text-muted-foreground">
        Accounts are secured by Neon Auth. EnvVault never stores your password.
      </p>
    </div>
  );
}
