import { describe, expect, it } from 'vitest';
import {
  type GithubClaims,
  type GithubTrustConditions,
  githubMismatch,
  protectedPolicyProblems,
  refMatches,
  workflowPathOf,
} from './oidc-policy.js';
import { createOidcTrustBindingInputSchema } from '../schemas/oidc.js';

const claims: GithubClaims = {
  sub: 'repo:octo-org/app:environment:production',
  repository: 'octo-org/app',
  repository_id: '123456',
  repository_owner: 'octo-org',
  repository_owner_id: '777',
  workflow_ref: 'octo-org/app/.github/workflows/deploy.yml@refs/heads/main',
  job_workflow_ref: 'octo-org/app/.github/workflows/deploy.yml@refs/heads/main',
  ref: 'refs/heads/main',
  event_name: 'push',
  environment: 'production',
};

const strict: GithubTrustConditions = {
  repositoryId: '123456',
  repositoryOwnerId: '777',
  workflowPath: '.github/workflows/deploy.yml',
  jobWorkflowRef: null,
  refs: ['refs/heads/main'],
  githubEnvironments: ['Production'],
  eventNames: ['push', 'workflow_dispatch'],
  subject: null,
};

describe('githubMismatch', () => {
  it('accepts claims that meet every condition', () => {
    expect(githubMismatch(strict, claims)).toBeNull();
  });

  it('decides by repository and owner ids, not names', () => {
    // A renamed repository keeps its id; a new repository with the old name gets a new one.
    expect(
      githubMismatch(strict, {
        ...claims,
        repository: 'octo-org/renamed',
        workflow_ref: 'octo-org/renamed/.github/workflows/deploy.yml@refs/heads/main',
      }),
    ).toBeNull();
    expect(githubMismatch(strict, { ...claims, repository_id: '999' })).toBe('repository');
    expect(githubMismatch(strict, { ...claims, repository_owner_id: '1' })).toBe(
      'repository_owner',
    );
  });

  it('refuses pull requests unless the binding names the event, and never pull_request_target', () => {
    const open = {
      ...strict,
      eventNames: [],
      refs: [],
      githubEnvironments: [],
      workflowPath: null,
    };
    expect(githubMismatch(open, { ...claims, event_name: 'pull_request' })).toBe('pull_request');
    expect(
      githubMismatch(
        { ...open, eventNames: ['pull_request'] },
        { ...claims, event_name: 'pull_request', environment: undefined },
      ),
    ).toBeNull();
    expect(
      githubMismatch(
        { ...open, eventNames: ['pull_request_target'] },
        { ...claims, event_name: 'pull_request_target' },
      ),
    ).toBe('pull_request');
  });

  it('checks event, workflow, reusable workflow, ref, environment and subject', () => {
    expect(githubMismatch(strict, { ...claims, event_name: 'schedule' })).toBe('event');
    expect(
      githubMismatch(strict, {
        ...claims,
        workflow_ref: 'octo-org/app/.github/workflows/other.yml@refs/heads/main',
      }),
    ).toBe('workflow');
    expect(
      githubMismatch(
        { ...strict, jobWorkflowRef: 'octo-org/shared/.github/workflows/deploy.yml@abc123' },
        claims,
      ),
    ).toBe('job_workflow');
    expect(githubMismatch(strict, { ...claims, ref: 'refs/heads/feature' })).toBe('ref');
    expect(githubMismatch(strict, { ...claims, environment: 'staging' })).toBe('environment');
    expect(githubMismatch(strict, { ...claims, environment: undefined })).toBe('environment');
    expect(
      githubMismatch({ ...strict, subject: 'repo:octo-org/app:ref:refs/heads/main' }, claims),
    ).toBe('subject');
  });

  it('does not let another repository substitute its workflow', () => {
    // workflow_ref from a different repository than the token's own never yields a path.
    expect(
      workflowPathOf({
        repository: 'octo-org/app',
        workflow_ref: 'evil/app/.github/workflows/deploy.yml@refs/heads/main',
      }),
    ).toBeNull();
    expect(
      githubMismatch(strict, {
        ...claims,
        workflow_ref: 'evil/app/.github/workflows/deploy.yml@refs/heads/main',
      }),
    ).toBe('workflow');
  });

  it('matches environments case insensitively, as GitHub does', () => {
    expect(githubMismatch(strict, { ...claims, environment: 'PRODUCTION' })).toBeNull();
  });
});

describe('refMatches', () => {
  it('matches exactly, or by prefix with a trailing *', () => {
    expect(refMatches('refs/heads/main', 'refs/heads/main')).toBe(true);
    expect(refMatches('refs/heads/main', 'refs/heads/main2')).toBe(false);
    expect(refMatches('refs/tags/v*', 'refs/tags/v1.2.0')).toBe(true);
    expect(refMatches('refs/tags/v*', 'refs/heads/v1')).toBe(false);
  });
});

describe('protectedPolicyProblems', () => {
  it('accepts a binding pinned to events and a branch or GitHub environment', () => {
    expect(protectedPolicyProblems(strict)).toEqual([]);
    expect(
      protectedPolicyProblems({
        refs: [],
        githubEnvironments: ['production'],
        eventNames: ['push'],
      }),
    ).toEqual([]);
  });

  it('refuses open, pull request and wildcard only bindings', () => {
    expect(
      protectedPolicyProblems({ refs: [], githubEnvironments: [], eventNames: [] }),
    ).toHaveLength(2);
    expect(
      protectedPolicyProblems({ ...strict, eventNames: ['push', 'pull_request'] }),
    ).toHaveLength(1);
    expect(protectedPolicyProblems({ ...strict, refs: ['refs/pull/1/merge'] })).toHaveLength(1);
    expect(
      protectedPolicyProblems({
        refs: ['refs/heads/*'],
        githubEnvironments: [],
        eventNames: ['push'],
      }),
    ).toHaveLength(1);
  });
});

describe('createOidcTrustBindingInputSchema', () => {
  const base = {
    identityId: '0190f5a0-0000-7000-8000-000000000001',
    name: 'Deploy',
    audience: 'https://api.envvault.example',
    repositoryId: '123456',
    repositoryOwnerId: '777',
    repositoryName: 'octo-org/app',
    environmentIds: ['0190f5a0-0000-7000-8000-000000000002'],
  };

  it('defaults scopes and lifetime', () => {
    const parsed = createOidcTrustBindingInputSchema.parse(base);
    expect(parsed.scopes).toEqual(['environment:read', 'secret:list', 'secret:runtime']);
    expect(parsed.expiresInDays).toBe(365);
  });

  it('rejects pull_request_target, malformed ids, refs and workflow paths', () => {
    for (const bad of [
      { eventNames: ['pull_request_target'] },
      { repositoryId: 'octo-org/app' },
      { refs: ['main'] },
      { refs: ['refs/heads/*/x*'] },
      { workflowPath: '../deploy.yml' },
      { audience: 'has space' },
      { environmentIds: [] },
    ]) {
      expect(
        createOidcTrustBindingInputSchema.safeParse({ ...base, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});
