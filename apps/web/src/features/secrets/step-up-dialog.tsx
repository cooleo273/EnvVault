'use client';

import { useState } from 'react';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { confirmPasswordAction } from './actions';

/**
 * Password confirmation (step up) before revealing values of a protected
 * environment. The API enforces the step up; this dialog only collects the
 * password and forgets it as soon as the request finishes.
 */
export function StepUpDialog({
  open,
  onOpenChange,
  onConfirmed,
  description = 'This environment is protected. Confirm your password to reveal its values for the next few minutes.',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => void;
  description?: string;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  function close(next: boolean) {
    if (pending) return;
    if (!next) {
      setPassword('');
      setError(undefined);
    }
    onOpenChange(next);
  }

  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const result = await confirmPasswordAction(password);
      setPassword('');
      if (result.ok) {
        setError(undefined);
        onOpenChange(false);
        onConfirmed();
      } else {
        setError(result.fieldErrors?.password ?? result.message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={close}
      title="Confirm your password"
      description={description}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <FormField label="Password" error={error} required>
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          )}
        </FormField>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              close(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending || password === ''} aria-busy={pending}>
            {pending ? 'Checking…' : 'Confirm'}
          </Button>
        </div>
      </form>
    </ResponsiveModal>
  );
}
