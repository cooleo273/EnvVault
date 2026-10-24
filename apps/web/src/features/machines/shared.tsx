'use client';

import type {
  IssuedServiceCredential,
  MachineGrant,
  MachineIdentityStatus,
  ServiceCredential,
} from '@envvault/shared';
import { AlertTriangle } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { CopyField } from '@/components/forms/copy-field';
import { Button } from '@/components/ui/button';
import type { StatusTone } from '@/design/tokens';
import { StepUpDialog } from '@/features/secrets/step-up-dialog';
import type { SecretActionResult } from '@/features/secrets/action-helpers';
import { when } from './format';

export { when };

const IDENTITY_TONES: Record<MachineIdentityStatus, StatusTone> = {
  ACTIVE: 'success',
  DISABLED: 'warning',
  EXPIRED: 'danger',
  RETIRED: 'neutral',
};

export function IdentityStatus({ status }: { status: MachineIdentityStatus }) {
  return <StatusBadge tone={IDENTITY_TONES[status]} label={status.toLowerCase()} />;
}

const CREDENTIAL_TONES: Record<ServiceCredential['status'], StatusTone> = {
  ACTIVE: 'success',
  EXPIRING: 'warning',
  EXPIRED: 'neutral',
  REVOKED: 'danger',
};

export function CredentialStatus({ status }: { status: ServiceCredential['status'] }) {
  return (
    <StatusBadge
      tone={CREDENTIAL_TONES[status]}
      label={status === 'EXPIRING' ? 'replaced, expiring' : status.toLowerCase()}
    />
  );
}

export const SCOPE_LABELS: Record<string, string> = {
  'environment:read': 'Read environment metadata',
  'secret:list': 'List variable names',
  'secret:runtime': 'Load values at runtime',
};

/** What a grant set allows per environment: ALLOW permissions minus DENY ones. */
export function effectiveAccess(grants: MachineGrant[]) {
  const now = Date.now();
  const byEnvironment = new Map<
    string,
    { environment: MachineGrant['environment']; allow: Set<string>; deny: Set<string> }
  >();
  for (const grant of grants) {
    if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now) continue;
    const entry = byEnvironment.get(grant.environment.id) ?? {
      environment: grant.environment,
      allow: new Set<string>(),
      deny: new Set<string>(),
    };
    for (const p of grant.role.permissions)
      (grant.effect === 'ALLOW' ? entry.allow : entry.deny).add(p);
    byEnvironment.set(grant.environment.id, entry);
  }
  return [...byEnvironment.values()].map(({ environment, allow, deny }) => ({
    environment,
    permissions: [...allow].filter((p) => !deny.has(p)).sort(),
  }));
}

/**
 * Runs an action that may need a fresh password confirmation: on
 * STEP_UP_REQUIRED it asks for the password, then runs the action again.
 */
export function useStepUp() {
  const [open, setOpen] = useState(false);
  const retry = useRef<(() => void) | null>(null);

  /**
   * True when the action succeeded now (not after a later password
   * confirmation). After the confirmation, `afterStepUp` runs instead of
   * the action alone, so a multi step flow can resume where it stopped.
   */
  async function run<T>(
    action: () => Promise<SecretActionResult<T>>,
    onSuccess: (data: T, message?: string) => void,
    afterStepUp?: () => void,
  ): Promise<boolean> {
    const result = await action();
    if (result.ok) {
      onSuccess(result.data, result.message);
      return true;
    }
    if (result.code === 'STEP_UP_REQUIRED') {
      retry.current =
        afterStepUp ??
        (() => {
          void run(action, onSuccess);
        });
      setOpen(true);
      return false;
    }
    notify.error(result.message);
    return false;
  }

  const dialog = (
    <StepUpDialog
      open={open}
      onOpenChange={setOpen}
      onConfirmed={() => {
        const next = retry.current;
        retry.current = null;
        next?.();
      }}
      description="Confirm your password to change what a machine identity can access."
    />
  );
  return { run, dialog };
}

/**
 * The only time a credential is visible. Closing requires confirming it
 * was stored, so nobody loses it by accident and nobody expects to see it again.
 */
export function CredentialReveal({
  issued,
  onDone,
}: {
  issued: IssuedServiceCredential;
  onDone: () => void;
}) {
  const [stored, setStored] = useState(false);
  const checkbox = useId();
  return (
    <div className="flex flex-col gap-4" data-testid="credential-reveal">
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle p-3 text-sm"
      >
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        <p>
          Copy this credential now and store it in your CI system&apos;s secret store. EnvVault
          keeps only a digest: it cannot show it again. Never commit it, paste it in chat or print
          it in build logs.
        </p>
      </div>
      <CopyField label="Service credential" value={issued.token} />
      <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Name</dt>
        <dd>{issued.credential.name}</dd>
        <dt className="text-muted-foreground">Scopes</dt>
        <dd>{issued.credential.scopes.map((s) => SCOPE_LABELS[s] ?? s).join(', ')}</dd>
        <dt className="text-muted-foreground">Expires</dt>
        <dd>{when(issued.credential.expiresAt)}</dd>
        {issued.previousExpiresAt ? (
          <>
            <dt className="text-muted-foreground">Old credential</dt>
            <dd>stops working {when(issued.previousExpiresAt)}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-xs text-muted-foreground">
        In CI, expose it as <code className="font-mono">ENVVAULT_SERVICE_CREDENTIAL</code> and run{' '}
        <code className="font-mono">envvault run --env &lt;name&gt; -- &lt;command&gt;</code>.
      </p>
      <label htmlFor={checkbox} className="flex items-center gap-2 text-sm">
        <input
          id={checkbox}
          type="checkbox"
          className="size-4"
          checked={stored}
          onChange={(e) => {
            setStored(e.target.checked);
          }}
        />
        I stored the credential somewhere safe
      </label>
      <div className="flex justify-end">
        <Button disabled={!stored} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
