import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { readPendingVerificationEmail } from '@/features/auth/actions';
import { ResendVerificationForm, VerifyEmailForm } from '@/features/auth/auth-forms';
import { AuthPageHeader } from '@/features/auth/page-shell';

export const metadata: Metadata = { title: 'Verify email' };
export const dynamic = 'force-dynamic';

/** Shows only enough of the address to recognise it, e.g. a••••@example.com. */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}••••@${domain}`;
}

export default async function VerifyEmailPage() {
  const user = await getSessionUser();
  if (user?.emailVerified) redirect('/dashboard');
  const email = (await readPendingVerificationEmail()) ?? user?.email ?? null;

  if (!email) {
    return (
      <>
        <AuthPageHeader
          title="Verify your email"
          description="Sign in to receive a new verification code."
        />
        <Link href="/login" className="focus-ring rounded-sm text-sm text-brand hover:underline">
          Go to sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <AuthPageHeader
        title="Verify your email"
        description={`Enter the code we sent to ${maskEmail(email)}. Codes expire after 15 minutes.`}
      />
      <VerifyEmailForm />
      <div className="mt-4">
        <ResendVerificationForm />
      </div>
    </>
  );
}
