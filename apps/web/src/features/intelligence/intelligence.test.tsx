import type {
  EffectiveConfiguration,
  EnvironmentComparison as Comparison,
  ReadinessReport as Report,
  RestorePreview,
  SnapshotDiff,
  VariableMeta,
} from '@envvault/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  compareEnvironmentsAction: vi.fn(),
  setBaseEnvironmentAction: vi.fn(),
  replaceValidationRulesAction: vi.fn(),
  evaluateReadinessAction: vi.fn(),
  createSnapshotAction: vi.fn(),
  snapshotDiffAction: vi.fn(),
  previewRestoreAction: vi.fn(),
  restoreSnapshotAction: vi.fn(),
}));
const secretActions = vi.hoisted(() => ({
  confirmPasswordAction: vi.fn(),
  createSecretAction: vi.fn(),
  updateSecretAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));

vi.mock('./actions', () => actions);
vi.mock('@/features/secrets/actions', () => secretActions);
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/workspaces/w/projects/p/compare',
  useSearchParams: () => new URLSearchParams(),
}));

const { EnvironmentComparison } = await import('./environment-comparison');
const { DriftReport } = await import('./drift-report');
const { ReadinessReport } = await import('./readiness-report');
const { SnapshotRestoreDialog } = await import('./snapshot-restore-dialog');
const { ValidationRulesEditor } = await import('./validation-rules-editor');
const { InheritedVariables } = await import('./inherited-variables');
const { VariableDialog } = await import('@/features/secrets/variable-dialog');

const IDS = {
  workspaceId: '0199f000-0000-7000-8000-0000000000a1',
  projectId: '0199f000-0000-7000-8000-0000000000b1',
  environmentId: '0199f000-0000-7000-8000-0000000000e1',
};
const SOURCE = '0199f000-0000-7000-8000-0000000000e1';
const TARGET = '0199f000-0000-7000-8000-0000000000e2';
const SNAPSHOT = '0199f000-0000-7000-8000-0000000000f1';

function meta(overrides: Partial<VariableMeta> = {}): VariableMeta {
  return {
    secretId: '0199f000-0000-7000-8000-000000000001',
    key: 'API_URL',
    type: 'STRING',
    category: null,
    tags: [],
    description: null,
    isRequired: false,
    inheritable: false,
    hasValue: true,
    version: 1,
    ...overrides,
  };
}

function ref(id: string, name: string) {
  return { id, name, slug: name.toLowerCase(), isProtected: false, status: 'ACTIVE' as const };
}

function comparison(overrides: Partial<Comparison> = {}): Comparison {
  return {
    source: ref(SOURCE, 'Staging'),
    target: ref(TARGET, 'Production'),
    valuesCompared: false,
    summary: {
      both: 1,
      onlySource: 1,
      onlyTarget: 0,
      typeMismatch: 1,
      requiredMismatch: 0,
      metadataMismatch: 1,
      valuesEqual: 0,
      valuesDifferent: 0,
    },
    items: [
      {
        key: 'API_URL',
        status: 'both',
        source: meta(),
        target: meta({ type: 'NUMBER' }),
        differences: ['type'],
        value: 'not_checked',
      },
      {
        key: 'ONLY_STAGING',
        status: 'only_source',
        source: meta({ key: 'ONLY_STAGING' }),
        target: null,
        differences: [],
        value: 'not_checked',
      },
    ],
    page: 1,
    pageSize: 100,
    total: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EnvironmentComparison', () => {
  const environments = [
    { id: SOURCE, name: 'Staging', isProtected: false },
    { id: TARGET, name: 'Production', isProtected: true },
  ];

  it('shows metadata differences and never claims values match by default', () => {
    render(
      <EnvironmentComparison
        workspaceId={IDS.workspaceId}
        projectId={IDS.projectId}
        environments={environments}
        initial={comparison()}
        sourceId={SOURCE}
        targetId={TARGET}
      />,
    );
    const [first, second] = screen.getAllByTestId('comparison-row');
    if (!first || !second) throw new Error('expected two rows');
    expect(within(first).getByText('Differs: type')).toBeVisible();
    expect(within(first).getByText('Value not checked')).toBeVisible();
    expect(within(second).getByText('Missing from Production')).toBeVisible();
    expect(screen.queryByText('Same value')).toBeNull();
  });

  it('requests value comparison explicitly and asks for a password when required', async () => {
    const user = userEvent.setup();
    actions.compareEnvironmentsAction.mockResolvedValueOnce({
      ok: false,
      code: 'STEP_UP_REQUIRED',
      message: 'Confirm your password',
    });
    render(
      <EnvironmentComparison
        workspaceId={IDS.workspaceId}
        projectId={IDS.projectId}
        environments={environments}
        initial={comparison()}
        sourceId={SOURCE}
        targetId={TARGET}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Compare values' }));
    expect(actions.compareEnvironmentsAction).toHaveBeenCalledWith(
      IDS.workspaceId,
      IDS.projectId,
      expect.objectContaining({ compareValues: true, sourceEnvironmentId: SOURCE }),
    );
    expect(await screen.findByRole('dialog', { name: 'Confirm your password' })).toBeVisible();
  });
});

describe('DriftReport', () => {
  const diff = (
    valuesCompared: boolean,
    value: SnapshotDiff['items'][number]['value'],
  ): SnapshotDiff => ({
    fromSnapshotId: SNAPSHOT,
    toSnapshotId: null,
    valuesCompared,
    summary: { added: 0, removed: 0, modified: 1, unchanged: 0, versionChanged: 1 },
    items: [
      {
        key: 'API_URL',
        change: 'modified',
        fields: [],
        versionChanged: true,
        value,
        from: meta(),
        to: meta({ version: 2 }),
      },
    ],
  });

  it('does not treat a new version as a changed value', () => {
    render(<DriftReport diff={diff(false, 'not_checked')} />);
    expect(screen.getByText('Different version (value not compared)')).toBeVisible();
    expect(screen.queryByText('Value differs')).toBeNull();
  });

  it('reports a same value under a new version when values were compared', () => {
    render(<DriftReport diff={diff(true, 'equal')} />);
    expect(screen.getByText('New version, same value')).toBeVisible();
  });
});

describe('ReadinessReport', () => {
  const report: Report = {
    environmentId: IDS.environmentId,
    status: 'UNKNOWN',
    evaluatedAt: '2026-10-21T10:00:00.000Z',
    valuesInspected: false,
    coverage: { required: 2, present: 2 },
    counts: { blocking: 0, warning: 0, unknown: 1 },
    checks: [
      { name: 'Required variables', outcome: 'passed', detail: '2 of 2 present' },
      { name: 'Value rules', outcome: 'skipped', detail: 'Values were not inspected' },
    ],
    issues: [
      {
        severity: 'unknown',
        code: 'VALUES_NOT_INSPECTED',
        key: 'API_URL',
        message: 'Has a URL rule that was not checked',
        remediation: 'Run the check with values',
      },
    ],
  };

  it('labels skipped checks as not checked and hides value inspection without read access', () => {
    render(<ReadinessReport {...IDS} initial={report} canInspectValues={false} />);
    expect(screen.getByTestId('readiness-status')).toHaveTextContent('Unknown');
    expect(screen.getAllByText('Not checked').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Check values too' })).toBeNull();
  });

  it('asks the server to inspect values on request', async () => {
    const user = userEvent.setup();
    actions.evaluateReadinessAction.mockResolvedValueOnce({
      ok: true,
      data: {
        ...report,
        status: 'READY',
        valuesInspected: true,
        issues: [],
        counts: { blocking: 0, warning: 0, unknown: 0 },
      },
    });
    render(<ReadinessReport {...IDS} initial={report} canInspectValues />);
    await user.click(screen.getByRole('button', { name: 'Check values too' }));
    expect(actions.evaluateReadinessAction).toHaveBeenCalledWith(
      IDS.workspaceId,
      IDS.projectId,
      IDS.environmentId,
      { inspectValues: true },
    );
    expect(await screen.findByText('Ready')).toBeVisible();
  });
});

describe('SnapshotRestoreDialog', () => {
  const preview = (overrides: Partial<RestorePreview> = {}): RestorePreview => ({
    snapshotId: SNAPSHOT,
    actions: [
      {
        secretId: '0199f000-0000-7000-8000-000000000001',
        key: 'API_URL',
        action: 'update',
        fields: [],
        restoresValue: true,
      },
    ],
    conflicts: [],
    warnings: [],
    expectedState: [{ id: '0199f000-0000-7000-8000-000000000001', revision: 4 }],
    counts: { update: 1, undelete: 0, delete: 0, unchanged: 0, valueRestores: 1 },
    requiresStepUp: false,
    ...overrides,
  });

  it('blocks the restore while conflicts exist', async () => {
    actions.previewRestoreAction.mockResolvedValueOnce({
      ok: true,
      data: preview({
        conflicts: [{ key: 'API_URL', reason: 'The name is used by another variable' }],
      }),
    });
    render(
      <SnapshotRestoreDialog
        open
        onOpenChange={vi.fn()}
        ids={IDS}
        snapshotId={SNAPSHOT}
        onRestored={vi.fn()}
      />,
    );
    expect(await screen.findByText(/The restore is blocked/)).toBeVisible();
    expect(screen.getByTestId('confirm-restore')).toBeDisabled();
  });

  it('sends the previewed state back and rebuilds the preview when it is stale', async () => {
    const user = userEvent.setup();
    actions.previewRestoreAction.mockResolvedValue({ ok: true, data: preview() });
    actions.restoreSnapshotAction.mockResolvedValueOnce({
      ok: false,
      code: 'SNAPSHOT_STALE',
      message: 'The environment changed since the preview.',
    });
    render(
      <SnapshotRestoreDialog
        open
        onOpenChange={vi.fn()}
        ids={IDS}
        snapshotId={SNAPSHOT}
        onRestored={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Restore 1 changes' }));
    expect(actions.restoreSnapshotAction).toHaveBeenCalledWith(
      IDS.workspaceId,
      IDS.projectId,
      IDS.environmentId,
      SNAPSHOT,
      { expectedState: preview().expectedState, removeAdded: true },
    );
    await waitFor(() => {
      expect(actions.previewRestoreAction).toHaveBeenCalledTimes(2);
    });
  });
});

describe('ValidationRulesEditor', () => {
  it('rejects an unsafe pattern before saving', async () => {
    const user = userEvent.setup();
    render(<ValidationRulesEditor ids={IDS} initial={[]} canEdit />);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Variable/), 'API_URL');
    await user.type(within(dialog).getByLabelText(/Pattern/), '(a+)+$');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(
      within(dialog).getByText('A repeated group cannot contain repetition or alternatives'),
    ).toBeVisible();
    expect(actions.replaceValidationRulesAction).not.toHaveBeenCalled();
  });

  it('saves the whole rule set', async () => {
    const user = userEvent.setup();
    actions.replaceValidationRulesAction.mockResolvedValueOnce({
      ok: true,
      data: [],
      message: 'Validation rules saved.',
    });
    render(<ValidationRulesEditor ids={IDS} initial={[]} canEdit />);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Variable/), 'API_URL');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(actions.replaceValidationRulesAction).toHaveBeenCalledWith(
      IDS.workspaceId,
      IDS.projectId,
      IDS.environmentId,
      { rules: [expect.objectContaining({ key: 'API_URL', required: true, allowEmpty: false })] },
    );
  });
});

describe('InheritedVariables', () => {
  const configuration = (state: 'ok' | 'no_access'): EffectiveConfiguration => ({
    environmentId: IDS.environmentId,
    base: { ...ref(TARGET, 'Shared'), state },
    items:
      state === 'ok'
        ? [
            {
              key: 'LOG_LEVEL',
              source: 'inherited',
              overridesInherited: false,
              meta: meta({ key: 'LOG_LEVEL', type: 'STRING', inheritable: true }),
              environmentId: TARGET,
            },
            {
              key: 'API_URL',
              source: 'local',
              overridesInherited: true,
              meta: meta(),
              environmentId: IDS.environmentId,
            },
          ]
        : [],
    summary: { local: 1, inherited: state === 'ok' ? 1 : 0, overridden: state === 'ok' ? 1 : 0 },
  });

  it('lists inherited variables with their source and an override action', () => {
    render(
      <InheritedVariables
        ids={IDS}
        configuration={configuration('ok')}
        baseHref="/base"
        canOverride
        knownKeys={[]}
      />,
    );
    const rows = screen.getAllByTestId('inherited-row');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (!row) throw new Error('expected a row');
    expect(within(row).getByText('LOG_LEVEL')).toBeVisible();
    expect(within(row).getByText('Inherited from Shared')).toBeVisible();
    expect(within(row).getByRole('button', { name: 'Override' })).toBeVisible();
  });

  it('hides the base name when the caller cannot read it', () => {
    render(
      <InheritedVariables
        ids={IDS}
        configuration={configuration('no_access')}
        baseHref="/base"
        canOverride
        knownKeys={[]}
      />,
    );
    expect(screen.queryByText(/Shared/)).toBeNull();
    expect(screen.getByText(/Restricted environment/)).toBeVisible();
  });
});

describe('VariableDialog inheritable switch', () => {
  it('is disabled for secret variables', async () => {
    const user = userEvent.setup();
    render(<VariableDialog {...IDS} open onOpenChange={vi.fn()} knownKeys={[]} categories={[]} />);
    const inheritable = screen.getByRole('switch', { name: /Inheritable/ });
    expect(inheritable).toBeDisabled();
    await user.selectOptions(screen.getByLabelText(/^Type/), 'STRING');
    expect(screen.getByRole('switch', { name: /Inheritable/ })).toBeEnabled();
  });
});
