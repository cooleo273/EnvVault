import { describe, expect, it } from 'vitest';
import { createAuthorizedWorkspaceScope } from './scope.js';
import { assertSeedAllowed } from './seed/seed.js';

describe('createAuthorizedWorkspaceScope', () => {
  it('creates a frozen scope for a UUID', () => {
    const scope = createAuthorizedWorkspaceScope('0199d6a2-7c4e-7a3b-9f10-1234567890ab');
    expect(scope.workspaceId).toBe('0199d6a2-7c4e-7a3b-9f10-1234567890ab');
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it.each(['', 'acme', "1' OR '1'='1", '0199d6a2-7c4e-7a3b-9f10'])('rejects %j', (id) => {
    expect(() => createAuthorizedWorkspaceScope(id)).toThrow(/Invalid workspace id/);
  });
});

describe('assertSeedAllowed', () => {
  it('refuses to seed production', () => {
    expect(() => {
      assertSeedAllowed({ NODE_ENV: 'production' });
    }).toThrow(/production/);
    expect(() => {
      assertSeedAllowed({ NODE_ENV: 'development' });
    }).not.toThrow();
  });
});
