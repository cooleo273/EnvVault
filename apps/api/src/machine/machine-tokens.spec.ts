import { IntegrityKeys } from '@envvault/crypto';
import { MACHINE_TOKEN_PATTERN, SERVICE_CREDENTIAL_PATTERN } from '@envvault/shared';
import { describe, expect, it } from 'vitest';
import {
  accessTokenHash,
  displayPrefix,
  issueAccessToken,
  issueCredentialToken,
  parseCredentialToken,
  verifyCredentialSecret,
} from './machine-tokens.js';

describe('service credential tokens', () => {
  const keys = IntegrityKeys.ephemeral();

  it('have the scannable format and never repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const issued = issueCredentialToken(keys);
      expect(issued.token).toMatch(SERVICE_CREDENTIAL_PATTERN);
      expect(seen.has(issued.token)).toBe(false);
      seen.add(issued.token);
    }
  });

  it('store a keyed digest that verifies only the exact token', () => {
    const issued = issueCredentialToken(keys);
    const parsed = parseCredentialToken(issued.token);
    if (!parsed) throw new Error('unparsable');
    const stored = { digest: issued.digest, digestKeyId: issued.digestKeyId };
    expect(issued.digest.toString('hex')).not.toContain(Buffer.from(parsed.secret).toString('hex'));
    expect(verifyCredentialSecret(keys, parsed, stored)).toBe(true);
    const tampered = {
      ...parsed,
      secret: `${parsed.secret.slice(0, -1)}${parsed.secret.endsWith('A') ? 'B' : 'A'}`,
    };
    expect(verifyCredentialSecret(keys, tampered, stored)).toBe(false);
    // The digest is bound to its lookup id, so it cannot be moved to another row.
    expect(verifyCredentialSecret(keys, { ...parsed, lookupId: 'Z'.repeat(16) }, stored)).toBe(
      false,
    );
  });

  it('cannot be verified without the integrity key, which lives outside the database', () => {
    const issued = issueCredentialToken(keys);
    const parsed = parseCredentialToken(issued.token);
    if (!parsed) throw new Error('unparsable');
    const otherKeys = IntegrityKeys.ephemeral();
    expect(
      verifyCredentialSecret(otherKeys, parsed, {
        digest: issued.digest,
        digestKeyId: issued.digestKeyId,
      }),
    ).toBe(false);
  });

  it('show only a short non secret prefix', () => {
    const issued = issueCredentialToken(keys);
    const shown = displayPrefix(issued.lookupId);
    expect(shown).toBe(`evv_sk_${issued.lookupId.slice(0, 8)}…`);
    expect(issued.token.startsWith(shown.slice(0, -1))).toBe(true);
    expect(shown.length).toBeLessThan(20);
  });

  it('reject malformed input', () => {
    for (const value of [
      '',
      'evv_sk_',
      `evv_sk_${'A'.repeat(15)}_${'b'.repeat(43)}`,
      `evv_mt_${'a'.repeat(43)}`,
    ]) {
      expect(parseCredentialToken(value)).toBeNull();
    }
  });
});

describe('machine access tokens', () => {
  it('are random, prefixed and stored as a 32 byte hash', () => {
    const a = issueAccessToken();
    const b = issueAccessToken();
    expect(a.token).toMatch(MACHINE_TOKEN_PATTERN);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toHaveLength(32);
    expect(accessTokenHash(a.token).equals(a.hash)).toBe(true);
  });
});
