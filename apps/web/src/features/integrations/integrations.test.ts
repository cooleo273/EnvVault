import { EnvVaultApiError } from '@envvault/sdk';
import type { OidcTrustBinding } from '@envvault/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_PLACEHOLDER, exampleWorkflow } from './workflow';

const api = vi.hoisted(() => ({
  createOidcTrustBinding: vi.fn(),
  disableOidcTrustBinding: vi.fn(),
  enableOidcTrustBinding: vi.fn(),
  deleteOidcTrustBinding: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock('@/lib/api/server-api', async () => {
  const { EnvVaultApiError: ApiError } = await import('@envvault/sdk');
  return {
    withApi: (call: (client: typeof api) => Promise<unknown>) => call(api),
    isApiError: (error: unknown, code?: string) =>
      error instanceof ApiError && (code === undefined || error.code === code),
  };
});

const actions = await import('./actions');

const W = '0199f000-0000-7000-8000-00000000000a';
const P = '0199f000-0000-7000-8000-00000000000b';
const I = '0199f000-0000-7000-8000-00000000000c';
const E = '0199f000-0000-7000-8000-00000000000d';
const B = '0199f000-0000-7000-8000-00000000000e';

const binding: OidcTrustBinding = {
  id: B,
  name: 'Deploy',
  provider: 'github',
  identity: { id: I, name: 'deploy' },
  issuer: 'https://token.actions.githubusercontent.com',
  audience: 'https://api.envvault.example',
  scopes: ['environment:read', 'secret:runtime'],
  repository: { id: '1', ownerId: '2', name: 'octo-org/app' },
  workflowPath: '.github/workflows/deploy.yml',
  jobWorkflowRef: null,
  refs: ['refs/heads/main', 'refs/tags/v*'],
  githubEnvironments: ['production'],
  eventNames: ['push', 'workflow_dispatch'],
  subject: null,
  environments: [{ id: E, name: 'Production', slug: 'production', isProtected: true }],
  status: 'ACTIVE',
  expiresAt: '2027-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: null,
  disabledAt: null,
  lastUsedAt: null,
  revokedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('example workflow', () => {
  it('requests id-token write, mirrors the binding and holds no credential', () => {
    const yaml = exampleWorkflow(binding, {
      apiUrl: 'https://api.envvault.example',
      projectId: P,
      command: 'npm run deploy',
    });
    expect(yaml).toContain('  id-token: write');
    expect(yaml).toContain('  contents: read');
    expect(yaml).toContain('    branches: [main]');
    expect(yaml).toContain('    tags: [v*]');
    expect(yaml).toContain('  workflow_dispatch:');
    expect(yaml).toContain('    environment: production');
    expect(yaml).toContain(`binding-id: ${B}`);
    expect(yaml).toContain(`uses: ${ACTION_PLACEHOLDER}`);
    expect(yaml).not.toContain('audience:');
    expect(yaml).not.toMatch(/evv_|secrets\.|service-credential/);
    expect(yaml).not.toContain('pull_request');
  });

  it('quotes values YAML would misread', () => {
    const yaml = exampleWorkflow(
      { ...binding, githubEnvironments: ['prod: eu'], audience: 'custom aud' },
      { apiUrl: 'https://api.envvault.example', projectId: P, command: 'make "deploy" && echo #' },
    );
    expect(yaml).toContain('environment: "prod: eu"');
    expect(yaml).toContain('audience: "custom aud"');
    expect(yaml).toContain('command: "make \\"deploy\\" && echo #"');
  });
});

describe('trust binding actions', () => {
  it('validates ids and input before calling the API', async () => {
    expect((await actions.createTrustBindingAction('nope', P, {})).ok).toBe(false);
    const bad = await actions.createTrustBindingAction(W, P, {
      identityId: I,
      name: 'x',
      audience: 'a',
      repositoryId: 'octo-org/app',
      repositoryOwnerId: '2',
      repositoryName: 'octo-org/app',
      environmentIds: [E],
      eventNames: ['pull_request_target'],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(Object.keys(bad.fieldErrors ?? {})).toEqual(
        expect.arrayContaining(['repositoryId', 'eventNames']),
      );
    expect((await actions.setTrustBindingEnabledAction(W, P, B, 'yes')).ok).toBe(false);
    expect(api.createOidcTrustBinding).not.toHaveBeenCalled();
    expect(api.enableOidcTrustBinding).not.toHaveBeenCalled();
  });

  it('passes the API refusal through, including step up', async () => {
    api.enableOidcTrustBinding.mockRejectedValue(
      new EnvVaultApiError(403, {
        statusCode: 403,
        code: 'STEP_UP_REQUIRED',
        message: 'Confirm your password to continue',
      }),
    );
    const result = await actions.setTrustBindingEnabledAction(W, P, B, true);
    expect(result).toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED' });
    api.disableOidcTrustBinding.mockResolvedValue(binding);
    expect((await actions.setTrustBindingEnabledAction(W, P, B, false)).ok).toBe(true);
  });
});
