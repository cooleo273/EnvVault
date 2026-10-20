import { describe, expect, it } from 'vitest';
import { activeNavHref } from './navigation';

const WS = '/workspaces/0199f000-0000-7000-8000-00000000000a';

describe('activeNavHref', () => {
  it('highlights the section shortcut inside a workspace', () => {
    expect(activeNavHref(`${WS}/projects`)).toBe('/projects');
    expect(activeNavHref(`${WS}/projects/abc/environments/def/settings`)).toBe('/projects');
    expect(activeNavHref(`${WS}/members`)).toBe('/members');
  });

  it('falls back to path prefixes elsewhere', () => {
    expect(activeNavHref(WS)).toBe('/workspaces');
    expect(activeNavHref(`${WS}/settings`)).toBe('/workspaces');
    expect(activeNavHref('/settings/security')).toBe('/settings');
    expect(activeNavHref('/dashboard')).toBe('/dashboard');
    expect(activeNavHref('/workspaces/x/projectsy')).toBe('/workspaces');
    expect(activeNavHref('/unknown')).toBeUndefined();
  });
});
