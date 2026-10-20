'use client';

import { useId } from 'react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

export interface SwitchFieldProps {
  /** Form field name; the value is submitted through a hidden input (`on` or empty). */
  name?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * Accessible switch (`role="switch"`) whose value is submitted from React
 * state. React resets uncontrolled DOM fields after every form action; a
 * native checkbox would then submit its reset state, not what the user sees.
 */
export function SwitchField({
  name,
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className,
}: SwitchFieldProps) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-3', className)}>
      {name ? <input type="hidden" name={name} value={checked ? 'on' : ''} /> : null}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-description` : undefined}
        disabled={disabled}
        onClick={() => {
          onCheckedChange(!checked);
        }}
        className={cn(
          'focus-ring relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-brand bg-brand' : 'border-input bg-muted',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-3.5 rounded-full bg-white shadow-xs transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
      <span className="flex flex-col gap-0.5 text-sm">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        {description ? (
          <span id={`${id}-description`} className="text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}
