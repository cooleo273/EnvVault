import type { EnvironmentKind, VisualColor, VisualIcon } from '@envvault/shared';
import {
  Box,
  Cloud,
  Code,
  Cpu,
  Database,
  Eye,
  FlaskConical,
  Folder,
  GitBranch,
  Globe,
  Layers,
  Lock,
  type LucideIcon,
  Package,
  Presentation,
  Rocket,
  Server,
  Shield,
  ShieldCheck,
  Smartphone,
  Terminal,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export const ICONS: Record<VisualIcon, LucideIcon> = {
  folder: Folder,
  box: Box,
  globe: Globe,
  server: Server,
  database: Database,
  smartphone: Smartphone,
  cloud: Cloud,
  code: Code,
  terminal: Terminal,
  cpu: Cpu,
  rocket: Rocket,
  layers: Layers,
  shield: Shield,
  lock: Lock,
  'flask-conical': FlaskConical,
  eye: Eye,
  presentation: Presentation,
  'git-branch': GitBranch,
  package: Package,
  wrench: Wrench,
};

/** Static class strings per palette color (Tailwind needs literal class names). */
export const COLOR_CLASSES: Record<VisualColor, { swatch: string; soft: string; dot: string }> = {
  slate: {
    swatch: 'bg-slate-500',
    soft: 'bg-slate-500/12 text-slate-700 dark:text-slate-300',
    dot: 'bg-slate-500',
  },
  red: {
    swatch: 'bg-red-500',
    soft: 'bg-red-500/12 text-red-700 dark:text-red-300',
    dot: 'bg-red-500',
  },
  orange: {
    swatch: 'bg-orange-500',
    soft: 'bg-orange-500/12 text-orange-700 dark:text-orange-300',
    dot: 'bg-orange-500',
  },
  amber: {
    swatch: 'bg-amber-500',
    soft: 'bg-amber-500/14 text-amber-800 dark:text-amber-300',
    dot: 'bg-amber-500',
  },
  green: {
    swatch: 'bg-green-500',
    soft: 'bg-green-500/12 text-green-700 dark:text-green-300',
    dot: 'bg-green-500',
  },
  emerald: {
    swatch: 'bg-emerald-500',
    soft: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500',
  },
  teal: {
    swatch: 'bg-teal-500',
    soft: 'bg-teal-500/12 text-teal-700 dark:text-teal-300',
    dot: 'bg-teal-500',
  },
  cyan: {
    swatch: 'bg-cyan-500',
    soft: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300',
    dot: 'bg-cyan-500',
  },
  sky: {
    swatch: 'bg-sky-500',
    soft: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
    dot: 'bg-sky-500',
  },
  blue: {
    swatch: 'bg-blue-500',
    soft: 'bg-blue-500/12 text-blue-700 dark:text-blue-300',
    dot: 'bg-blue-500',
  },
  indigo: {
    swatch: 'bg-indigo-500',
    soft: 'bg-indigo-500/12 text-indigo-700 dark:text-indigo-300',
    dot: 'bg-indigo-500',
  },
  violet: {
    swatch: 'bg-violet-500',
    soft: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
    dot: 'bg-violet-500',
  },
  purple: {
    swatch: 'bg-purple-500',
    soft: 'bg-purple-500/12 text-purple-700 dark:text-purple-300',
    dot: 'bg-purple-500',
  },
  pink: {
    swatch: 'bg-pink-500',
    soft: 'bg-pink-500/12 text-pink-700 dark:text-pink-300',
    dot: 'bg-pink-500',
  },
};

function colorOf(color: string) {
  // Unknown values (e.g. from older data) fall back to slate.
  return (
    (COLOR_CLASSES as Partial<Record<string, (typeof COLOR_CLASSES)[VisualColor]>>)[color] ??
    COLOR_CLASSES.slate
  );
}

/** Square project identifier: icon on a tinted background. */
export function ProjectAvatar({
  icon,
  color,
  size = 'md',
  className,
}: {
  icon: string;
  color: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const Icon = (ICONS[icon as VisualIcon] as LucideIcon | undefined) ?? Folder;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-md',
        colorOf(color).soft,
        size === 'sm' && 'size-6 [&_svg]:size-3.5',
        size === 'md' && 'size-8 [&_svg]:size-4',
        size === 'lg' && 'size-10 [&_svg]:size-5',
        className,
      )}
    >
      <Icon />
    </span>
  );
}

const KIND_ICONS: Record<EnvironmentKind, LucideIcon> = {
  DEVELOPMENT: Code,
  TESTING: FlaskConical,
  STAGING: Layers,
  PRODUCTION: Shield,
  OTHER: Box,
};

/** Environment chip: colored dot, name and a lock for protected environments. */
export function EnvironmentChip({
  name,
  color,
  isProtected,
  archived = false,
  className,
}: {
  name: string;
  color: string;
  isProtected: boolean;
  archived?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-sm border px-1.5 py-px text-xs font-medium whitespace-nowrap',
        archived && 'opacity-60',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 shrink-0 rounded-full', colorOf(color).dot)}
      />
      <span className="truncate">{name}</span>
      {isProtected ? (
        <>
          <ShieldCheck aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          <span className="sr-only">(protected)</span>
        </>
      ) : null}
    </span>
  );
}

export function EnvironmentIcon({
  icon,
  kind,
  color,
  className,
}: {
  icon: string | null;
  kind: EnvironmentKind;
  color: string;
  className?: string;
}) {
  const Icon =
    (icon ? (ICONS[icon as VisualIcon] as LucideIcon | undefined) : undefined) ?? KIND_ICONS[kind];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4',
        colorOf(color).soft,
        className,
      )}
    >
      <Icon />
    </span>
  );
}

export function ColorSwatch({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('size-3 rounded-full', colorOf(color).swatch, className)}
    />
  );
}
