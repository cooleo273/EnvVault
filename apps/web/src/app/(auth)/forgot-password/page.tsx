import type { Metadata } from 'next';
import Link from 'next/link';
import { ForgotPasswordForm } from '@/features/auth/auth-forms';
import { AuthPageHeader } from '@/features/auth/page-shell';

export const metadata: Metadata = { title: 'Reset password' };

export default function ForgotPasswordPage() {
  return (
    <>
      <AuthPageHeader
        title="Reset your password"
        description="Enter your account email and we will send you a reset link."
      />
      <ForgotPasswordForm />
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="focus-ring rounded-sm text-brand hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
