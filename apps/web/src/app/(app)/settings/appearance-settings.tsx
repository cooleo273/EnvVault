'use client';

import { useTheme } from 'next-themes';
import { useTableDensity } from '@/components/preferences/use-table-density';
import { THEME_OPTIONS, useHydrated } from '@/components/theme/theme';
import { TABLE_DENSITIES, TABLE_DENSITY_LABELS } from '@/design/tokens';
import { cn } from '@/lib/utils';

interface Choice<T extends string> {
  value: T;
  label: string;
}

function ChoiceGroup<T extends string>({
  legend,
  description,
  name,
  choices,
  value,
  onChange,
}: {
  legend: string;
  description: string;
  name: string;
  choices: readonly Choice<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{legend}</legend>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="inline-flex w-fit rounded-md border bg-surface-muted p-0.5">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className={cn(
              'cursor-pointer rounded-sm px-3 py-1 text-sm text-muted-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring',
              value === choice.value && 'bg-surface font-medium text-foreground shadow-xs',
            )}
          >
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => {
                onChange(choice.value);
              }}
              className="sr-only"
            />
            {choice.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Real, working preferences stored in this browser. */
export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  const hydrated = useHydrated();
  const [density, setDensity] = useTableDensity();

  return (
    <div className="flex flex-col gap-6">
      <ChoiceGroup
        legend="Theme"
        description="Follow your operating system or choose a fixed theme."
        name="theme"
        choices={THEME_OPTIONS}
        value={
          hydrated ? ((theme ?? 'system') as (typeof THEME_OPTIONS)[number]['value']) : undefined
        }
        onChange={setTheme}
      />
      <ChoiceGroup
        legend="Table density"
        description="Row height used by data tables."
        name="density"
        choices={TABLE_DENSITIES.map((value) => ({ value, label: TABLE_DENSITY_LABELS[value] }))}
        value={hydrated ? density : undefined}
        onChange={setDensity}
      />
    </div>
  );
}
