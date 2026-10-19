'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { copyToClipboard } from './clipboard';

export interface CopyFieldProps {
  label: string;
  /** Non-secret value (ids, URLs, public keys). Use SecretMaskedField for secrets. */
  value: string;
  description?: string;
  className?: string;
}

const COPIED_RESET_MS = 2000;

export function CopyField({ label, value, description, className }: CopyFieldProps) {
  const id = useId();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, COPIED_RESET_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  async function handleCopy() {
    if (await copyToClipboard(value)) {
      setCopied(true);
      notify.success(`${label} copied`);
    } else {
      notify.error('Copy failed', { description: 'Select the text and copy it manually.' });
    }
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className="focus-ring h-control min-w-0 flex-1 rounded-md border border-input bg-surface-muted px-3 font-mono text-xs"
          {...(description ? { 'aria-describedby': `${id}-description` } : {})}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          onClick={() => {
            void handleCopy();
          }}
        >
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        </Button>
      </div>
      {description ? (
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}
