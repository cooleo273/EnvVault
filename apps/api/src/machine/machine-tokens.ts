import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { IntegrityKeys } from '@envvault/crypto';
import { MACHINE_LIMITS, SERVICE_CREDENTIAL_PATTERN } from '@envvault/shared';

const LOOKUP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PURPOSE = 'service-credential';

export interface NewCredentialToken {
  token: string;
  lookupId: string;
  digest: Buffer;
  digestKeyId: string;
}

/** The digest binds the lookup id too, so a stored digest cannot be moved to another row. */
function digestInput(lookupId: string, secret: string): Buffer {
  return Buffer.from(`${lookupId}.${secret}`, 'utf8');
}

/**
 * `evv_sk_<16 character lookup id>_<43 character secret>`: the prefix lets
 * secret scanners recognise leaks, the lookup id finds the row without a
 * scan, and only an HMAC of the secret under the integrity key is stored.
 */
export function issueCredentialToken(keys: IntegrityKeys): NewCredentialToken {
  const lookupId = Array.from({ length: 16 }, () =>
    LOOKUP_ALPHABET.charAt(randomInt(LOOKUP_ALPHABET.length)),
  ).join('');
  const secret = randomBytes(32).toString('base64url');
  return {
    token: `${MACHINE_LIMITS.credentialPrefix}${lookupId}_${secret}`,
    lookupId,
    digest: keys.mac(PURPOSE, digestInput(lookupId, secret)),
    digestKeyId: keys.activeKeyId,
  };
}

export function parseCredentialToken(token: string): { lookupId: string; secret: string } | null {
  const match = SERVICE_CREDENTIAL_PATTERN.exec(token);
  if (!match?.[1] || !match[2]) return null;
  return { lookupId: match[1], secret: match[2] };
}

/** Constant time comparison of the recomputed HMAC (IntegrityKeys.verify). */
export function verifyCredentialSecret(
  keys: IntegrityKeys,
  parsed: { lookupId: string; secret: string },
  stored: { digest: Buffer; digestKeyId: string },
): boolean {
  return keys.verify(
    PURPOSE,
    digestInput(parsed.lookupId, parsed.secret),
    stored.digest,
    stored.digestKeyId,
  );
}

/** What the dashboard shows to recognise a credential. Never enough to use it. */
export function displayPrefix(lookupId: string): string {
  return `${MACHINE_LIMITS.credentialPrefix}${lookupId.slice(0, 8)}…`;
}

export function issueAccessToken(): { token: string; hash: Buffer } {
  const token = `${MACHINE_LIMITS.accessTokenPrefix}${randomBytes(32).toString('base64url')}`;
  return { token, hash: accessTokenHash(token) };
}

/** Access tokens are 256 bit random values, so an unkeyed hash is enough to store them. */
export function accessTokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
