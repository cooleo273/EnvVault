import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { safeRedirectPath } from '@/lib/auth/redirect';
import { getSessionUser } from '@/lib/auth/session';
import { SignUpForm } from '@/features/auth/auth-forms';
import { AuthPageHeader } from '@/features/auth/page-shell';

export const metadata: Metadata = { title: 'Create account' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SignUpPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const redirectTo = typeof params.redirectTo === 'string' ? params.redirectTo : undefined;
  const user = await getSessionUser();
  if (user?.emailVerified) redirect(safeRedirectPath(redirectTo));
  return (
    <>
      <AuthPageHeader
        title="Create your account"
        description="We will email you a code to verify your address."
      />
      <SignUpForm redirectTo={redirectTo} />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          href={redirectTo ? `/login?redirectTo=${encodeURIComponent(redirectTo)}` : '/login'}
          className="focus-ring rounded-sm text-brand hover:underline"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
