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
import { cn } from '@/lib/utils';
import { templateChoices } from './templates';
import { COLOR_CLASSES, ICONS } from './visual';

export { templateChoices };

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
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {VISUAL_COLORS.map((color) => (
          <label
            key={color}
            className={cn(
              'grid size-7 cursor-pointer place-items-center rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              COLOR_CLASSES[color].swatch,
            )}
            title={color}
          >
            <input
              type="radio"
              name={name}
              value={color}
              checked={value === color}
              onChange={() => {
                onChange(color);
              }}
              className="sr-only"
              aria-label={color}
            />
            {value === color ? <Check aria-hidden="true" className="size-3.5 text-white" /> : null}
          </label>
        ))}
      </div>
    </fieldset>
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
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1">
        {VISUAL_ICONS.map((icon) => {
          const Icon = ICONS[icon];
          return (
            <label
              key={icon}
              title={icon}
              className={cn(
                'grid size-8 cursor-pointer place-items-center rounded-md border text-muted-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                value === icon ? 'border-brand bg-accent text-foreground' : 'hover:bg-accent',
              )}
            >
              <input
                type="radio"
                name={name}
                value={icon}
                checked={value === icon}
                onChange={() => {
                  onChange(icon);
                }}
                className="sr-only"
                aria-label={icon}
              />
              <Icon aria-hidden="true" className="size-4" />
            </label>
          );
        })}
      </div>
    </fieldset>
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
