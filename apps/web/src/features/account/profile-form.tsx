'use client';

import { useActionState, useState } from 'react';
import { FormField } from '@/components/forms/form-field';
import { SettingsSection } from '@/components/layout/settings-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type FormState, INITIAL_FORM_STATE } from '@/lib/form-state';
import { changePasswordAction, updateProfileAction } from './actions';

function fieldError(state: FormState, name: string): { error?: string } {
  const error = state.fieldErrors?.[name];
  return error ? { error } : {};
}

function FormMessage({ state }: { state: FormState }) {
  if (!state.message) return null;
  return (
    <p
      role={state.status === 'error' ? 'alert' : 'status'}
      className={
        state.status === 'error'
          ? 'rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger'
          : 'rounded-md border border-success-border bg-success-subtle px-3 py-2 text-sm text-success'
      }
    >
      {state.message}
    </p>
  );
}

export function ProfileForm({ name, email }: { name: string | null; email: string }) {
  const [state, action, pending] = useActionState(updateProfileAction, INITIAL_FORM_STATE);
  const [value, setValue] = useState(name ?? '');
  return (
    <form action={action} noValidate>
      <SettingsSection
        id="profile"
        title="Profile"
        description="Your name is shown to members of your workspaces."
        footer={
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? 'Saving…' : 'Save profile'}
          </Button>
        }
      >
        <div className="flex max-w-xl flex-col gap-4">
          <FormMessage state={state} />
          <FormField label="Name" required {...fieldError(state, 'name')}>
            {(control) => (
              <Input
                {...control}
                name="name"
                value={value}
                autoComplete="name"
                maxLength={100}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            label="Email"
            description="Your sign-in address. Changing it is not supported yet."
          >
            {(control) => <Input {...control} value={email} readOnly type="email" />}
          </FormField>
        </div>
      </SettingsSection>
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, INITIAL_FORM_STATE);
  return (
    // Keyed by status so the password fields are cleared after success.
    <form action={action} noValidate key={state.status === 'success' ? state.message : 'form'}>
      <SettingsSection
        id="password"
        title="Password"
        description="Changing your password signs out your other devices and revokes their API access."
        footer={
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? 'Changing…' : 'Change password'}
          </Button>
        }
      >
        <div className="flex max-w-xl flex-col gap-4">
          <FormMessage state={state} />
          <FormField label="Current password" required {...fieldError(state, 'currentPassword')}>
            {(control) => (
              <Input
                {...control}
                name="currentPassword"
                type="password"
                autoComplete="current-password"
              />
            )}
          </FormField>
          <FormField
            label="New password"
            description="At least 8 characters."
            required
            {...fieldError(state, 'newPassword')}
          >
            {(control) => (
              <Input {...control} name="newPassword" type="password" autoComplete="new-password" />
            )}
          </FormField>
          <FormField
            label="Confirm new password"
            required
            {...fieldError(state, 'confirmPassword')}
          >
            {(control) => (
              <Input
                {...control}
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
              />
            )}
          </FormField>
        </div>
      </SettingsSection>
    </form>
  );
}
