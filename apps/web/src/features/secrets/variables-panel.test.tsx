import type { SecretList, SecretSummary } from '@envvault/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  selectionAction: vi.fn(),
  bulkAction: vi.fn(),
  previewImportAction: vi.fn(),
  importAction: vi.fn(),
  exportAction: vi.fn(),
  listVersionsAction: vi.fn(),
  revealVersionAction: vi.fn(),
  compareVersionsAction: vi.fn(),
  rollbackAction: vi.fn(),
  createSecretAction: vi.fn(),
  updateSecretAction: vi.fn(),
  deleteSecretAction: vi.fn(),
  restoreSecretAction: vi.fn(),
  revealSecretAction: vi.fn(),
  confirmPasswordAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const search = vi.hoisted(() => ({ value: new URLSearchParams() }));

vi.mock('./actions', () => actions);
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/workspaces/w/projects/p/environments/e',
  useSearchParams: () => search.value,
}));

const { VariablesPanel } = await import('./variables-panel');
const { REVEAL_DURATION_MS } = await import('./secret-value-cell');

const SYNTHETIC = 'synthetic-panel-value-77d2';
const ALL = ['environment:read', 'secret:list', 'secret:read', 'secret:write', 'secret:delete'];

function secret(overrides: Partial<SecretSummary> = {}): SecretSummary {
  return {
    id: '0199f000-0000-7000-8000-000000000001',
    environmentId: '0199f000-0000-7000-8000-0000000000e1',
    key: 'DATABASE_URL',
    description: 'Primary database',
    type: 'SECRET',
    category: 'Database',
    tags: ['backend'],
    isRequired: true,
    inheritable: false,
    status: 'ACTIVE',
    hasValue: true,
    currentVersion: 2,
    revision: 3,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    deletedAt: null,
    createdBy: { displayName: 'Ada', email: 'ada@example.test' },
    updatedBy: { displayName: 'Ada', email: 'ada@example.test' },
    deletedBy: null,
    ...overrides,
  };
}

function listOf(items: SecretSummary[]): SecretList {
  return {
    items,
    page: 1,
    pageSize: 50,
    total: items.length,
    facets: { categories: ['Database'], tags: ['backend'] },
  };
}

function renderPanel(
  options: {
    list?: SecretList | null;
    permissions?: string[];
    isProtected?: boolean;
    archived?: boolean;
    missingKeys?: string[];
  } = {},
) {
  return render(
    <VariablesPanel
      workspaceId="w"
      projectId="p"
      environmentId="e"
      list={options.list === undefined ? listOf([secret()]) : options.list}
      permissions={options.permissions ?? ALL}
      isProtected={options.isProtected ?? false}
      archived={options.archived ?? false}
      missingKeys={options.missingKeys ?? []}
      environmentName="Development"
      environments={[]}
    />,
  );
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
  search.value = new URLSearchParams();
});

describe('VariablesPanel', () => {
  it('shows metadata with masked values and never renders a value it was not given', () => {
    renderPanel();
    const table = screen.getByRole('table', { name: 'Environment variables' });
    const row = within(table).getByRole('row', { name: /DATABASE_URL/ });
    expect(within(row).getByLabelText('Value hidden')).toHaveTextContent('••••••••••••');
    expect(within(row).getByText('Database')).toBeInTheDocument();
    expect(within(row).getByText('v2')).toBeInTheDocument();
    expect(within(row).getByText('Required')).toBeInTheDocument();
    expect(screen.getByTestId('variable-count')).toHaveTextContent('1 variable');
    expect(screen.queryByTestId('secret-value')).not.toBeInTheDocument();
  });

  it('reveals on request, hides on demand and after the visibility period', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      actions.revealSecretAction.mockResolvedValue({
        ok: true,
        data: { value: SYNTHETIC, version: 2, type: 'SECRET' },
      });
      renderPanel();
      await user.click(screen.getByRole('button', { name: 'Reveal DATABASE_URL' }));
      expect(await screen.findByTestId('secret-value')).toHaveTextContent(SYNTHETIC);
      expect(actions.revealSecretAction).toHaveBeenCalledWith(
        'w',
        'p',
        'e',
        '0199f000-0000-7000-8000-000000000001',
      );
      await user.click(screen.getByRole('button', { name: 'Hide DATABASE_URL' }));
      expect(screen.queryByText(SYNTHETIC)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Reveal DATABASE_URL' }));
      expect(await screen.findByText(SYNTHETIC)).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(REVEAL_DURATION_MS + 10);
      });
      expect(screen.queryByText(SYNTHETIC)).not.toBeInTheDocument();
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides the value when the row goes away (page, filter or environment change)', async () => {
    const user = userEvent.setup();
    actions.revealSecretAction.mockResolvedValue({
      ok: true,
      data: { value: SYNTHETIC, version: 2, type: 'SECRET' },
    });
    const view = renderPanel();
    await user.click(screen.getByRole('button', { name: 'Reveal DATABASE_URL' }));
    expect(await screen.findByText(SYNTHETIC)).toBeInTheDocument();
    view.rerender(
      <VariablesPanel
        workspaceId="w"
        projectId="p"
        environmentId="e2"
        list={listOf([secret({ id: '0199f000-0000-7000-8000-000000000099' })])}
        permissions={ALL}
        isProtected={false}
        archived={false}
        missingKeys={[]}
        environmentName="Development"
        environments={[]}
      />,
    );
    expect(screen.queryByText(SYNTHETIC)).not.toBeInTheDocument();
  });

  it('asks for the password before revealing in a protected environment', async () => {
    const user = userEvent.setup();
    actions.revealSecretAction
      .mockResolvedValueOnce({ ok: false, code: 'STEP_UP_REQUIRED', message: 'Confirm' })
      .mockResolvedValueOnce({ ok: true, data: { value: SYNTHETIC, version: 2, type: 'SECRET' } });
    actions.confirmPasswordAction.mockResolvedValue({ ok: true, data: undefined });
    renderPanel({ isProtected: true });
    await user.click(screen.getByRole('button', { name: 'Reveal DATABASE_URL' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    await user.type(within(dialog).getByLabelText(/Password/), 'pw-synthetic');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(SYNTHETIC)).toBeInTheDocument();
    expect(actions.confirmPasswordAction).toHaveBeenCalledWith('pw-synthetic');
  });

  it('hides controls the caller lacks permissions for', () => {
    renderPanel({ permissions: ['environment:read', 'secret:list'] });
    expect(screen.queryByRole('button', { name: /Reveal/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add variable' })).not.toBeInTheDocument();
  });

  it('disables writes in archived environments', () => {
    renderPanel({ archived: true });
    expect(screen.queryByRole('button', { name: 'Add variable' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reveal DATABASE_URL' })).toBeInTheDocument();
  });

  it('adds a variable, validating the name and detecting duplicates', async () => {
    const user = userEvent.setup();
    actions.createSecretAction.mockResolvedValue({ ok: true, data: { id: 'x' }, message: 'Added' });
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add variable' });
    const name = within(dialog).getByLabelText(/^Name/);

    await user.type(name, 'DATABASE_URL');
    expect(within(dialog).getByText(/already exists here/)).toBeInTheDocument();

    await user.clear(name);
    await user.type(name, '1BAD');
    await user.click(within(dialog).getByRole('button', { name: 'Add variable' }));
    expect(within(dialog).getByText(/starting with a letter or underscore/)).toBeInTheDocument();
    expect(actions.createSecretAction).not.toHaveBeenCalled();

    await user.clear(name);
    await user.type(name, 'STRIPE_KEY');
    const value = within(dialog).getByLabelText(/^Value/);
    expect(value).toHaveAttribute('type', 'password');
    await user.type(value, SYNTHETIC);
    await user.click(within(dialog).getByRole('button', { name: 'Show value' }));
    expect(value).toHaveAttribute('type', 'text');
    await user.click(within(dialog).getByRole('button', { name: 'Add variable' }));
    await waitFor(() => {
      expect(actions.createSecretAction).toHaveBeenCalledWith(
        'w',
        'p',
        'e',
        expect.objectContaining({ key: 'STRIPE_KEY', value: SYNTHETIC, type: 'SECRET' }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue(SYNTHETIC)).not.toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
  });

  it('validates typed values and formats JSON', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add variable' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'CONFIG');
    await user.selectOptions(within(dialog).getByLabelText(/^Type/), 'JSON');
    const value = within(dialog).getByLabelText(/^Value/);
    await user.click(value);
    await user.paste('{"a":');
    expect(within(dialog).getByText('Enter valid JSON')).toBeInTheDocument();
    await user.paste('1}');
    await user.click(within(dialog).getByRole('button', { name: 'Format JSON' }));
    expect(value).toHaveValue('{\n  "a": 1\n}');
  });

  it('shows a conflict instead of overwriting a concurrent change', async () => {
    const user = userEvent.setup();
    actions.updateSecretAction.mockResolvedValue({
      ok: false,
      code: 'SECRET_CONFLICT',
      message: 'Changed',
    });
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Actions for DATABASE_URL' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit DATABASE_URL' });
    const description = within(dialog).getByLabelText(/^Description/);
    await user.clear(description);
    await user.type(description, 'Replica');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(
      await within(dialog).findByText(/changed this variable while you were editing/),
    ).toBeInTheDocument();
    expect(actions.updateSecretAction).toHaveBeenCalledWith(
      'w',
      'p',
      'e',
      '0199f000-0000-7000-8000-000000000001',
      { expectedRevision: 3, description: 'Replica' },
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reload' }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('edits metadata without sending a value unless asked to replace it', async () => {
    const user = userEvent.setup();
    actions.updateSecretAction.mockResolvedValue({ ok: true, data: { revision: 4 } });
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Actions for DATABASE_URL' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit DATABASE_URL' });
    expect(within(dialog).queryByLabelText(/^Value/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('switch', { name: /Replace the value/ }));
    await user.type(within(dialog).getByLabelText(/^Value/), SYNTHETIC);
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(actions.updateSecretAction).toHaveBeenCalledWith('w', 'p', 'e', expect.any(String), {
        expectedRevision: 3,
        value: SYNTHETIC,
      });
    });
  });

  it('deletes after confirmation and restores from the deleted view', async () => {
    const user = userEvent.setup();
    actions.deleteSecretAction.mockResolvedValue({ ok: true, data: undefined, message: 'Deleted' });
    actions.restoreSecretAction.mockResolvedValue({
      ok: true,
      data: undefined,
      message: 'Restored',
    });
    const view = renderPanel();
    await user.click(screen.getByRole('button', { name: 'Actions for DATABASE_URL' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete DATABASE_URL?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(actions.deleteSecretAction).toHaveBeenCalledWith(
        'w',
        'p',
        'e',
        '0199f000-0000-7000-8000-000000000001',
        3,
      );
    });

    search.value = new URLSearchParams('status=deleted');
    view.rerender(
      <VariablesPanel
        workspaceId="w"
        projectId="p"
        environmentId="e"
        list={listOf([secret({ status: 'DELETED', deletedAt: '2026-10-03T10:00:00.000Z' })])}
        permissions={ALL}
        isProtected={false}
        archived={false}
        missingKeys={[]}
        environmentName="Development"
        environments={[]}
      />,
    );
    expect(screen.queryByRole('button', { name: /Reveal/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for DATABASE_URL' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    await waitFor(() => {
      expect(actions.restoreSecretAction).toHaveBeenCalled();
    });
  });

  it('searches and filters through the URL', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByRole('searchbox', { name: 'Search variables' }), 'db');
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/workspaces/w/projects/p/environments/e?q=db', {
        scroll: false,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Type filter' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'JSON' }));
    expect(router.replace).toHaveBeenLastCalledWith(
      '/workspaces/w/projects/p/environments/e?type=JSON',
      { scroll: false },
    );
    await user.keyboard('{Escape}');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'updated');
    expect(router.replace).toHaveBeenLastCalledWith(
      '/workspaces/w/projects/p/environments/e?sort=updated',
      { scroll: false },
    );
  });

  it('renders empty, filtered empty and error states', async () => {
    const user = userEvent.setup();
    const view = renderPanel({ list: listOf([]) });
    expect(screen.getByText('No variables yet')).toBeInTheDocument();
    search.value = new URLSearchParams('q=nothing');
    view.rerender(
      <VariablesPanel
        workspaceId="w"
        projectId="p"
        environmentId="e"
        list={listOf([])}
        permissions={ALL}
        isProtected={false}
        archived={false}
        missingKeys={[]}
        environmentName="Development"
        environments={[]}
      />,
    );
    expect(screen.getByText('No matching variables')).toBeInTheDocument();
    view.rerender(
      <VariablesPanel
        workspaceId="w"
        projectId="p"
        environmentId="e"
        list={null}
        permissions={ALL}
        isProtected={false}
        archived={false}
        missingKeys={[]}
        environmentName="Development"
        environments={[]}
      />,
    );
    expect(screen.getByText('Variables could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Try again|Retry/ }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('offers expected template keys and shows variables without a value', async () => {
    const user = userEvent.setup();
    renderPanel({
      list: listOf([secret({ hasValue: false, currentVersion: null })]),
      missingKeys: ['REDIS_URL'],
    });
    expect(screen.getByText('Not set')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'REDIS_URL' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add variable' });
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('REDIS_URL');
  });

  it('selects rows for bulk actions and shows import, export and history controls', async () => {
    const user = userEvent.setup();
    actions.listVersionsAction.mockResolvedValue({
      ok: true,
      data: { items: [], total: 0, nextBefore: null },
    });
    renderPanel({
      permissions: [...ALL, 'secret:export', 'secret:rollback'],
      list: listOf([
        secret(),
        secret({ id: '0199f000-0000-7000-8000-000000000002', key: 'REDIS_URL' }),
      ]),
    });
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    await user.click(screen.getByLabelText('Select all visible variables'));
    expect(screen.getByTestId('selection-count')).toHaveTextContent('2 selected');
    await user.click(screen.getByLabelText('Select REDIS_URL'));
    expect(screen.getByTestId('selection-count')).toHaveTextContent('1 selected');
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions for DATABASE_URL' }));
    await user.click(await screen.findByRole('menuitem', { name: 'History' }));
    expect(
      await screen.findByRole('dialog', { name: 'History of DATABASE_URL' }),
    ).toBeInTheDocument();
  });

  it('hides export without secret:export even when values can be read', () => {
    renderPanel({ permissions: ALL });
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
  });
});
