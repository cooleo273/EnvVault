import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkOutputPath } from '../commands/pull.js';
import { CliError } from '../errors.js';

describe('pull output path', () => {
  const root = '/work/app';

  it('accepts files inside the project', () => {
    expect(checkOutputPath(root, root, '.env.local', posix)).toBe('/work/app/.env.local');
    expect(checkOutputPath(root, '/work/app/packages/api', '.env', posix)).toBe(
      '/work/app/packages/api/.env',
    );
  });

  it('refuses files outside the project', () => {
    expect(() => checkOutputPath(root, root, '../.env', posix)).toThrow(CliError);
    expect(() => checkOutputPath(root, root, '/etc/envvault.env', posix)).toThrow(CliError);
    expect(() => checkOutputPath(root, root, '.', posix)).toThrow(CliError);
  });

  it('refuses published and shipped directories', () => {
    for (const dir of [
      'public',
      'static',
      'www',
      'dist',
      'build',
      'out',
      '.next',
      'node_modules',
      'Public',
    ]) {
      expect(() => checkOutputPath(root, root, `${dir}/.env`, posix)).toThrow(
        /published or shipped/,
      );
    }
    expect(() => checkOutputPath(root, root, 'apps/web/public/.env', posix)).toThrow(CliError);
  });

  it('applies the same rules to Windows paths', () => {
    const winRoot = 'C:\\work\\app';
    expect(checkOutputPath(winRoot, winRoot, '.env.local', win32)).toBe(
      'C:\\work\\app\\.env.local',
    );
    expect(() => checkOutputPath(winRoot, winRoot, '..\\.env', win32)).toThrow(CliError);
    expect(() => checkOutputPath(winRoot, winRoot, 'D:\\other\\.env', win32)).toThrow(CliError);
    expect(() => checkOutputPath(winRoot, winRoot, 'public\\.env', win32)).toThrow(CliError);
  });
});
