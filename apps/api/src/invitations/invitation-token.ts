import { createHash, randomBytes } from 'node:crypto';

/**
 * Invitation tokens: 32 random bytes (256 bits) encoded as base64url. Only
 * the SHA-256 hash is stored, so a database leak does not expose usable
 * links; a plain hash is sufficient because the token itself is high-entropy.
 */
export function generateInvitationToken(): { token: string; hash: Uint8Array<ArrayBuffer> } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
}

/**
 * Link to the web app's invitation page. The token travels in the URL
 * fragment, which browsers never send to servers or in Referer headers.
 */
export function invitationUrl(appBaseUrl: string, token: string): string {
  return `${appBaseUrl}/invite#token=${token}`;
}
