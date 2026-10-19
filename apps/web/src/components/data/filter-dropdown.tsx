'use client';

import { ListFilterIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface FilterOption<TValue extends string = string> {
  value: TValue;
  label: string;
}

export interface FilterDropdownProps<TValue extends string = string> {
  /** Name of the filtered attribute, e.g. "Environment". */
  label: string;
  options: readonly FilterOption<TValue>[];
  selected: readonly TValue[];
  onSelectedChange: (selected: TValue[]) => void;
  disabled?: boolean;
}

/** Multi-select filter. The menu stays open while toggling options. */
export function FilterDropdown<TValue extends string = string>({
  label,
  options,
  selected,
  onSelectedChange,
  disabled = false,
}: FilterDropdownProps<TValue>) {
  const count = selected.length;

  function toggle(value: TValue, checked: boolean) {
    onSelectedChange(
      checked ? [...selected, value] : selected.filter((current) => current !== value),
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          size="sm"
          aria-label={count > 0 ? `${label} filter, ${count} selected` : `${label} filter`}
        >
          <ListFilterIcon aria-hidden="true" />
          {label}
          {count > 0 ? (
            <span className="rounded-sm bg-secondary px-1 text-2xs font-medium tabular-nums text-secondary-foreground">
              {count}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Filter by {label.toLowerCase()}</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.includes(option.value)}
            onCheckedChange={(checked) => {
              toggle(option.value, checked);
            }}
            onSelect={(event) => {
              event.preventDefault();
            }}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
        {count > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                onSelectedChange([]);
              }}
            >
              Clear filter
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
