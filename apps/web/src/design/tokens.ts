/**
 * Typed counterparts of the CSS design tokens in `app/globals.css`.
 * Components use these types for variant props so every status, density and
 * size maps to an existing token instead of an ad-hoc value.
 */

/** Semantic status roles; each maps to `--status-<role>` (+ `-subtle`, `-border`). */
export const STATUS_TONES = ['success', 'warning', 'danger', 'info', 'neutral'] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

/** Table row density; each maps to `--spacing-row-<density>`. */
export const TABLE_DENSITIES = ['compact', 'default', 'comfortable'] as const;
export type TableDensity = (typeof TABLE_DENSITIES)[number];

export const TABLE_DENSITY_LABELS: Record<TableDensity, string> = {
  compact: 'Compact',
  default: 'Default',
  comfortable: 'Comfortable',
};

/** Tailwind classes per status tone (tokens only, no raw colours). */
export const STATUS_TONE_CLASSES: Record<StatusTone, { badge: string; dot: string; icon: string }> =
  {
    success: {
      badge: 'border-success-border bg-success-subtle text-success',
      dot: 'bg-success',
      icon: 'text-success',
    },
    warning: {
      badge: 'border-warning-border bg-warning-subtle text-warning',
      dot: 'bg-warning',
      icon: 'text-warning',
    },
    danger: {
      badge: 'border-danger-border bg-danger-subtle text-danger',
      dot: 'bg-danger',
      icon: 'text-danger',
    },
    info: {
      badge: 'border-info-border bg-info-subtle text-info',
      dot: 'bg-info',
      icon: 'text-info',
    },
    neutral: {
      badge: 'border-neutral-border bg-neutral-subtle text-neutral',
      dot: 'bg-neutral',
      icon: 'text-neutral',
    },
  };

/**
 * Type scale (documented here, applied with Tailwind utilities):
 * - Page title:     text-xl font-semibold tracking-tight
 * - Section title:  text-sm font-semibold
 * - Body / tables:  text-sm
 * - Captions/meta:  text-xs text-muted-foreground
 * - Badges:         text-2xs font-medium
 * - Identifiers:    font-mono (keys, slugs, permission names)
 */
export const TYPE_SCALE = {
  pageTitle: 'text-xl font-semibold tracking-tight',
  sectionTitle: 'text-sm font-semibold',
  body: 'text-sm',
  caption: 'text-xs text-muted-foreground',
  badge: 'text-2xs font-medium',
} as const;
