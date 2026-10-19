'use client';

import { SearchIcon, XIcon } from 'lucide-react';
import { useRef } from 'react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

export interface SearchInputProps extends Omit<
  React.ComponentProps<'input'>,
  'value' | 'onChange' | 'type'
> {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible label (visually hidden). */
  label: string;
}

/** Search box with a clear button. Escape clears the current query. */
export function SearchInput({
  value,
  onValueChange,
  label,
  placeholder = 'Search…',
  className,
  onKeyDown,
  ...props
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={cn('relative w-full', className)}>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value !== '') {
            event.preventDefault();
            onValueChange('');
          }
          onKeyDown?.(event);
        }}
        className={cn(
          'focus-ring flex h-control w-full rounded-md border border-input bg-surface pr-8 pl-8 text-sm shadow-xs',
          'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          '[&::-webkit-search-cancel-button]:appearance-none',
        )}
        {...props}
      />
      {value !== '' && !props.disabled ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onValueChange('');
            inputRef.current?.focus();
          }}
          className="focus-ring absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
