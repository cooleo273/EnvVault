import type { ActivityEvent } from '@envvault/shared';
import { History } from 'lucide-react';
import { EmptyState } from '@/components/feedback/states';

const timeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

const ACTIONS: Record<string, string> = {
  'project.created': 'created the project',
  'project.duplicated': 'created the project as a copy',
  'project.updated': 'updated project settings',
  'project.archived': 'archived the project',
  'project.restored': 'restored the project',
  'project.deleted': 'deleted the project',
  'project.member_added': 'added a project member',
  'project.member_role_changed': 'changed a project role',
  'project.member_removed': 'removed a project member',
  'environment.created': 'created an environment',
  'environment.duplicated': 'duplicated an environment',
  'environment.updated': 'updated an environment',
  'environment.reordered': 'reordered environments',
  'environment.protected': 'protected an environment',
  'environment.unprotected': 'removed protection from an environment',
  'environment.protection_updated': 'changed protection settings',
  'environment.archived': 'archived an environment',
  'environment.restored': 'restored an environment',
  'environment.deleted': 'deleted an environment',
  'environment.access_granted': 'granted environment access',
  'environment.access_revoked': 'revoked environment access',
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Short, non-sensitive context from the event metadata. */
function detail(event: ActivityEvent): string | null {
  const m = event.metadata;
  if (str(m.renamedFrom) && str(m.renamedTo))
    return `${String(m.renamedFrom)} → ${String(m.renamedTo)}`;
  if (str(m.name)) return String(m.name);
  if (str(m.from) && str(m.to)) return `${String(m.from)} → ${String(m.to)}`;
  if (str(m.role)) return `${String(m.role)}${str(m.effect) ? ` (${String(m.effect)})` : ''}`;
  if (Array.isArray(m.fields))
    return (m.fields as unknown[]).filter((f) => typeof f === 'string').join(', ');
  return null;
}

export function describeAction(action: string): string {
  return ACTIONS[action] ?? action.replace(/[._]/g, ' ');
}

/** Project activity, newest first. Server-rendered; never shows secret values. */
export function ActivityList({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border bg-surface">
        <EmptyState
          icon={History}
          title="No activity yet"
          description="Changes to this project will appear here."
        />
      </div>
    );
  }
  return (
    <ol className="divide-y rounded-lg border bg-surface" aria-label="Activity">
      {events.map((event) => {
        const extra = detail(event);
        return (
          <li
            key={event.id}
            className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3"
          >
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-medium">
                {event.actor?.displayName ?? event.actor?.email ?? 'System'}
              </span>{' '}
              {describeAction(event.action)}
              {extra ? <span className="text-muted-foreground"> · {extra}</span> : null}
            </p>
            <time dateTime={event.occurredAt} className="shrink-0 text-xs text-muted-foreground">
              {timeFormat.format(new Date(event.occurredAt))}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
