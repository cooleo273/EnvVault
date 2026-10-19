import {
  ENVIRONMENT_KIND_LABELS,
  type EnvironmentKind,
  isSensitivePermission,
  type PermissionKey,
  PERMISSIONS,
} from '@envvault/shared';
import { LockIcon, ShieldAlertIcon } from 'lucide-react';
import { STATUS_TONE_CLASSES, type StatusTone } from '@/design/tokens';
import { cn } from '@/lib/utils';

export const ENVIRONMENT_KIND_TONES: Record<EnvironmentKind, StatusTone> = {
  PRODUCTION: 'danger',
  STAGING: 'warning',
  TESTING: 'info',
  DEVELOPMENT: 'success',
  OTHER: 'neutral',
};

export interface EnvironmentBadgeProps {
  kind: EnvironmentKind;
  /** Custom environment name; defaults to the kind label. */
  name?: string;
  /** Protected environments require change approval. */
  isProtected?: boolean;
  className?: string;
}

export function EnvironmentBadge({
  kind,
  name,
  isProtected = false,
  className,
}: EnvironmentBadgeProps) {
  const tone = ENVIRONMENT_KIND_TONES[kind];
  const label = name ?? ENVIRONMENT_KIND_LABELS[kind];
  return (
    <span
      data-kind={kind}
      title={name ? `${label} (${ENVIRONMENT_KIND_LABELS[kind]})` : undefined}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded-sm border px-1.5 py-px text-2xs font-medium whitespace-nowrap',
        STATUS_TONE_CLASSES[tone].badge,
        className,
      )}
    >
      {label}
      {isProtected ? (
        <>
          <LockIcon aria-hidden="true" className="size-3" />
          <span className="sr-only">, protected</span>
        </>
      ) : null}
    </span>
  );
}

export interface PermissionBadgeProps {
  permission: PermissionKey;
  className?: string;
}

/** Shows a permission key; sensitive permissions are highlighted and labelled. */
export function PermissionBadge({ permission, className }: PermissionBadgeProps) {
  const sensitive = isSensitivePermission(permission);
  const description = PERMISSIONS[permission];
  return (
    <span
      data-sensitive={sensitive}
      title={description}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-2xs whitespace-nowrap',
        sensitive
          ? STATUS_TONE_CLASSES.warning.badge
          : 'border-border bg-surface-muted text-muted-foreground',
        className,
      )}
    >
      {sensitive ? <ShieldAlertIcon aria-hidden="true" className="size-3" /> : null}
      {permission}
      <span className="sr-only">
        {sensitive ? ' (sensitive)' : ''}: {description}
      </span>
    </span>
  );
}
