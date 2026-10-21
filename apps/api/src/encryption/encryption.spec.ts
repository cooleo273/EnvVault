import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DecryptionError,
  EncryptionNotConfiguredError,
  generateKeyring,
  LocalKeyProvider,
  serializeKeyring,
  writeKeyringFile,
} from '@envvault/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module.js';
import { EnvValidationError, parseEnv } from '../config/env.js';
import {
  DISABLED_ENCRYPTION,
  EncryptionConfigurationError,
  type EncryptionRuntime,
  loadEncryption,
} from './encryption.config.js';
import { EncryptionModule } from './encryption.module.js';
import { KeyManagementService } from './key-management.service.js';
import { SecretEncryptionService } from './secret-encryption.service.js';

const base = {
  DATABASE_URL: 'postgresql://envvault:placeholder@localhost:5432/envvault',
  CORS_ORIGINS: 'http://localhost:3000',
  NEON_AUTH_BASE_URL: 'https://ep-example.neonauth.us-east-1.aws.neon.tech/neondb/auth',
};

const SYNTHETIC = 'synthetic-api-value-41d2';

function context() {
  return {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    environmentId: randomUUID(),
    secretId: randomUUID(),
    secretVersionId: randomUUID(),
  };
}

function issues(source: Record<string, string>): string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.issues;
    throw error;
  }
  return [];
}

describe('encryption configuration', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'envvault-api-keys-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('is disabled by default and never generates keys', async () => {
    const env = parseEnv(base);
    expect(env.ENCRYPTION_PROVIDER).toBe('none');
    await expect(loadEncryption(env)).resolves.toEqual({ status: 'disabled' });
  });

  it('requires exactly one keyring source for the local provider', () => {
    expect(issues({ ...base, ENCRYPTION_PROVIDER: 'local' })).toEqual([
      expect.stringContaining('ENCRYPTION_KEYRING_FILE: set exactly one'),
    ]);
    expect(
      issues({
        ...base,
        ENCRYPTION_PROVIDER: 'local',
        ENCRYPTION_KEYRING_FILE: join(directory, 'k.json'),
        ENCRYPTION_LOCAL_KEYRING: 'abc',
      }),
    ).toHaveLength(1);
  });

  it('rejects keyrings configured while encryption is off, and relative paths', () => {
    expect(issues({ ...base, ENCRYPTION_KEYRING_FILE: '/keys/k.json' })[0]).toContain(
      'ENCRYPTION_PROVIDER',
    );
    expect(
      issues({ ...base, ENCRYPTION_PROVIDER: 'local', ENCRYPTION_KEYRING_FILE: 'keys/k.json' }),
    ).toEqual([expect.stringContaining('must be an absolute path')]);
  });

  it('refuses production keys without an acknowledgement, and inline keyrings, without echoing values', () => {
    const inline = Buffer.from(serializeKeyring(generateKeyring())).toString('base64');
    const found = issues({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example.com',
      ENCRYPTION_PROVIDER: 'local',
      ENCRYPTION_LOCAL_KEYRING: inline,
    });
    expect(found.join('\n')).toContain('ENCRYPTION_SELF_MANAGED_ACKNOWLEDGED');
    expect(found.join('\n')).toContain('ENCRYPTION_LOCAL_KEYRING');
    expect(found.join('\n')).not.toContain(inline);
  });

  it('runs production only on an acknowledged self managed keyring file', async () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example.com',
      INTEGRITY_KEY_FILE: '/keys/integrity.json',
      ENCRYPTION_PROVIDER: 'local',
      ENCRYPTION_SELF_MANAGED_ACKNOWLEDGED: 'true',
    };
    const development = join(directory, 'dev.json');
    await writeKeyringFile(development, generateKeyring());
    await expect(
      loadEncryption(parseEnv({ ...production, ENCRYPTION_KEYRING_FILE: development })),
    ).rejects.toThrow('Development keyrings are restricted');

    const managed = join(directory, 'self-managed.json');
    await writeKeyringFile(managed, generateKeyring(new Date(), 'self-managed'));
    const runtime = await loadEncryption(
      parseEnv({ ...production, ENCRYPTION_KEYRING_FILE: managed }),
    );
    expect(runtime.status).toBe('ready');
    await expect(
      loadEncryption(
        parseEnv({ ...base, ENCRYPTION_PROVIDER: 'local', ENCRYPTION_KEYRING_FILE: managed }),
      ),
    ).rejects.toThrow('only used in production');
  });

  it('loads a file-backed keyring and reports metadata only', async () => {
    const path = join(directory, 'keyring.json');
    const keyring = generateKeyring();
    await writeKeyringFile(path, keyring);
    const runtime = await loadEncryption(
      parseEnv({ ...base, ENCRYPTION_PROVIDER: 'local', ENCRYPTION_KEYRING_FILE: path }),
    );
    expect(runtime.status).toBe('ready');
    const status = await new KeyManagementService(runtime).status();
    expect(status).toMatchObject({
      status: 'ready',
      providerId: 'local',
      active: { keyVersion: 1 },
    });
    expect(JSON.stringify(status)).not.toContain(keyring.versions[0]?.key ?? '<none>');
  });

  it('fails start-up with a distinct error for an unusable keyring, without its contents', async () => {
    const missing = parseEnv({
      ...base,
      ENCRYPTION_PROVIDER: 'local',
      ENCRYPTION_KEYRING_FILE: join(directory, 'absent.json'),
    });
    await expect(loadEncryption(missing)).rejects.toThrow(EncryptionConfigurationError);
    await expect(loadEncryption(missing)).rejects.toThrow('Keyring file does not exist');

    const broken = Buffer.from('{"format":"envvault.local-keyring","keyId":"SECRETISH"}').toString(
      'base64',
    );
    const error = await loadEncryption(
      parseEnv({ ...base, ENCRYPTION_PROVIDER: 'local', ENCRYPTION_LOCAL_KEYRING: broken }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EncryptionConfigurationError);
    expect(String(error)).not.toContain('SECRETISH');
    expect(String(error)).not.toContain(broken);
  });

  it('AppModule refuses to start without the keys the configuration asks for', () => {
    const env = parseEnv({
      ...base,
      ENCRYPTION_PROVIDER: 'local',
      ENCRYPTION_KEYRING_FILE: join(directory, 'k.json'),
    });
    expect(() => AppModule.register(env)).toThrow(EncryptionConfigurationError);
  });
});

async function services(runtime: EncryptionRuntime) {
  const moduleRef = await Test.createTestingModule({
    imports: [EncryptionModule.register(runtime)],
  }).compile();
  return {
    moduleRef,
    encryption: moduleRef.get(SecretEncryptionService),
    keys: moduleRef.get(KeyManagementService),
  };
}

describe('EncryptionModule', () => {
  it('exposes no HTTP controllers', () => {
    const definition = EncryptionModule.register(DISABLED_ENCRYPTION);
    expect(definition.controllers ?? []).toEqual([]);
    expect(Reflect.getMetadata('controllers', EncryptionModule) ?? []).toEqual([]);
  });

  it('encrypts and decrypts through dependency injection', async () => {
    const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
    const { encryption, keys, moduleRef } = await services({ status: 'ready', provider });
    const secretContext = context();
    const envelope = await encryption.encryptSecret(SYNTHETIC, secretContext);
    expect(keys.isConfigured).toBe(true);
    await expect(encryption.decryptSecret(envelope, secretContext)).resolves.toBe(SYNTHETIC);
    await moduleRef.close();
  });

  it('fails closed when encryption is disabled', async () => {
    const { encryption, keys } = await services(DISABLED_ENCRYPTION);
    expect(keys.isConfigured).toBe(false);
    await expect(keys.status()).resolves.toEqual({ status: 'disabled' });
    expect(() => keys.provider()).toThrow(EncryptionNotConfiguredError);
    await expect(
      Promise.resolve().then(() => encryption.encryptSecret(SYNTHETIC, context())),
    ).rejects.toThrow(EncryptionNotConfiguredError);
  });

  it('logs decryption failures by category and id, never the value', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
      const { encryption } = await services({ status: 'ready', provider });
      const secretContext = context();
      const envelope = await encryption.encryptSecret(SYNTHETIC, secretContext);
      await expect(
        encryption.decryptSecret(envelope, { ...secretContext, secretId: randomUUID() }),
      ).rejects.toThrow(DecryptionError);
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('DECRYPTION_FAILED');
      expect(logged).toContain(secretContext.secretVersionId);
      expect(logged).not.toContain(SYNTHETIC);
    } finally {
      warn.mockRestore();
    }
  });

  it('zeroes key material on shutdown', async () => {
    const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
    const { encryption, moduleRef } = await services({ status: 'ready', provider });
    const envelope = await encryption.encryptSecret(SYNTHETIC, context());
    await moduleRef.close();
    await expect(
      provider.unwrapDataKey(envelope, { purpose: 'secret-value', fields: [] }),
    ).rejects.toThrow();
  });
});
