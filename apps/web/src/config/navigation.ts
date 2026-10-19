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
  { href: '/projects', label: 'Projects', icon: FolderGit2, status: 'preview' },
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
