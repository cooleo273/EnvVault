'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type * as React from 'react';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  requestPasswordResetAction,
  resendVerificationAction,
  resetPasswordAction,
  signInAction,
  signUpAction,
  verifyEmailAction,
} from './actions';
import { type FormState, INITIAL_FORM_STATE } from '@/lib/form-state';

function FormMessage({ state }: { state: FormState }) {
  if (!state.message) return null;
  return (
    <p
      role={state.status === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        state.status === 'error'
          ? 'border-danger-border bg-danger-subtle text-danger'
          : 'border-success-border bg-success-subtle text-success',
      )}
    >
      {state.message}
    </p>
  );
}

function SubmitButton({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
      {pending ? 'Please wait…' : children}
    </Button>
  );
}

type EchoState = FormState & { values?: Record<string, string> };

/**
 * React resets uncontrolled fields after every action. This keeps the listed
 * non-secret fields (never passwords or codes) so a failed attempt does not
 * wipe what the user typed. Values stay in the browser; nothing is echoed by
 * the server.
 */
function useEchoActionState(
  action: (prev: FormState, formData: FormData) => Promise<FormState>,
  fields: readonly string[],
) {
  return useActionState<EchoState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = formData.get(field);
      if (typeof value === 'string') values[field] = value;
    }
    return { ...result, values };
  }, INITIAL_FORM_STATE);
}

function fieldError(state: FormState, name: string): { error?: string } {
  const error = state.fieldErrors?.[name];
  return error ? { error } : {};
}

export function SignInForm({ redirectTo }: { redirectTo: string | undefined }) {
  const [state, action, pending] = useEchoActionState(signInAction, ['email']);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormMessage state={state} />
      {redirectTo ? <input type="hidden" name="redirectTo" value={redirectTo} /> : null}
      <FormField label="Email" {...fieldError(state, 'email')}>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={state.values?.email}
            required
            autoFocus
          />
        )}
      </FormField>
      <FormField label="Password" {...fieldError(state, 'password')}>
        {(control) => (
          <Input
            {...control}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        )}
      </FormField>
      <div className="-mt-1 text-right">
        <Link
          href="/forgot-password"
          className="focus-ring rounded-sm text-xs text-brand hover:underline"
        >
          Forgot password?
        </Link>
      </div>
      <SubmitButton pending={pending}>Sign in</SubmitButton>
    </form>
  );
}

export function SignUpForm({ redirectTo }: { redirectTo?: string | undefined } = {}) {
  const [state, action, pending] = useEchoActionState(signUpAction, ['name', 'email']);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormMessage state={state} />
      {redirectTo ? <input type="hidden" name="redirectTo" value={redirectTo} /> : null}
      <FormField label="Name" {...fieldError(state, 'name')}>
        {(control) => (
          <Input
            {...control}
            name="name"
            autoComplete="name"
            defaultValue={state.values?.name}
            required
            autoFocus
          />
        )}
      </FormField>
      <FormField label="Email" {...fieldError(state, 'email')}>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={state.values?.email}
            required
          />
        )}
      </FormField>
      <FormField
        label="Password"
        description="At least 8 characters."
        {...fieldError(state, 'password')}
      >
        {(control) => (
          <Input
            {...control}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        )}
      </FormField>
      <SubmitButton pending={pending}>Create account</SubmitButton>
    </form>
  );
}

export function VerifyEmailForm() {
  const [state, action, pending] = useActionState(verifyEmailAction, INITIAL_FORM_STATE);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormMessage state={state} />
      <FormField label="Verification code" {...fieldError(state, 'otp')}>
        {(control) => (
          <Input
            {...control}
            name="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={10}
            className="font-mono tracking-widest"
            required
            autoFocus
          />
        )}
      </FormField>
      <SubmitButton pending={pending}>Verify email</SubmitButton>
    </form>
  );
}

export function ResendVerificationForm() {
  const [state, action, pending] = useActionState(resendVerificationAction, INITIAL_FORM_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <FormMessage state={state} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? 'Sending…' : 'Send a new code'}
      </Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useEchoActionState(requestPasswordResetAction, ['email']);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormMessage state={state} />
      <FormField label="Email" {...fieldError(state, 'email')}>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={state.values?.email}
            required
            autoFocus
          />
        )}
      </FormField>
      <SubmitButton pending={pending}>Send reset link</SubmitButton>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, INITIAL_FORM_STATE);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <FormField
        label="New password"
        description="At least 8 characters."
        {...fieldError(state, 'password')}
      >
        {(control) => (
          <Input
            {...control}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            autoFocus
          />
        )}
      </FormField>
      <FormField label="Confirm new password" {...fieldError(state, 'confirmPassword')}>
        {(control) => (
          <Input
            {...control}
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
          />
        )}
      </FormField>
      <SubmitButton pending={pending}>Set new password</SubmitButton>
    </form>
  );
}
