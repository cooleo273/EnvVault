import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecryptionError, KeyConfigurationError } from '../errors.js';
import { SecretCipher } from '../secret-cipher.js';
import { syntheticContext } from '../test-helpers.js';
import { generateKeyring, rotateKeyring, serializeKeyring } from './keyring.js';
import { enforcesPosixPermissions, readKeyringFile, writeKeyringFile } from './keyring-file.js';
import { loadLocalKeyProvider } from './load.js';
import { LocalKeyProvider } from './local-provider.js';

const context = { purpose: 'secret-value', fields: [['secretId', 'a']] } as const;

describe('LocalKeyProvider', () => {
  it('is restricted to development and test', () => {
    expect(() => new LocalKeyProvider(generateKeyring(), { nodeEnv: 'production' })).toThrow(
      KeyConfigurationError,
    );
    expect(() => new LocalKeyProvider(generateKeyring(), { nodeEnv: 'development' })).not.toThrow();
  });

  it('refuses to run where a browser window exists', () => {
    const scope = globalThis as { window?: unknown };
    scope.window = {};
    try {
      expect(() => new LocalKeyProvider(generateKeyring())).toThrow('server-side');
    } finally {
      delete scope.window;
    }
  });

  it('validates configuration with a self-test of every usable version', async () => {
    const provider = new LocalKeyProvider(rotateKeyring(generateKeyring()), { nodeEnv: 'test' });
    const report = await provider.validateKeyConfiguration();
    expect(report.active.keyVersion).toBe(2);
    expect(report.usableVersions).toBe(2);
  });

  it('binds wrapped keys to their purpose and context', async () => {
    const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
    const { dataKey, wrapped } = await provider.generateDataKey(context);
    const unwrapped = await provider.unwrapDataKey(wrapped, context);
    expect(unwrapped.use((a) => dataKey.use((b) => a.equals(b)))).toBe(true);
    await expect(
      provider.unwrapDataKey(wrapped, { ...context, fields: [['secretId', 'b']] }),
    ).rejects.toThrow(DecryptionError);
    // A wrapped key presented under a different field name/order fails too.
    await expect(
      provider.unwrapDataKey(wrapped, { ...context, fields: [['secretID', 'a']] }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects after destroy', async () => {
    const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
    const { wrapped } = await provider.generateDataKey(context);
    provider.destroy();
    await expect(provider.unwrapDataKey(wrapped, context)).rejects.toThrow();
  });
});

describe('keyring storage and loading', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'envvault-crypto-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes atomically with owner-only permissions and reads back', async () => {
    const path = join(directory, 'nested', 'keyring.json');
    const keyring = generateKeyring();
    await writeKeyringFile(path, keyring);
    expect(await readKeyringFile(path)).toEqual(keyring);
    if (enforcesPosixPermissions()) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(!enforcesPosixPermissions())('refuses group- or world-readable files', async () => {
    const path = join(directory, 'keyring.json');
    await writeKeyringFile(path, generateKeyring());
    await chmod(path, 0o644);
    await expect(readKeyringFile(path)).rejects.toThrow('permissions are too open');
  });

  it('rejects relative paths, missing files and invalid content', async () => {
    await expect(readKeyringFile('keyring.json')).rejects.toThrow('absolute');
    await expect(readKeyringFile(join(directory, 'absent.json'))).rejects.toThrow('does not exist');
    const path = join(directory, 'bad.json');
    await writeFile(path, '{"format":', { mode: 0o600 });
    await expect(readKeyringFile(path)).rejects.toThrow('not valid JSON');
  });

  it('loads from a file and persists rotations to it', async () => {
    const path = join(directory, 'keyring.json');
    await writeKeyringFile(path, generateKeyring());
    const provider = await loadLocalKeyProvider({ file: path }, 'development');
    const cipher = new SecretCipher(provider);
    const secretContext = syntheticContext();
    const envelope = await cipher.encryptSecret('synthetic-file', secretContext);
    await provider.rotateWrappingKey();
    const persisted = await readKeyringFile(path);
    expect(persisted.activeVersion).toBe(2);
    const reloaded = new SecretCipher(await loadLocalKeyProvider({ file: path }, 'development'));
    await expect(reloaded.decryptSecret(envelope, secretContext)).resolves.toBe('synthetic-file');
  });

  it('loads from an inline (environment) value but cannot rotate it', async () => {
    const inline = Buffer.from(serializeKeyring(generateKeyring())).toString('base64');
    const provider = await loadLocalKeyProvider({ inline }, 'test');
    expect(provider.source).toEqual({ kind: 'environment' });
    await expect(provider.rotateWrappingKey()).rejects.toThrow(KeyConfigurationError);
    await expect(loadLocalKeyProvider({ inline: 'not base64!' }, 'test')).rejects.toThrow(
      KeyConfigurationError,
    );
    await expect(loadLocalKeyProvider({ inline: '' }, 'test')).rejects.toThrow(
      KeyConfigurationError,
    );
  });

  it('refuses production even with a valid keyring', async () => {
    const path = join(directory, 'keyring.json');
    await writeKeyringFile(path, generateKeyring());
    await expect(loadLocalKeyProvider({ file: path }, 'production')).rejects.toThrow(
      'restricted to development',
    );
  });

  it('runs a self managed keyring only in production, from a file, when acknowledged', async () => {
    const path = join(directory, 'keyring.json');
    await writeKeyringFile(path, generateKeyring(new Date(), 'self-managed'));
    await expect(loadLocalKeyProvider({ file: path }, 'development')).rejects.toThrow(
      'only used in production',
    );
    await expect(loadLocalKeyProvider({ file: path }, 'production')).rejects.toThrow(
      'ENCRYPTION_SELF_MANAGED_ACKNOWLEDGED',
    );
    const provider = await loadLocalKeyProvider({ file: path }, 'production', {
      acceptSelfManagedProduction: true,
    });
    expect((await provider.getActiveKeyVersion()).keyVersion).toBe(1);
    provider.destroy();

    const inline = Buffer.from(
      serializeKeyring(generateKeyring(new Date(), 'self-managed')),
    ).toString('base64');
    await expect(
      loadLocalKeyProvider({ inline }, 'production', { acceptSelfManagedProduction: true }),
    ).rejects.toThrow('loaded from a file');
  });

  it('refuses to rotate when the keyring file was replaced underneath it', async () => {
    const path = join(directory, 'keyring.json');
    await writeKeyringFile(path, generateKeyring());
    const provider = await loadLocalKeyProvider({ file: path }, 'test');
    await writeKeyringFile(path, generateKeyring());
    await expect(provider.rotateWrappingKey()).rejects.toThrow('was replaced');
    provider.destroy();
  });

  it('never leaves temporary files behind', async () => {
    const path = join(directory, 'keyring.json');
    await writeKeyringFile(path, generateKeyring());
    await writeKeyringFile(path, generateKeyring());
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(directory)).toEqual(['keyring.json']);
    expect(await readFile(path, 'utf8')).toContain('envvault.local-keyring');
  });
});
