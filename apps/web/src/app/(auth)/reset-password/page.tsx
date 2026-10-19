import type { Metadata } from 'next';
import Link from 'next/link';
import { ResetPasswordForm } from '@/features/auth/auth-forms';
import { AuthPageHeader } from '@/features/auth/page-shell';

// The URL carries a one-time reset token: never leak it via the Referer header.
export const metadata: Metadata = { title: 'Choose a new password', referrer: 'no-referrer' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ResetPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : undefined;

  // Neon Auth redirects here with ?token=… (or ?error=INVALID_TOKEN).
  if (!token || params.error) {
    return (
      <>
        <AuthPageHeader
          title="Link invalid or expired"
          description="Password reset links work once and expire after 15 minutes."
        />
        <Link
          href="/forgot-password"
          className="focus-ring rounded-sm text-sm text-brand hover:underline"
        >
          Request a new link
        </Link>
      </>
    );
  }

  return (
    <>
      <AuthPageHeader title="Choose a new password" />
      <ResetPasswordForm token={token} />
    </>
  );
}
