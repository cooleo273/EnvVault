'use client';

import {
  type EnvironmentTemplate,
  type EnvironmentTemplateEntry,
  VISUAL_COLORS,
  VISUAL_ICONS,
  type VisualColor,
  type VisualIcon,
} from '@envvault/shared';
import { Check, ShieldCheck } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';
import { templateChoices } from './templates';
import { COLOR_CLASSES, ICONS } from './visual';

export { templateChoices };

/**
 * Radio group rendered from React state (`role="radio"` buttons). The value is
 * submitted through a hidden input, so React's post-action form reset can
 * never submit a different value than the one shown.
 */
function ChoiceGroup<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
  renderOption,
  optionClassName,
}: {
  name: string;
  label: string;
  value: string;
  options: readonly T[];
  onChange: (value: T) => void;
  renderOption: (option: T, selected: boolean) => React.ReactNode;
  optionClassName: (option: T, selected: boolean) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${name}-label`} className="mb-1.5 text-sm font-medium">
        {label}
      </span>
      <input type="hidden" name={name} value={value} />
      <div role="radiogroup" aria-labelledby={`${name}-label`} className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const selected = value === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option}
              title={option}
              onClick={() => {
                onChange(option);
              }}
              className={cn(
                'focus-ring grid cursor-pointer place-items-center',
                optionClassName(option, selected),
              )}
            >
              {renderOption(option, selected)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ColorPicker({
  name,
  value,
  onChange,
  label = 'Color',
}: {
  name: string;
  value: string;
  onChange: (value: VisualColor) => void;
  label?: string;
}) {
  return (
    <ChoiceGroup
      name={name}
      label={label}
      value={value}
      options={VISUAL_COLORS}
      onChange={onChange}
      optionClassName={(color) => cn('size-7 rounded-full', COLOR_CLASSES[color].swatch)}
      renderOption={(_color, selected) =>
        selected ? <Check aria-hidden="true" className="size-3.5 text-white" /> : null
      }
    />
  );
}

export function IconPicker({
  name,
  value,
  onChange,
  label = 'Icon',
}: {
  name: string;
  value: string;
  onChange: (value: VisualIcon) => void;
  label?: string;
}) {
  return (
    <ChoiceGroup
      name={name}
      label={label}
      value={value}
      options={VISUAL_ICONS}
      onChange={onChange}
      optionClassName={(_icon, selected) =>
        cn(
          'size-8 rounded-md border text-muted-foreground',
          selected ? 'border-brand bg-accent text-foreground' : 'hover:bg-accent',
        )
      }
      renderOption={(icon) => {
        const Icon = ICONS[icon];
        return <Icon aria-hidden="true" className="size-4" />;
      }}
    />
  );
}

/**
 * EnvironmentTemplateSelector: pick any number of environments for a new
 * project (multi) or one definition to prefill an environment (single).
 */
export function EnvironmentTemplateSelector({
  templates,
  selected,
  onToggle,
  mode = 'multi',
}: {
  templates: EnvironmentTemplate[];
  selected: string[];
  onToggle: (id: string, entry: EnvironmentTemplateEntry) => void;
  mode?: 'multi' | 'single';
}) {
  const choices = templateChoices(templates);
  return (
    <ul className="grid gap-2 sm:grid-cols-2" aria-label="Environment templates">
      {choices.map(({ id, template, entry }) => {
        const checked = selected.includes(id);
        return (
          <li key={id}>
            <label
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-md border bg-surface p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                checked ? 'border-brand bg-accent' : 'hover:bg-accent',
              )}
            >
              <input
                type={mode === 'multi' ? 'checkbox' : 'radio'}
                name="template"
                checked={checked}
                onChange={() => {
                  onToggle(id, entry);
                }}
                className="mt-0.5 size-4 accent-[var(--color-brand)]"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <span
                    aria-hidden="true"
                    className={cn('size-2 rounded-full', COLOR_CLASSES[entry.color ?? 'slate'].dot)}
                  />
                  {entry.name}
                  {entry.isProtected ? (
                    <ShieldCheck
                      aria-label="protected"
                      className="size-3.5 text-muted-foreground"
                    />
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {template.builtIn
                    ? (entry.description ?? template.description)
                    : `${template.name} (workspace template)`}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
