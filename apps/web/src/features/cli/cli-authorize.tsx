'use client';

import type { CliDeviceRequest } from '@envvault/shared';
import { CheckCircle2, Terminal, XCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StepUpDialog } from '@/features/secrets/step-up-dialog';
import { approveCliLoginAction, denyCliLoginAction } from './actions';

const timeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Approves a CLI sign in. The person compares the code with their terminal;
 * approval needs a recent password confirmation, which the API enforces.
 */
export function CliAuthorize({ request }: { request: CliDeviceRequest }) {
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [stepUp, setStepUp] = useState(false);

  async function decide(approve: boolean) {
    setPending(true);
    try {
      const result = approve
        ? await approveCliLoginAction(request.userCode)
        : await denyCliLoginAction(request.userCode);
      if (!result.ok && result.code === 'STEP_UP_REQUIRED') {
        setStepUp(true);
        return;
      }
      setOutcome({
        ok: result.ok,
        message: result.ok ? (result.message ?? 'Done.') : result.message,
      });
    } finally {
      setPending(false);
    }
  }

  if (outcome) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg border bg-surface p-5">
        {outcome.ok ? (
          <CheckCircle2 aria-hidden="true" className="size-5 text-success" />
        ) : (
          <XCircle aria-hidden="true" className="size-5 text-danger" />
        )}
        <p className="text-sm">{outcome.message}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-surface p-5">
      <div className="flex items-start gap-3">
        <Terminal aria-hidden="true" className="mt-0.5 size-5 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">The EnvVault CLI asks to sign in as you.</p>
          <p className="text-sm text-muted-foreground">
            Approve only if you just ran <code className="font-mono">envvault login</code> and your
            terminal shows the same code.
          </p>
        </div>
      </div>
      <p
        className="text-center font-mono text-2xl font-semibold tracking-widest"
        data-testid="cli-user-code"
      >
        {request.userCode}
      </p>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Computer</dt>
        <dd className="break-all">{request.hostname}</dd>
        <dt className="text-muted-foreground">System</dt>
        <dd>{request.platform}</dd>
        <dt className="text-muted-foreground">CLI version</dt>
        <dd>{request.clientVersion}</dd>
        <dt className="text-muted-foreground">Requested</dt>
        <dd>{timeFormat.format(new Date(request.requestedAt))}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        The computer name and system are reported by the CLI and are not verified. The CLI gets
        access to what you can read, for up to 90 days, until you sign it out here or in Security
        settings.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={() => void decide(false)}>
          Deny
        </Button>
        <Button disabled={pending} onClick={() => void decide(true)}>
          {pending ? 'Working…' : 'Approve'}
        </Button>
      </div>
      <StepUpDialog
        open={stepUp}
        onOpenChange={setStepUp}
        onConfirmed={() => void decide(true)}
        description="Confirm your password to sign in the CLI."
      />
    </div>
  );
}

/** Asks for the code when the page was opened without one. */
export function CliCodeForm() {
  const router = useRouter();
  const [value, setValue] = useState('');
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border bg-surface p-5"
      onSubmit={(event) => {
        event.preventDefault();
        router.push(`/cli/authorize?code=${encodeURIComponent(value.trim().toUpperCase())}`);
      }}
    >
      <label htmlFor="cli-code" className="text-sm font-medium">
        Code shown in your terminal
      </label>
      <Input
        id="cli-code"
        value={value}
        autoComplete="off"
        spellCheck={false}
        placeholder="BCDF-GHJK"
        className="font-mono uppercase"
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      <div className="flex justify-end">
        <Button type="submit">Continue</Button>
      </div>
    </form>
  );
}
