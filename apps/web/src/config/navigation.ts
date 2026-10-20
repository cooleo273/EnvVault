import {
  Bell,
  Blocks,
  FolderGit2,
  LayoutDashboard,
  type LucideIcon,
  ScrollText,
  Settings,
  Users,
  Building2,
} from 'lucide-react';

/**
 * - `live`: renders real data from the API.
 * - `preview`: the screen exists, but the feature is not connected yet.
 */
export type FeatureStatus = 'live' | 'preview';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  status: FeatureStatus;
}

export const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, status: 'live' },
  { href: '/workspaces', label: 'Workspaces', icon: Building2, status: 'live' },
  { href: '/projects', label: 'Projects', icon: FolderGit2, status: 'live' },
  { href: '/members', label: 'Team Members', icon: Users, status: 'live' },
  { href: '/audit-logs', label: 'Audit Logs', icon: ScrollText, status: 'preview' },
  { href: '/integrations', label: 'Integrations', icon: Blocks, status: 'preview' },
  { href: '/notifications', label: 'Notifications', icon: Bell, status: 'preview' },
];

export const SECONDARY_NAV: readonly NavItem[] = [
  { href: '/settings', label: 'Settings', icon: Settings, status: 'live' },
];

export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The single navigation entry to highlight. Workspace-scoped sections map to
 * their shortcut entries: `/workspaces/<id>/projects/...` is "Projects" and
 * `/workspaces/<id>/members` is "Team Members", not "Workspaces".
 */
export function activeNavHref(pathname: string): string | undefined {
  const section = /^\/workspaces\/[^/]+\/(projects|members)(?:\/|$)/.exec(pathname)?.[1];
  if (section) return `/${section}`;
  return [...PRIMARY_NAV, ...SECONDARY_NAV].find((item) => isActivePath(pathname, item.href))?.href;
}
