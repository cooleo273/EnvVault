import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { safeRedirectPath } from '@/lib/auth/redirect';
import { getSessionUser } from '@/lib/auth/session';
import { SignInForm } from '@/features/auth/auth-forms';
import { AuthPageHeader, Notice } from '@/features/auth/page-shell';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const redirectTo = single(params.redirectTo);
  const user = await getSessionUser();
  if (user?.emailVerified) redirect(safeRedirectPath(redirectTo));

  let notice: string | null = null;
  if (params.verified) notice = 'Email verified. Sign in to continue.';
  else if (params.reset) notice = 'Password updated. Sign in with your new password.';
  else if (params.signedOut) notice = 'You have been signed out.';

  return (
    <>
      <AuthPageHeader title="Sign in to EnvVault" />
      {notice ? <Notice>{notice}</Notice> : null}
      <SignInForm redirectTo={redirectTo} />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New to EnvVault?{' '}
        <Link
          href={redirectTo ? `/signup?redirectTo=${encodeURIComponent(redirectTo)}` : '/signup'}
          className="focus-ring rounded-sm text-brand hover:underline"
        >
          Create an account
        </Link>
      </p>
    </>
  );
}
