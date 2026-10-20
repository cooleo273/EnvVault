'use client';

import { CopyIcon, EyeIcon, EyeOffIcon, LoaderIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { notify } from '@/components/feedback/toast';
import { copyToClipboard } from '@/components/forms/clipboard';
import { SECRET_MASK } from '@/components/forms/secret-masked-field';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { revealSecretAction } from './actions';
import { StepUpDialog } from './step-up-dialog';

/** How long a revealed value stays visible. */
export const REVEAL_DURATION_MS = 30_000;

export interface SecretValueCellProps {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  secretId: string;
  secretKey: string;
  hasValue: boolean;
  /** The caller holds `secret:read` here. The API decides; this only hides the control. */
  canReveal: boolean;
  multiline: boolean;
}

/**
 * Masked value with reveal, auto hide and copy. The plaintext lives only in
 * this component's state while shown: it is cleared when the user hides it,
 * after {@link REVEAL_DURATION_MS}, when the tab is hidden, and when the row
 * unmounts (another page, filter or environment). It is never written to
 * storage, the URL or a cache. Copy is offered only for a revealed value.
 */
export function SecretValueCell({
  workspaceId,
  projectId,
  environmentId,
  secretId,
  secretKey,
  hasValue,
  canReveal,
  multiline,
}: SecretValueCellProps) {
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const revealed = value !== null;

  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => {
      setValue(null);
    }, REVEAL_DURATION_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') setValue(null);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [revealed]);

  async function reveal() {
    setLoading(true);
    try {
      const result = await revealSecretAction(workspaceId, projectId, environmentId, secretId);
      if (result.ok) {
        setValue(result.data.value);
      } else if (result.code === 'STEP_UP_REQUIRED') {
        setStepUpOpen(true);
      } else {
        notify.error(result.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (value === null) return;
    if (await copyToClipboard(value)) {
      notify.success(`${secretKey} copied`, {
        description:
          'The clipboard is outside EnvVault: other apps and clipboard history may keep it. Clear it when you are done.',
      });
    } else {
      notify.error('Copy failed');
    }
  }

  if (!hasValue) {
    return <span className="text-xs text-muted-foreground italic">Not set</span>;
  }

  let icon = <EyeIcon aria-hidden="true" />;
  if (loading)
    icon = <LoaderIcon aria-hidden="true" className="animate-spin motion-reduce:animate-none" />;
  else if (revealed) icon = <EyeOffIcon aria-hidden="true" />;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 flex-1 font-mono text-xs">
        {revealed ? (
          <code
            data-testid="secret-value"
            className={cn(
              'block max-h-40 overflow-auto rounded-sm bg-surface-muted px-1.5 py-0.5 break-all text-foreground',
              multiline ? 'whitespace-pre-wrap' : 'whitespace-pre',
            )}
          >
            {value === '' ? <span className="text-muted-foreground italic">(empty)</span> : value}
          </code>
        ) : (
          <span aria-label="Value hidden" className="text-muted-foreground">
            {SECRET_MASK}
          </span>
        )}
      </span>
      {canReveal ? (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={loading}
            aria-pressed={revealed}
            aria-label={revealed ? `Hide ${secretKey}` : `Reveal ${secretKey}`}
            onClick={() => {
              if (revealed) setValue(null);
              else void reveal();
            }}
          >
            {icon}
          </Button>
          {revealed ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Copy ${secretKey}`}
              onClick={() => {
                void copy();
              }}
            >
              <CopyIcon aria-hidden="true" />
            </Button>
          ) : null}
        </>
      ) : null}
      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onConfirmed={() => {
          void reveal();
        }}
      />
    </div>
  );
}
