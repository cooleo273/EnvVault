import { describe, expect, it } from 'vitest';
import {
  canModifyEnvironment,
  DATA_PLANE_PERMISSIONS,
  evaluateEnvironmentPermissions,
  evaluateMachinePermissions,
  evaluateProjectAccess,
  isMachineGrantable,
  MACHINE_PERMISSIONS,
} from './access.js';

const OWNER = [
  'workspace:read',
  'project:create',
  'project:read',
  'project:update',
  'environment:read',
  'environment:update',
  'environment:protect',
  'member:manage',
];
const MEMBER = ['workspace:read', 'project:create'];
const DEVELOPER = [
  'project:read',
  'environment:read',
  'secret:list',
  'secret:read',
  'secret:write',
];

describe('evaluateProjectAccess', () => {
  it('denies by default: workspace members without project membership see nothing', () => {
    const access = evaluateProjectAccess({
      workspacePermissions: MEMBER,
      projectRolePermissions: null,
    });
    expect(access).toMatchObject({ hasAccess: false, source: 'none' });
    expect(access.permissions.size).toBe(0);
  });

  it('lets workspace owners administer every project without secret permissions', () => {
    const access = evaluateProjectAccess({
      workspacePermissions: OWNER,
      projectRolePermissions: null,
    });
    expect(access.source).toBe('workspace_role');
    expect(access.permissions.has('project:update')).toBe(true);
    // Workspace-only permissions are not carried into the project.
    expect(access.permissions.has('member:manage')).toBe(false);
    expect([...access.permissions].some((p) => p.startsWith('secret:'))).toBe(false);
  });

  it('combines workspace and project role permissions', () => {
    const access = evaluateProjectAccess({
      workspacePermissions: MEMBER,
      projectRolePermissions: DEVELOPER,
    });
    expect(access.source).toBe('project_member');
    expect([...access.permissions].sort()).toEqual([...DEVELOPER].sort());
  });
});

describe('evaluateEnvironmentPermissions', () => {
  const project = new Set(DEVELOPER);

  it('inherits project permissions into unprotected environments', () => {
    const env = evaluateEnvironmentPermissions({
      projectPermissions: project,
      isProtected: false,
      grants: [],
    });
    expect(env.has('secret:read')).toBe(true);
    // Project-only permissions are not environment permissions.
    expect(env.has('project:read')).toBe(false);
  });

  it('never inherits data-plane permissions into protected environments', () => {
    const env = evaluateEnvironmentPermissions({
      projectPermissions: project,
      isProtected: true,
      grants: [],
    });
    for (const key of DATA_PLANE_PERMISSIONS) expect(env.has(key)).toBe(false);
    expect(env.has('environment:read')).toBe(true);
    expect(env.has('secret:list')).toBe(true);
  });

  it('adds explicit ALLOW grants, including on protected environments', () => {
    const env = evaluateEnvironmentPermissions({
      projectPermissions: project,
      isProtected: true,
      grants: [{ effect: 'ALLOW', permissions: ['environment:deploy', 'project:delete'] }],
    });
    expect(env.has('environment:deploy')).toBe(true);
    // Grants cannot smuggle in non-environment permissions.
    expect(env.has('project:delete')).toBe(false);
  });

  it('lets DENY win over inheritance and ALLOW grants', () => {
    const env = evaluateEnvironmentPermissions({
      projectPermissions: project,
      isProtected: false,
      grants: [
        { effect: 'ALLOW', permissions: ['environment:update'] },
        { effect: 'DENY', permissions: ['environment:read', 'environment:update', 'secret:read'] },
      ],
    });
    expect([...env].sort()).toEqual(['secret:list', 'secret:write']);
  });

  it('ignores expired grants', () => {
    const env = evaluateEnvironmentPermissions({
      projectPermissions: new Set(),
      isProtected: false,
      now: new Date('2026-10-20T12:00:00Z'),
      grants: [
        {
          effect: 'ALLOW',
          permissions: ['environment:read'],
          expiresAt: new Date('2026-10-20T11:00:00Z'),
        },
        {
          effect: 'DENY',
          permissions: ['environment:read'],
          expiresAt: new Date('2026-10-20T11:00:00Z'),
        },
      ],
    });
    expect(env.size).toBe(0);
  });

  it('requires environment:protect to modify protected environments', () => {
    const editor = new Set(['environment:update']);
    expect(canModifyEnvironment(editor, 'environment:update', false)).toBe(true);
    expect(canModifyEnvironment(editor, 'environment:update', true)).toBe(false);
    expect(
      canModifyEnvironment(
        new Set(['environment:update', 'environment:protect']),
        'environment:update',
        true,
      ),
    ).toBe(true);
  });
});

describe('evaluateMachinePermissions', () => {
  const runtime = ['environment:read', 'secret:list', 'secret:runtime'];
  const all = ['environment:read', 'secret:list', 'secret:runtime'];

  it('grants nothing without an ALLOW grant', () => {
    expect(evaluateMachinePermissions({ grants: [], scopes: all })).toEqual(new Set());
  });

  it('is the intersection of grants and token scopes', () => {
    const result = evaluateMachinePermissions({
      grants: [{ effect: 'ALLOW', permissions: runtime }],
      scopes: ['environment:read'],
    });
    expect(result).toEqual(new Set(['environment:read']));
  });

  it('never yields permissions outside the machine set, whatever the role holds', () => {
    const result = evaluateMachinePermissions({
      grants: [
        {
          effect: 'ALLOW',
          permissions: ['secret:read', 'secret:write', 'secret:export', ...runtime],
        },
      ],
      scopes: [...all, 'secret:read', 'secret:export'],
    });
    expect(result).toEqual(new Set(runtime));
    for (const key of result) expect(MACHINE_PERMISSIONS.has(key as never)).toBe(true);
  });

  it('lets DENY win and ignores expired grants', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const result = evaluateMachinePermissions({
      now,
      scopes: all,
      grants: [
        { effect: 'ALLOW', permissions: runtime },
        { effect: 'DENY', permissions: ['secret:runtime'] },
        { effect: 'ALLOW', permissions: runtime, expiresAt: new Date('2026-09-01T00:00:00Z') },
      ],
    });
    expect(result).toEqual(new Set(['environment:read', 'secret:list']));
    const expired = evaluateMachinePermissions({
      now,
      scopes: all,
      grants: [
        { effect: 'ALLOW', permissions: runtime, expiresAt: new Date('2026-09-01T00:00:00Z') },
      ],
    });
    expect(expired).toEqual(new Set());
  });

  it('accepts only roles made of machine permissions', () => {
    expect(isMachineGrantable(runtime)).toBe(true);
    expect(isMachineGrantable(['environment:read'])).toBe(true);
    expect(isMachineGrantable([...runtime, 'secret:read'])).toBe(false);
    expect(isMachineGrantable([])).toBe(false);
  });
});
