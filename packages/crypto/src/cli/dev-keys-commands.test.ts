import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readKeyringFile } from '../local/keyring-file.js';
import { type CliIo, DEFAULT_KEYRING_RELATIVE_PATH, runDevKeys } from './dev-keys-commands.js';

describe('dev key CLI', () => {
  let directory: string;
  let out: string[];
  let err: string[];
  let io: CliIo;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'envvault-cli-'));
    out = [];
    err = [];
    io = {
      cwd: directory,
      env: { NODE_ENV: 'development' },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const path = (): string => join(directory, DEFAULT_KEYRING_RELATIVE_PATH);

  it('init creates a keyring, prints setup and a loss warning, never the key', async () => {
    expect(await runDevKeys(['init'], io)).toBe(0);
    const keyring = await readKeyringFile(path());
    const printed = [...out, ...err].join('\n');
    expect(printed).toContain(keyring.keyId);
    expect(printed).toContain('ENCRYPTION_PROVIDER=local');
    expect(printed).toContain(`ENCRYPTION_KEYRING_FILE=${path()}`);
    expect(printed).toContain('permanently unrecoverable');
    expect(printed).not.toContain(keyring.versions[0]?.key ?? '<none>');
  });

  it('init refuses to overwrite without the matching key id', async () => {
    await runDevKeys(['init'], io);
    const before = await readFile(path(), 'utf8');
    const { keyId } = await readKeyringFile(path());

    expect(await runDevKeys(['init'], io)).toBe(1);
    expect(await runDevKeys(['init', '--overwrite', 'local-wrong'], io)).toBe(1);
    expect(await readFile(path(), 'utf8')).toBe(before);
    expect(err.join('\n')).toContain('Refusing to overwrite');

    expect(await runDevKeys(['init', '--overwrite', keyId], io)).toBe(0);
    expect((await readKeyringFile(path())).keyId).not.toBe(keyId);
  });

  it('rotate adds a version and status lists versions without key material', async () => {
    await runDevKeys(['init'], io);
    expect(await runDevKeys(['rotate'], io)).toBe(0);
    out = [];
    expect(await runDevKeys(['status'], io)).toBe(0);
    const keyring = await readKeyringFile(path());
    expect(keyring.activeVersion).toBe(2);
    const printed = out.join('\n');
    expect(printed).toMatch(/v1\s+decrypt-only/);
    expect(printed).toMatch(/v2\s+active/);
    for (const version of keyring.versions) expect(printed).not.toContain(version.key ?? '<none>');
  });

  it('refuses production, web-served paths, unknown commands and missing keyrings', async () => {
    expect(await runDevKeys(['init'], { ...io, env: { NODE_ENV: 'production' } })).toBe(1);
    expect(await runDevKeys(['init', '--file', 'apps/web/public/keys.json'], io)).toBe(1);
    expect(await runDevKeys(['launch'], io)).toBe(2);
    expect(await runDevKeys([], io)).toBe(2);
    expect(await runDevKeys(['rotate'], io)).toBe(1);
    expect(err.join('\n')).toContain('does not exist');
  });
});
