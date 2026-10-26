import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findProjectConfig,
  normalizeApiUrl,
  PROJECT_CONFIG_FILE,
  writeProjectConfig,
} from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { configDir } from '../paths.js';

const ids = {
  workspaceId: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c01',
  projectId: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c02',
  environmentId: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c03',
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'envvault-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function expectConfigError(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).exitCode).toBe(EXIT.config);
}

describe('project configuration', () => {
  it('is found from a nested directory', async () => {
    await writeProjectConfig(join(dir, PROJECT_CONFIG_FILE), { version: 1, ...ids });
    const nested = join(dir, 'apps', 'web');
    await mkdir(nested, { recursive: true });
    const found = await findProjectConfig(nested);
    expect(found?.path).toBe(join(dir, PROJECT_CONFIG_FILE));
    expect(found?.config).toEqual({ version: 1, ...ids });
  });

  it('holds ids only', async () => {
    await writeProjectConfig(join(dir, PROJECT_CONFIG_FILE), {
      version: 1,
      apiUrl: 'https://api.example.com',
      ...ids,
    });
    const text = await readFile(join(dir, PROJECT_CONFIG_FILE), 'utf8');
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      'apiUrl',
      'environmentId',
      'projectId',
      'version',
      'workspaceId',
    ]);
  });

  it('rejects unknown fields such as a token', async () => {
    await writeFile(
      join(dir, PROJECT_CONFIG_FILE),
      JSON.stringify({ version: 1, ...ids, accessToken: 'evv_at_x' }),
    );
    await expectConfigError(findProjectConfig(dir));
  });

  it('rejects invalid JSON, ids and versions', async () => {
    await writeFile(join(dir, PROJECT_CONFIG_FILE), '{ nope');
    await expectConfigError(findProjectConfig(dir));
    await writeFile(
      join(dir, PROJECT_CONFIG_FILE),
      JSON.stringify({ version: 1, ...ids, projectId: 'x' }),
    );
    await expectConfigError(findProjectConfig(dir));
    await writeFile(join(dir, PROJECT_CONFIG_FILE), JSON.stringify({ version: 2, ...ids }));
    await expectConfigError(findProjectConfig(dir));
  });

  it('returns null outside a linked directory', async () => {
    await expect(findProjectConfig(dir)).resolves.toBeNull();
  });
});

describe('API address', () => {
  it('allows https anywhere and http on loopback only', () => {
    expect(normalizeApiUrl('https://api.example.com/some/path')).toBe('https://api.example.com');
    expect(normalizeApiUrl('http://localhost:4000')).toBe('http://localhost:4000');
    expect(normalizeApiUrl('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
    expect(normalizeApiUrl('http://[::1]:4000')).toBe('http://[::1]:4000');
    expect(() => normalizeApiUrl('http://api.example.com')).toThrow(CliError);
    expect(() => normalizeApiUrl('ftp://localhost')).toThrow(CliError);
    expect(() => normalizeApiUrl('not a url')).toThrow(CliError);
  });
});

describe('configuration directory', () => {
  it('follows each platform convention', () => {
    expect(
      configDir({ APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, 'win32', 'C:\\Users\\dev'),
    ).toBe('C:\\Users\\dev\\AppData\\Roaming\\envvault');
    expect(configDir({}, 'win32', 'C:\\Users\\dev')).toBe(
      'C:\\Users\\dev\\AppData\\Roaming\\envvault',
    );
    expect(configDir({}, 'darwin', '/Users/dev')).toBe(
      '/Users/dev/Library/Application Support/envvault',
    );
    expect(configDir({}, 'linux', '/home/dev')).toBe('/home/dev/.config/envvault');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/dev')).toBe('/xdg/envvault');
    expect(configDir({ ENVVAULT_CONFIG_DIR: '/custom' }, 'linux', '/home/dev')).toBe('/custom');
  });
});
