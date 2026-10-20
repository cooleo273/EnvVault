import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS } from './permissions.js';
import { SYSTEM_ROLES } from './roles.js';

const PERMISSION_KEY_FORMAT = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;
const ROLE_KEY_FORMAT = /^[a-z][a-z0-9_-]{0,63}$/;

function roleByKey(key: string) {
  const role = SYSTEM_ROLES.find((r) => r.key === key);
  if (!role) throw new Error(`missing role ${key}`);
  return role;
}

describe('permission and role catalog', () => {
  it('uses keys accepted by the database CHECK constraints', () => {
    for (const key of PERMISSION_KEYS) expect(key).toMatch(PERMISSION_KEY_FORMAT);
    for (const role of SYSTEM_ROLES) expect(role.key).toMatch(ROLE_KEY_FORMAT);
  });

  it('has unique role keys that only reference known permissions', () => {
    expect(new Set(SYSTEM_ROLES.map((r) => r.key)).size).toBe(SYSTEM_ROLES.length);
    for (const role of SYSTEM_ROLES) {
      for (const permission of role.permissions) expect(PERMISSION_KEYS).toContain(permission);
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });

  it('reserves archive, deletion and ownership transfer for owners', () => {
    for (const key of ['workspace:archive', 'workspace:delete', 'workspace:transfer'] as const) {
      expect(roleByKey('owner').permissions).toContain(key);
      for (const other of ['admin', 'member', 'viewer']) {
        expect(roleByKey(other).permissions).not.toContain(key);
      }
    }
    expect(roleByKey('admin').permissions).toEqual(
      expect.arrayContaining(['workspace:update', 'member:invite', 'member:manage']),
    );
  });

  it('never grants secret values, deployment or change approval through workspace roles', () => {
    for (const key of ['owner', 'admin', 'member', 'viewer']) {
      for (const permission of roleByKey(key).permissions) {
        expect(permission).not.toMatch(/^(secret|change_request):|^environment:deploy$/);
      }
    }
  });

  it('lets workspace owners and admins administer projects, and members create them', () => {
    for (const key of ['owner', 'admin']) {
      expect(roleByKey(key).permissions).toEqual(
        expect.arrayContaining(['project:read', 'project_member:manage', 'environment:protect']),
      );
    }
    expect(roleByKey('member').permissions).toContain('project:create');
    expect(roleByKey('member').permissions).not.toContain('project:read');
    expect(roleByKey('viewer').permissions).not.toContain('project:create');
  });

  it('defines the four project roles with least privilege', () => {
    const scoped = SYSTEM_ROLES.filter((r) => r.scope === 'PROJECT').map((r) => r.name);
    expect(scoped).toEqual(['Project Admin', 'Developer', 'Viewer', 'Deployment Operator']);
    for (const key of ['project-developer', 'project-viewer', 'project-deployer']) {
      const permissions = roleByKey(key).permissions;
      for (const admin of ['project:update', 'project_member:manage', 'environment:protect']) {
        expect(permissions).not.toContain(admin);
      }
    }
    expect(roleByKey('project-deployer').permissions).not.toContain('secret:read');
  });

  it('separates listing secrets from reading their values', () => {
    for (const key of ['member', 'project-viewer', 'environment-approver']) {
      expect(roleByKey(key).permissions).not.toContain('secret:read');
    }
    expect(roleByKey('project-viewer').permissions).toContain('secret:list');
    expect(roleByKey('environment-reader').permissions).toContain('secret:read');
  });

  it('keeps approvers from approving with write access', () => {
    expect(roleByKey('environment-approver').permissions).not.toContain('secret:write');
  });
});
