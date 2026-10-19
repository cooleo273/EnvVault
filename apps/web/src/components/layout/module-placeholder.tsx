import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { EmptyState } from '@/components/feedback/states';
import { Button } from '@/components/ui/button';
import { PageHeader } from './page-header';

export interface ModulePlaceholderProps {
  title: string;
  description: string;
  icon: LucideIcon;
  /** What the module will do once implemented. */
  upcoming: React.ReactNode;
  /** Label of the module's future primary action (rendered disabled). */
  primaryActionLabel?: string;
}

/** Standard page for modules that are designed but not implemented yet. */
export function ModulePlaceholder({
  title,
  description,
  icon,
  upcoming,
  primaryActionLabel,
}: ModulePlaceholderProps) {
  return (
    <>
      <PageHeader
        title={title}
        description={description}
        status="preview"
        breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: title }]}
        actions={
          primaryActionLabel ? (
            <Button disabled aria-describedby="module-unavailable">
              {primaryActionLabel}
            </Button>
          ) : undefined
        }
      />
      <div className="rounded-lg border bg-surface">
        <EmptyState
          variant="placeholder"
          icon={icon}
          title={`${title} is not connected yet`}
          description={<span id="module-unavailable">{upcoming}</span>}
        />
      </div>
    </>
  );
}
