import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { KeyConfigurationError } from './errors.js';
import {
  generateIntegrityKeyFile,
  IntegrityKeys,
  parseIntegrityKeyFile,
  rotateIntegrityKeyFile,
  serializeIntegrityKeyFile,
} from './integrity-key.js';

describe('integrity keys', () => {
  it('separates purposes and verifies with the key that made the MAC', () => {
    const file = generateIntegrityKeyFile();
    const keys = new IntegrityKeys(file);
    const data = Buffer.from('event');
    const seal = keys.mac('audit-seal', data);
    expect(keys.verify('audit-seal', data, seal, file.activeKeyId)).toBe(true);
    expect(keys.mac('idempotency', data).equals(seal)).toBe(false);
    expect(keys.verify('audit-seal', Buffer.from('evenT'), seal, file.activeKeyId)).toBe(false);

    const rotated = new IntegrityKeys(rotateIntegrityKeyFile(file));
    expect(rotated.activeKeyId).not.toBe(file.activeKeyId);
    expect(rotated.verify('audit-seal', data, seal, file.activeKeyId)).toBe(true);
    expect(
      new IntegrityKeys(generateIntegrityKeyFile()).verify(
        'audit-seal',
        data,
        seal,
        file.activeKeyId,
      ),
    ).toBe(false);
  });

  it('never renders key material', () => {
    const file = generateIntegrityKeyFile();
    const keys = new IntegrityKeys(file);
    const material = file.keys[0]?.key ?? '<none>';
    expect(JSON.stringify(keys)).not.toContain(material);
    expect(inspect(keys)).not.toContain(material);
  });

  it('rejects malformed files without echoing them', () => {
    const file = JSON.parse(serializeIntegrityKeyFile(generateIntegrityKeyFile())) as Record<
      string,
      unknown
    >;
    expect(() => parseIntegrityKeyFile({ ...file, activeKeyId: 'ik-0000000000000000' })).toThrow(
      KeyConfigurationError,
    );
    expect(() =>
      parseIntegrityKeyFile({ ...file, keys: [{ keyId: 'bad', createdAt: 'x', key: 'AAAA' }] }),
    ).toThrow('Integrity key entry is invalid');
  });
});
