import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTableDensity } from '@/components/preferences/use-table-density';
import { Button } from '@/components/ui/button';
import { PRIMARY_NAV, SECONDARY_NAV } from '@/config/navigation';
import { AppSidebar } from './app-sidebar';
import { UserMenu } from './header-menus';
import { PageHeader } from './page-header';
import { WorkspaceSwitcher } from './workspace-switcher';

const pathname = vi.hoisted(() => ({ current: '/projects' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

describe('AppSidebar', () => {
  beforeEach(() => {
    pathname.current = '/projects';
  });

  it('renders every navigation item in a labelled landmark', () => {
    render(<AppSidebar />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const item of [...PRIMARY_NAV, ...SECONDARY_NAV]) {
      expect(within(nav).getByRole('link', { name: new RegExp(item.label) })).toHaveAttribute(
        'href',
        item.href,
      );
    }
  });

  it('marks the current section, including nested routes', () => {
    pathname.current = '/projects/checkout-api/environments';
    render(<AppSidebar />);
    expect(screen.getByRole('link', { name: /Projects/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Workspaces/ })).not.toHaveAttribute('aria-current');
  });

  it('labels modules that are not connected yet', () => {
    render(<AppSidebar />);
    expect(
      within(screen.getByRole('link', { name: /Audit Logs/ })).getByText('Preview'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('link', { name: /Overview/ })).queryByText('Preview'),
    ).toBeNull();
  });
});

describe('PageHeader', () => {
  it('renders breadcrumbs, a single h1, status and actions', () => {
    render(
      <PageHeader
        title="Projects"
        description="Applications in this workspace."
        status="preview"
        breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: 'Projects' }]}
        actions={<Button>New project</Button>}
      />,
    );
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(within(breadcrumb).getByText('Projects')).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
  });
});

describe('WorkspaceSwitcher', () => {
  it('states clearly when the user has no workspaces and offers creation', async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher />);
    await user.click(
      screen.getByRole('button', { name: /Switch workspace \(current: No workspace\)/ }),
    );
    expect(await screen.findByText(/don’t belong to any workspace yet/)).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Create workspace/ })).toHaveAttribute(
      'href',
      '/workspaces/new',
    );
  });

  it('lists provided workspaces and reports selection', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <WorkspaceSwitcher
        workspaces={[
          { id: 'w1', name: 'Acme' },
          { id: 'w2', name: 'Globex' },
        ]}
        currentWorkspaceId="w1"
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole('button', { name: /current: Acme/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Globex' }));
    expect(onSelect).toHaveBeenCalledWith('w2');
  });
});

describe('useTableDensity', () => {
  it('persists the preference and ignores invalid stored values', () => {
    window.localStorage.setItem('envvault:table-density', 'gigantic');
    const { result } = renderHook(() => useTableDensity());
    expect(result.current[0]).toBe('default');

    act(() => {
      result.current[1]('compact');
    });
    expect(result.current[0]).toBe('compact');
    expect(window.localStorage.getItem('envvault:table-density')).toBe('compact');
  });
});

describe('UserMenu', () => {
  it('shows the signed-in identity and submits the sign-out action', async () => {
    const user = userEvent.setup();
    const signOutAction = vi.fn(() => Promise.resolve());
    render(
      <UserMenu
        user={{ name: 'Dev User', email: 'dev@example.test' }}
        signOutAction={signOutAction}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Account menu for Dev User' }));
    expect(await screen.findByText('dev@example.test')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Sign out/ }));
    await vi.waitFor(() => {
      expect(signOutAction).toHaveBeenCalledOnce();
    });
  });
});
