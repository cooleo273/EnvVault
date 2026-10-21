import type { ImportPreview, SecretSummary, SecretVersionDetail } from '@envvault/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lineDiff } from '@/lib/line-diff';

const actions = vi.hoisted(() => ({
  previewImportAction: vi.fn(),
  importAction: vi.fn(),
  exportAction: vi.fn(),
  selectionAction: vi.fn(),
  bulkAction: vi.fn(),
  listVersionsAction: vi.fn(),
  revealVersionAction: vi.fn(),
  compareVersionsAction: vi.fn(),
  rollbackAction: vi.fn(),
  confirmPasswordAction: vi.fn(),
  revealSecretAction: vi.fn(),
}));
vi.mock('./actions', () => actions);

const { ImportWizard } = await import('./import-wizard');
const { ExportDialog } = await import('./export-dialog');
const { HistoryDrawer } = await import('./history-drawer');
const { BulkBar } = await import('./bulk-bar');

const SYNTHETIC = 'synthetic-transfer-value-3e8a';
const IDS = { workspaceId: 'w', projectId: 'p', environmentId: 'e' } as const;

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
});

function preview(): ImportPreview {
  return {
    entries: [
      {
        line: 1,
        key: 'NEW_KEY',
        status: 'new',
        problem: null,
        valueBytes: 5,
        multiline: false,
        type: 'SECRET',
        existing: null,
      },
      {
        line: 2,
        key: 'CHANGED',
        status: 'changed',
        problem: null,
        valueBytes: 7,
        multiline: false,
        type: 'SECRET',
        existing: {
          id: '0199f000-0000-7000-8000-000000000001',
          type: 'SECRET',
          revision: 4,
          hasValue: true,
        },
      },
      {
        line: 3,
        key: 'bad-key',
        status: 'invalid',
        problem: 'Use letters, digits and underscores',
        valueBytes: 1,
        multiline: false,
        type: 'SECRET',
        existing: null,
      },
    ],
    ignoredLines: [{ line: 4, reason: 'Not a KEY=VALUE assignment; it was ignored' }],
    compared: true,
    summary: { new: 1, changed: 1, unchanged: 0, exists: 0, invalid: 1, duplicate: 0 },
    limits: { maxBytes: 262144, maxEntries: 500 },
  };
}

describe('ImportWizard', () => {
  it('previews, lets the user decide per variable and imports the selection', async () => {
    const user = userEvent.setup();
    actions.previewImportAction.mockResolvedValue({ ok: true, data: preview() });
    actions.importAction.mockResolvedValue({
      ok: true,
      data: { created: 1, updated: 1, secretIds: [] },
    });
    const onOpenChange = vi.fn();
    render(
      <ImportWizard
        {...IDS}
        environmentName="Development"
        isProtected={false}
        open
        onOpenChange={onOpenChange}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Import into Development' });
    const content = within(dialog).getByLabelText(/\.env content/);
    expect(content).toHaveClass('secret-input-hidden');
    await user.click(content);
    await user.paste(`NEW_KEY=${SYNTHETIC}\nCHANGED=x`);
    await user.click(within(dialog).getByRole('button', { name: 'Review changes' }));

    expect(
      await within(dialog).findByText('Use letters, digits and underscores'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/1 line was not understood/)).toBeInTheDocument();
    // New entries default to create, existing ones to skip.
    expect(within(dialog).getByLabelText('Action for NEW_KEY')).toHaveValue('create');
    expect(within(dialog).getByLabelText('Action for CHANGED')).toHaveValue('skip');
    expect(within(dialog).queryByLabelText('Action for bad-key')).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Action for CHANGED'), 'overwrite');
    await user.click(within(dialog).getByRole('button', { name: 'Import 2 variables' }));

    await waitFor(() => {
      expect(actions.importAction).toHaveBeenCalledWith(
        'w',
        'p',
        'e',
        expect.objectContaining({
          content: `NEW_KEY=${SYNTHETIC}\nCHANGED=x`,
          items: [
            { action: 'create', key: 'NEW_KEY' },
            { action: 'overwrite', key: 'CHANGED', expectedRevision: 4 },
          ],
        }),
      );
    });
    expect(await within(dialog).findByText('Import complete')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(new RegExp(SYNTHETIC))).not.toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('shows the keys the server rejected and keeps the review open', async () => {
    const user = userEvent.setup();
    actions.previewImportAction.mockResolvedValue({ ok: true, data: preview() });
    actions.importAction.mockResolvedValue({
      ok: false,
      code: 'SECRET_IMPORT_REJECTED',
      message: 'Some selected variables could not be imported. Nothing was changed.',
      fieldErrors: { NEW_KEY: 'A variable with this name exists now' },
    });
    render(
      <ImportWizard
        {...IDS}
        environmentName="Development"
        isProtected={false}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByLabelText(/\.env content/));
    await user.paste('NEW_KEY=x');
    await user.click(within(dialog).getByRole('button', { name: 'Review changes' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Import 1 variable' }));
    expect(
      await within(dialog).findByText('A variable with this name exists now'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Nothing was changed');
  });

  it('cancels without sending anything', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ImportWizard
        {...IDS}
        environmentName="Development"
        isProtected={false}
        open
        onOpenChange={onOpenChange}
      />,
    );
    await user.click(screen.getByLabelText(/\.env content/));
    await user.paste(`A=${SYNTHETIC}`);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(actions.previewImportAction).not.toHaveBeenCalled();
  });
});

describe('ExportDialog', () => {
  it('requires the plaintext acknowledgement and downloads the selection', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:export');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    actions.exportAction.mockResolvedValue({
      ok: true,
      data: {
        filename: '.env.development',
        mediaType: 'text/plain; charset=utf-8',
        format: 'dotenv',
        count: 2,
        skipped: [],
        warnings: [],
        content: `A=${SYNTHETIC}\n`,
      },
    });
    const onOpenChange = vi.fn();
    render(
      <ExportDialog
        workspaceId="w"
        projectId="p"
        currentEnvironmentId="e"
        environments={[
          { id: 'e', name: 'Development', isProtected: false },
          { id: 'prod', name: 'Production', isProtected: true },
        ]}
        selectedIds={['a', 'b']}
        open
        onOpenChange={onOpenChange}
      />,
    );
    const download = screen.getByRole('button', { name: 'Download' });
    expect(download).toBeDisabled();
    await user.click(screen.getByLabelText(/I understand the file contains plaintext secrets/));
    await user.click(download);
    await waitFor(() => {
      expect(actions.exportAction).toHaveBeenCalledWith('w', 'p', 'e', {
        format: 'dotenv',
        secretIds: ['a', 'b'],
      });
    });
    expect(createObjectURL).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('warns about protected environments and asks for the password when required', async () => {
    const user = userEvent.setup();
    actions.exportAction.mockResolvedValue({
      ok: false,
      code: 'STEP_UP_REQUIRED',
      message: 'Confirm',
    });
    render(
      <ExportDialog
        workspaceId="w"
        projectId="p"
        currentEnvironmentId="e"
        environments={[
          { id: 'e', name: 'Development', isProtected: false },
          { id: 'prod', name: 'Production', isProtected: true },
        ]}
        selectedIds={[]}
        open
        onOpenChange={vi.fn()}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Environment'), 'prod');
    expect(screen.getByText(/Production is protected/)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/I understand/));
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(
      await screen.findByRole('dialog', { name: 'Confirm your password' }),
    ).toBeInTheDocument();
    expect(actions.exportAction).toHaveBeenCalledWith('w', 'p', 'prod', { format: 'dotenv' });
  });
});

function version(n: number, overrides: Partial<SecretVersionDetail> = {}): SecretVersionDetail {
  return {
    id: `0199f000-0000-7000-8000-00000000010${String(n)}`,
    version: n,
    isCurrent: false,
    origin: n === 1 ? 'CREATE' : 'UPDATE',
    changeReason: null,
    restoredFromVersion: null,
    keyVersion: 1,
    createdAt: '2026-10-01T10:00:00.000Z',
    createdBy: { displayName: 'Ada', email: 'ada@example.test' },
    ...overrides,
  };
}

const SECRET = {
  id: '0199f000-0000-7000-8000-000000000001',
  key: 'ROTATED',
  revision: 3,
} as SecretSummary;

describe('HistoryDrawer', () => {
  it('lists versions, reveals one, compares two and restores without showing the value', async () => {
    const user = userEvent.setup();
    actions.listVersionsAction.mockResolvedValue({
      ok: true,
      data: {
        items: [
          version(3, { isCurrent: true }),
          version(2, { changeReason: 'rotate' }),
          version(1),
        ],
        total: 3,
        nextBefore: null,
      },
    });
    actions.revealVersionAction.mockResolvedValue({
      ok: true,
      data: { value: `line\n${SYNTHETIC}`, version: 1 },
    });
    actions.compareVersionsAction.mockResolvedValue({
      ok: true,
      data: { from: version(1), to: version(3), sameValue: false, fromBytes: 4, toBytes: 9 },
    });
    actions.rollbackAction.mockResolvedValue({
      ok: true,
      data: { version: 4, revision: 4 },
      message: 'Restored',
    });
    render(
      <HistoryDrawer
        {...IDS}
        secret={SECRET}
        canReveal
        canRollback
        archived={false}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const drawer = await screen.findByRole('dialog', { name: 'History of ROTATED' });
    const rows = await within(drawer).findAllByTestId('version-row');
    expect(rows).toHaveLength(3);
    const [current, , oldest] = rows;
    if (!current || !oldest) throw new Error('rows missing');
    expect(within(drawer).getByText('rotate')).toBeInTheDocument();
    expect(within(current).queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'Reveal version 1' }));
    expect(await within(drawer).findByTestId('version-value')).toHaveTextContent(SYNTHETIC);
    await user.click(within(drawer).getByRole('button', { name: 'Hide version 1' }));
    expect(within(drawer).queryByText(new RegExp(SYNTHETIC))).not.toBeInTheDocument();

    await user.click(within(drawer).getByLabelText('Compare version 1'));
    await user.click(within(drawer).getByLabelText('Compare version 3'));
    await user.click(within(drawer).getByRole('button', { name: 'Compare selected' }));
    expect(await within(drawer).findByText(/differ \(4 B and 9 B\)/)).toBeInTheDocument();

    await user.click(within(oldest).getByRole('button', { name: /Restore/ }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Restore v1?' });
    await user.type(within(confirm).getByLabelText(/Change note/), 'bad rotation');
    await user.click(within(confirm).getByRole('button', { name: 'Restore as new version' }));
    await waitFor(() => {
      expect(actions.rollbackAction).toHaveBeenCalledWith('w', 'p', 'e', SECRET.id, {
        versionId: version(1).id,
        expectedRevision: 3,
        changeReason: 'bad rotation',
      });
    });
  });

  it('hides reveal and restore without the permissions', async () => {
    actions.listVersionsAction.mockResolvedValue({
      ok: true,
      data: { items: [version(2, { isCurrent: true }), version(1)], total: 2, nextBefore: null },
    });
    render(
      <HistoryDrawer
        {...IDS}
        secret={SECRET}
        canReveal={false}
        canRollback={false}
        archived={false}
        open
        onOpenChange={vi.fn()}
      />,
    );
    expect(await screen.findAllByTestId('version-row')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Reveal version/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument();
  });
});

describe('BulkBar', () => {
  const selected = [
    { id: 'a', key: 'A', revision: 1 },
    { id: 'b', key: 'B', revision: 2 },
  ];

  it('selects every match across pages and needs typed confirmation to delete', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClear = vi.fn();
    actions.selectionAction.mockResolvedValue({
      ok: true,
      data: {
        items: [...selected, { id: 'c', key: 'C', revision: 1 }],
        total: 3,
        truncated: false,
      },
    });
    actions.bulkAction.mockResolvedValue({
      ok: true,
      data: { action: 'delete', count: 2, secretIds: ['a', 'b'] },
    });
    render(
      <BulkBar
        {...IDS}
        selected={selected}
        status="active"
        matching={120}
        filters={{ q: 'db' }}
        canWrite
        canDelete
        canExport
        onSelect={onSelect}
        onClear={onClear}
        onExport={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Select all 120 matching' }));
    expect(actions.selectionAction).toHaveBeenCalledWith('w', 'p', 'e', {
      q: 'db',
      status: 'active',
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.arrayContaining([{ id: 'c', key: 'C', revision: 1 }]),
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete 2 variables?' });
    const button = within(confirm).getByRole('button', { name: 'Delete 2' });
    expect(button).toBeDisabled();
    await user.type(within(confirm).getByRole('textbox'), 'delete 2');
    await user.click(button);
    await waitFor(() => {
      expect(actions.bulkAction).toHaveBeenCalledWith('w', 'p', 'e', {
        action: 'delete',
        items: [
          { id: 'a', expectedRevision: 1 },
          { id: 'b', expectedRevision: 2 },
        ],
      });
    });
    expect(onClear).toHaveBeenCalled();
  });

  it('applies only the metadata fields that were changed', async () => {
    const user = userEvent.setup();
    actions.bulkAction.mockResolvedValue({
      ok: true,
      data: { action: 'update', count: 2, secretIds: [] },
    });
    render(
      <BulkBar
        {...IDS}
        selected={selected}
        status="active"
        matching={2}
        filters={{}}
        canWrite
        canDelete={false}
        canExport={false}
        onSelect={vi.fn()}
        onClear={vi.fn()}
        onExport={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit 2 variables' });
    await user.selectOptions(within(dialog).getByLabelText('Category'), 'set');
    await user.type(within(dialog).getByLabelText('New category'), 'Payments');
    await user.type(within(dialog).getByLabelText(/Add tags/), 'billing, eu');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(actions.bulkAction).toHaveBeenCalledWith('w', 'p', 'e', {
        action: 'update',
        items: [
          { id: 'a', expectedRevision: 1 },
          { id: 'b', expectedRevision: 2 },
        ],
        patch: { category: 'Payments', addTags: ['billing', 'eu'] },
      });
    });
  });
});

describe('lineDiff', () => {
  it('marks added and removed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
    expect(lineDiff('', 'new')).toEqual([
      { kind: 'removed', text: '' },
      { kind: 'added', text: 'new' },
    ]);
  });

  it('declines inputs too large to diff in the browser', () => {
    const big = Array.from({ length: 3000 }, (_, i) => String(i)).join('\n');
    expect(lineDiff(big, `${big}\nx`)).toBeNull();
  });
});
