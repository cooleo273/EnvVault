import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoInputError, KeyConfigurationError } from '../errors.js';
import {
  decodeKeyMaterial,
  generateKeyring,
  type Keyring,
  keyringMetadata,
  parseKeyring,
  parseKeyringJson,
  retireKeyVersion,
  rotateKeyring,
  serializeKeyring,
} from './keyring.js';

function mutate(keyring: Keyring, change: (draft: Record<string, unknown>) => void): unknown {
  const draft = JSON.parse(JSON.stringify(keyring)) as Record<string, unknown>;
  change(draft);
  return draft;
}

function firstVersion(draft: Record<string, unknown>): Record<string, unknown> {
  return (draft.versions as Record<string, unknown>[])[0] ?? {};
}

describe('keyring', () => {
  it('generates a 256-bit random key with an id and version 1', () => {
    const keyring = generateKeyring();
    expect(keyring.keyId).toMatch(/^local-[0-9a-f]{32}$/);
    expect(keyring.activeVersion).toBe(1);
    const key = keyring.versions[0]?.key ?? '';
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(generateKeyring().versions[0]?.key).not.toBe(key);
    expect(parseKeyringJson(serializeKeyring(keyring))).toEqual(keyring);
  });

  it.each([
    ['16-byte key', randomBytes(16).toString('base64')],
    ['33-byte key', randomBytes(33).toString('base64')],
    ['empty key', ''],
    ['non-base64 key', 'not base64 at all!'],
    ['all-zero key', Buffer.alloc(32).toString('base64')],
  ])('rejects an invalid key size or encoding: %s', (_label, key) => {
    expect(() => decodeKeyMaterial(key)).toThrow(KeyConfigurationError);
    expect(() =>
      parseKeyring(
        mutate(generateKeyring(), (draft) => {
          firstVersion(draft).key = key;
        }),
      ),
    ).toThrow(KeyConfigurationError);
  });

  it('rejects a missing master key', () => {
    expect(() =>
      parseKeyring(
        mutate(generateKeyring(), (draft) => {
          delete firstVersion(draft).key;
        }),
      ),
    ).toThrow('missing its key material');
    expect(() => parseKeyringJson('')).toThrow(KeyConfigurationError);
    expect(() => parseKeyring(null)).toThrow(KeyConfigurationError);
  });

  it.each<[string, (draft: Record<string, unknown>) => void]>([
    ['format', (d) => (d.format = 'other')],
    ['format version', (d) => (d.formatVersion = 2)],
    ['usage', (d) => (d.usage = 'production')],
    ['key id', (d) => (d.keyId = 'prod-key')],
    ['active version', (d) => (d.activeVersion = 5)],
    ['versions', (d) => (d.versions = [])],
    ['status', (d) => (firstVersion(d).status = 'enabled')],
  ])('rejects an invalid %s', (_label, change) => {
    expect(() => parseKeyring(mutate(generateKeyring(), change))).toThrow(KeyConfigurationError);
  });

  it('never echoes key material in validation errors', () => {
    const keyring = generateKeyring();
    const short = randomBytes(31).toString('base64');
    try {
      parseKeyring(
        mutate(keyring, (draft) => {
          firstVersion(draft).key = short;
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(short);
      expect(JSON.stringify(error)).not.toContain(short);
    }
  });

  it('rotates: a new active version, the old one decrypt-only, input untouched', () => {
    const original = generateKeyring();
    const rotated = rotateKeyring(original);
    expect(original.activeVersion).toBe(1);
    expect(rotated.activeVersion).toBe(2);
    expect(rotated.keyId).toBe(original.keyId);
    expect(keyringMetadata(rotated).map((entry) => [entry.keyVersion, entry.status])).toEqual([
      [1, 'decrypt-only'],
      [2, 'active'],
    ]);
    expect(rotated.versions[1]?.key).not.toBe(rotated.versions[0]?.key);
    expect(JSON.stringify(keyringMetadata(rotated))).not.toContain(rotated.versions[1]?.key);
  });

  it('rejects two versions sharing key material or two active versions', () => {
    const rotated = rotateKeyring(generateKeyring());
    expect(() =>
      parseKeyring(
        mutate(rotated, (draft) => {
          const versions = draft.versions as Record<string, unknown>[];
          const [first, second] = versions;
          if (first && second) second.key = first.key;
        }),
      ),
    ).toThrow('share key material');
    expect(() =>
      parseKeyring(
        mutate(rotated, (draft) => {
          firstVersion(draft).status = 'active';
        }),
      ),
    ).toThrow(KeyConfigurationError);
  });

  it('retires a version only when nothing references it and never the active one', () => {
    const rotated = rotateKeyring(generateKeyring());
    expect(() => retireKeyVersion(rotated, 1, 3)).toThrow('still referenced');
    expect(() => retireKeyVersion(rotated, 2, 0)).toThrow(CryptoInputError);
    expect(() => retireKeyVersion(rotated, 9, 0)).toThrow('Unknown key version');
    const retired = retireKeyVersion(rotated, 1, 0);
    expect(retired.versions[0]).toMatchObject({ version: 1, status: 'retired' });
    expect(retired.versions[0]?.key).toBeUndefined();
    expect(parseKeyring(retired)).toEqual(retired);
  });
});
