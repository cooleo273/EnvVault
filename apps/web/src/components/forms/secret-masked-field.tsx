'use client';

import { CopyIcon, EyeIcon, EyeOffIcon, LoaderIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { copyToClipboard } from './clipboard';

/** Fixed-length mask so the value's length is not disclosed. */
export const SECRET_MASK = '••••••••••••';

export interface SecretMaskedFieldProps {
  /** Usually the secret key name, e.g. `DATABASE_URL`. */
  label: string;
  /**
   * Fetches the plaintext on demand (reveal or copy). The value is never
   * requested until the user asks for it, and each request can be authorized
   * and audited server-side.
   */
  loadValue: () => Promise<string>;
  /** Re-mask automatically after this many ms (0 disables). Default 30 s. */
  autoHideMs?: number;
  /** Disable reveal/copy (e.g. the user lacks `secret:read`). */
  disabled?: boolean;
  className?: string;
}

type LoadState = 'idle' | 'loading' | 'error';

export function SecretMaskedField({
  label,
  loadValue,
  autoHideMs = 30_000,
  disabled = false,
  className,
}: SecretMaskedFieldProps) {
  const labelId = useId();
  // The plaintext only lives in state while revealed.
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const revealed = revealedValue !== null;

  useEffect(() => {
    if (!revealed || autoHideMs <= 0) return;
    const timer = setTimeout(() => {
      setRevealedValue(null);
    }, autoHideMs);
    return () => {
      clearTimeout(timer);
    };
  }, [revealed, autoHideMs]);

  async function fetchValue(): Promise<string | null> {
    setLoadState('loading');
    try {
      const value = await loadValue();
      setLoadState('idle');
      return value;
    } catch {
      setLoadState('error');
      notify.error('Could not load the secret value');
      return null;
    }
  }

  async function toggleReveal() {
    if (revealed) {
      setRevealedValue(null);
      return;
    }
    const value = await fetchValue();
    if (value !== null) setRevealedValue(value);
  }

  async function copy() {
    const value = revealedValue ?? (await fetchValue());
    if (value === null) return;
    if (await copyToClipboard(value)) {
      notify.success(`${label} copied`, { description: 'Clear your clipboard when done.' });
    } else {
      notify.error('Copy failed');
    }
  }

  const busy = loadState === 'loading';
  let revealIcon = <EyeIcon aria-hidden="true" />;
  if (busy) {
    revealIcon = (
      <LoaderIcon aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
    );
  } else if (revealed) {
    revealIcon = <EyeOffIcon aria-hidden="true" />;
  }

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={cn('flex items-center gap-2 rounded-md border bg-surface px-3 py-1.5', className)}
    >
      <span id={labelId} className="shrink-0 font-mono text-xs font-medium">
        {label}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 text-right font-mono text-xs text-muted-foreground',
          !revealed && 'truncate',
        )}
      >
        {revealed ? (
          <code
            className="break-all whitespace-pre-wrap text-foreground"
            data-testid="secret-value"
          >
            {revealedValue}
          </code>
        ) : (
          <span aria-label="Value hidden">{SECRET_MASK}</span>
        )}
      </span>
      {loadState === 'error' ? <span className="sr-only">Loading the value failed.</span> : null}
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled || busy}
          aria-pressed={revealed}
          aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
          onClick={() => {
            void toggleReveal();
          }}
        >
          {revealIcon}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled || busy}
          aria-label={`Copy ${label}`}
          onClick={() => {
            void copy();
          }}
        >
          <CopyIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
