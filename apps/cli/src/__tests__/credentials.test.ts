import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Credential, credentialStore } from '../credentials.js';
import { CliError, EXIT } from '../errors.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

const credential: Credential = {
  version: 1,
  apiUrl: 'http://localhost:4000',
  webUrl: 'http://localhost:3000',
  sessionId: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c09',
  email: 'dev@example.test',
  accessToken: 'evv_at_synthetic',
  accessExpiresAt: '2030-01-01T00:00:00.000Z',
  refreshToken: 'evv_rt_synthetic',
  refreshExpiresAt: '2030-01-30T00:00:00.000Z',
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'envvault-credentials-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('file credential store', () => {
  const store = () => credentialStore({ ENVVAULT_CREDENTIAL_STORE: 'file' }, dir);

  it('round trips per API origin and removes the file when empty', async () => {
    await store().write(credential);
    await expect(store().read(credential.apiUrl)).resolves.toEqual(credential);
    await expect(store().read('https://other.example.com')).resolves.toBeNull();
    await store().remove(credential.apiUrl);
    await expect(stat(join(dir, 'credentials.json'))).rejects.toThrow();
  });

  posixOnly('writes the file readable by its owner only', async () => {
    await store().write(credential);
    expect((await stat(join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
  });

  posixOnly('refuses a file other users can read', async () => {
    await store().write(credential);
    await chmod(join(dir, 'credentials.json'), 0o644);
    const error = await store()
      .read(credential.apiUrl)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT.config);
  });

  it('ignores entries that are not EnvVault CLI tokens', async () => {
    await writeFile(
      join(dir, 'credentials.json'),
      JSON.stringify({ [credential.apiUrl]: { ...credential, accessToken: 'cookie' } }),
      {
        mode: 0o600,
      },
    );
    await expect(store().read(credential.apiUrl)).resolves.toBeNull();
  });

  it('defaults to the operating system store', () => {
    expect(credentialStore({}, dir).kind).toBe('keychain');
    expect(store().kind).toBe('file');
  });
});
