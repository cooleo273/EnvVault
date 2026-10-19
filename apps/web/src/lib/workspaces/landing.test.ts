import { describe, expect, it } from 'vitest';
import { resolveLanding, workspaceIdFromPath } from './landing';

const ws = (id: string) => ({
  id,
  name: id,
  slug: id,
  description: null,
  type: 'TEAM' as const,
  archivedAt: null,
  role: { key: 'owner', name: 'Owner' },
  createdAt: '2026-10-19T00:00:00.000Z',
});

const A = '0199f000-0000-7000-8000-00000000000a';
const B = '0199f000-0000-7000-8000-00000000000b';

describe('resolveLanding (onboarding redirect logic)', () => {
  it('sends users without a workspace to onboarding', () => {
    expect(resolveLanding({ workspaces: [], activeWorkspaceId: null })).toEqual({
      kind: 'onboarding',
    });
  });

  it('opens the only workspace', () => {
    expect(resolveLanding({ workspaces: [ws(A)], activeWorkspaceId: null })).toMatchObject({
      workspaceId: A,
      href: `/workspaces/${A}`,
    });
  });

  it('restores the remembered workspace among several', () => {
    expect(resolveLanding({ workspaces: [ws(A), ws(B)], activeWorkspaceId: B })).toMatchObject({
      workspaceId: B,
    });
  });

  it('falls back to an accessible workspace when the remembered one was revoked', () => {
    expect(resolveLanding({ workspaces: [ws(A)], activeWorkspaceId: B })).toMatchObject({
      workspaceId: A,
    });
    expect(resolveLanding({ workspaces: [], activeWorkspaceId: B })).toEqual({
      kind: 'onboarding',
    });
  });
});

describe('workspaceIdFromPath', () => {
  it('extracts workspace ids from app paths only', () => {
    expect(workspaceIdFromPath(`/workspaces/${A}`)).toBe(A);
    expect(workspaceIdFromPath(`/workspaces/${A}/members`)).toBe(A);
    expect(workspaceIdFromPath('/workspaces/new')).toBeUndefined();
    expect(workspaceIdFromPath(`/workspacesx/${A}`)).toBeUndefined();
    expect(workspaceIdFromPath(`/workspaces/${A}extra`)).toBeUndefined();
  });
});
