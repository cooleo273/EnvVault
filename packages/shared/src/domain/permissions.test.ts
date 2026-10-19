import { describe, expect, it } from 'vitest';
import {
  isPermissionKey,
  isSensitivePermission,
  PERMISSION_KEYS,
  SENSITIVE_PERMISSIONS,
} from './permissions.js';

describe('permission catalog', () => {
  it('uses resource:action keys', () => {
    for (const key of PERMISSION_KEYS) expect(key).toMatch(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
  });

  it('only marks known permissions as sensitive', () => {
    for (const key of SENSITIVE_PERMISSIONS) expect(PERMISSION_KEYS).toContain(key);
  });

  it('treats reading values as sensitive but listing keys as not', () => {
    expect(isSensitivePermission('secret:read')).toBe(true);
    expect(isSensitivePermission('secret:list')).toBe(false);
  });

  it('narrows unknown strings', () => {
    expect(isPermissionKey('secret:read')).toBe(true);
    expect(isPermissionKey('secret:steal')).toBe(false);
    expect(isPermissionKey('toString')).toBe(false);
  });
});
