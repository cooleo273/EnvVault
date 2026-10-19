import type * as React from 'react';
import { cn } from '@/lib/utils';

export interface SettingsSectionProps {
  id: string;
  title: string;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'default' | 'danger';
  /** Footer row, typically the submit button of the section's form. */
  footer?: React.ReactNode;
}

/** Bordered settings block with a heading row. Compact by design. */
export function SettingsSection({
  id,
  title,
  description,
  badge,
  children,
  tone = 'default',
  footer,
}: SettingsSectionProps) {
  return (
    <section
      aria-labelledby={id}
      className={cn('rounded-lg border bg-surface', tone === 'danger' && 'border-danger-border')}
    >
      <div className="flex flex-col gap-1 border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <h2 id={id} className="text-sm font-semibold">
            {title}
          </h2>
          {badge}
        </div>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="px-5 py-5">{children}</div>
      {footer ? (
        <div className="flex justify-end gap-2 border-t bg-surface-muted px-5 py-3">{footer}</div>
      ) : null}
    </section>
  );
}

/** A row inside a section: text on the left, an action on the right. */
export function SettingsRow({
  title,
  description,
  action,
}: {
  title: string;
  description?: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
