import type { ManagedVariableRecord } from '@envvault/database';
import { describe, expect, it } from 'vitest';
import { decide, type MappingSlot, planSync, type SourceVariable } from './sync-plan.js';
import type { VercelVariable } from './vercel-client.js';

const preview: MappingSlot = { target: 'PREVIEW', gitBranch: null, customEnvironmentId: null };
const source = (key: string, versionId = `${key}-v1`, type = 'STRING'): SourceVariable => ({
  secretId: `${key}-id`,
  key,
  versionId,
  type,
});
const remote = (key: string, overrides: Partial<VercelVariable> = {}): VercelVariable => ({
  id: `env_${key}`,
  key,
  target: ['preview'],
  gitBranch: null,
  customEnvironmentIds: [],
  type: 'encrypted',
  updatedAt: 1000,
  ...overrides,
});
const managed = (
  key: string,
  overrides: Partial<ManagedVariableRecord> = {},
): ManagedVariableRecord => ({
  key,
  providerVariableId: `env_${key}`,
  providerUpdatedAt: 1000n,
  secretVersionId: `${key}-v1`,
  ...overrides,
});

const actions = (plan: ReturnType<typeof planSync>) =>
  Object.fromEntries(
    plan.items.map((i) => [i.key, i.conflict ? `${i.action}:${i.conflict}` : i.action]),
  );

describe('planSync', () => {
  it('creates, updates, keeps and removes only what EnvVault manages', () => {
    const plan = planSync(
      preview,
      [source('NEW'), source('CHANGED', 'CHANGED-v2'), source('SAME')],
      [remote('CHANGED'), remote('SAME'), remote('GONE'), remote('UNRELATED')],
      [managed('CHANGED'), managed('SAME'), managed('GONE')],
    );
    expect(actions(plan)).toEqual({
      NEW: 'create',
      CHANGED: 'update',
      SAME: 'unchanged',
      GONE: 'remove',
    });
    expect(plan.unrelated).toBe(1);
  });

  it('never touches unmanaged or shared variables without consent', () => {
    const plan = planSync(
      preview,
      [source('TAKEN'), source('SHARED'), source('EDITED')],
      [
        remote('TAKEN'),
        remote('SHARED', { target: ['preview', 'production'] }),
        remote('EDITED', { updatedAt: 2000 }),
      ],
      [managed('EDITED')],
    );
    expect(actions(plan)).toEqual({
      TAKEN: 'conflict:unmanaged',
      SHARED: 'conflict:shared_target',
      EDITED: 'conflict:changed_externally',
    });
    const none = decide(plan.items, { overwrite: false, removeManaged: false });
    expect(none.every((d) => d.operation === 'none')).toBe(true);
    const forced = decide(plan.items, { overwrite: true, removeManaged: false });
    expect(Object.fromEntries(forced.map((d) => [d.item.key, d.operation]))).toEqual({
      TAKEN: 'update',
      SHARED: 'none',
      EDITED: 'update',
    });
  });

  it('removes only with consent, and an edited one only with overwrite as well', () => {
    const plan = planSync(
      preview,
      [],
      [remote('OLD'), remote('EDITED', { updatedAt: 5 })],
      [managed('OLD'), managed('EDITED'), managed('VANISHED')],
    );
    expect(
      decide(plan.items, { overwrite: false, removeManaged: false }).map((d) => d.operation),
    ).toEqual(['none', 'none', 'none']);
    expect(
      Object.fromEntries(
        decide(plan.items, { overwrite: false, removeManaged: true }).map((d) => [
          d.item.key,
          d.operation,
        ]),
      ),
    ).toEqual({ OLD: 'delete', EDITED: 'none', VANISHED: 'forget' });
    expect(
      Object.fromEntries(
        decide(plan.items, { overwrite: true, removeManaged: true }).map((d) => [
          d.item.key,
          d.operation,
        ]),
      ),
    ).toEqual({ OLD: 'delete', EDITED: 'delete', VANISHED: 'forget' });
  });

  it('recreates a managed variable deleted in the provider', () => {
    expect(actions(planSync(preview, [source('A')], [], [managed('A')]))).toEqual({ A: 'create' });
  });

  it('matches Preview branches and custom environments exactly', () => {
    const branch: MappingSlot = {
      target: 'PREVIEW',
      gitBranch: 'staging',
      customEnvironmentId: null,
    };
    const plan = planSync(
      branch,
      [source('A')],
      [remote('A'), remote('A', { id: 'b', gitBranch: 'other' })],
      [],
    );
    expect(actions(plan)).toEqual({ A: 'create' });
    const custom: MappingSlot = {
      target: 'CUSTOM',
      gitBranch: null,
      customEnvironmentId: 'env_qa',
    };
    const customPlan = planSync(
      custom,
      [source('A')],
      [remote('A', { target: [], customEnvironmentIds: ['env_qa'] })],
      [],
    );
    expect(actions(customPlan)).toEqual({ A: 'conflict:unmanaged' });
  });

  it('marks secrets sensitive except in Development, and hashes the plan deterministically', () => {
    const prod: MappingSlot = { target: 'PRODUCTION', gitBranch: null, customEnvironmentId: null };
    const dev: MappingSlot = { target: 'DEVELOPMENT', gitBranch: null, customEnvironmentId: null };
    expect(planSync(prod, [source('S', 'v', 'SECRET')], [], []).items[0]?.sensitive).toBe(true);
    expect(planSync(dev, [source('S', 'v', 'SECRET')], [], []).items[0]?.sensitive).toBe(false);
    const a = planSync(prod, [source('A'), source('B')], [], []);
    const b = planSync(prod, [source('B'), source('A')], [], []);
    expect(a.hash).toBe(b.hash);
    expect(planSync(prod, [source('A', 'v2'), source('B')], [], []).hash).not.toBe(a.hash);
  });
});
