import { randomUUID } from 'node:crypto';
import { generateSecret, SignJWT, UnsecuredJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeNeonAuth } from '../../test/support/fake-neon-auth.js';
import { NeonTokenVerifier, TokenVerificationError } from './neon-token.verifier.js';

let neon: FakeNeonAuth;
let verifier: NeonTokenVerifier;
const sub = randomUUID();
const email = 'dev@example.test';

function createVerifier(
  overrides: Partial<ConstructorParameters<typeof NeonTokenVerifier>[0]> = {},
) {
  return new NeonTokenVerifier({
    jwksUrl: new URL(`${neon.baseUrl}/.well-known/jwks.json`),
    issuer: neon.origin,
    audience: neon.origin,
    maxTokenAgeSeconds: 900,
    clockToleranceSeconds: 5,
    jwksCooldownMs: 0,
    ...overrides,
  });
}

async function expectRejected(
  token: string,
  reason: 'expired' | 'invalid' | 'unavailable',
  v = verifier,
) {
  const error = await v.verify(token).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TokenVerificationError);
  expect((error as TokenVerificationError).reason).toBe(reason);
}

beforeAll(async () => {
  neon = await FakeNeonAuth.start();
  verifier = createVerifier();
});

afterAll(async () => {
  await neon.stop();
});

describe('NeonTokenVerifier', () => {
  it('accepts a valid Neon Auth token and maps its claims', async () => {
    const token = await neon.issueToken({ sub, email: 'Dev@Example.test', name: 'Dev' });
    const verified = await verifier.verify(token);
    expect(verified).toMatchObject({
      authUserId: sub,
      email: email,
      emailVerified: true,
      name: 'Dev',
      banned: false,
    });
    expect(verified.expiresAt.getTime() - verified.issuedAt.getTime()).toBe(900_000);
  });

  it('reports unverified emails and banned users without rejecting the token', async () => {
    const token = await neon.issueToken({ sub, email, emailVerified: false, banned: true });
    await expect(verifier.verify(token)).resolves.toMatchObject({
      emailVerified: false,
      banned: true,
    });
  });

  it('rejects expired tokens (beyond the clock tolerance)', async () => {
    const token = await neon.issueToken({ sub, email, issuedAt: -1000, expiresIn: 900 });
    await expectRejected(token, 'expired');
  });

  it('accepts tokens within the clock tolerance', async () => {
    const token = await neon.issueToken({ sub, email, issuedAt: -902, expiresIn: 900 });
    await expect(verifier.verify(token)).resolves.toBeDefined();
  });

  it('rejects tokens older than the maximum age even if exp is far away', async () => {
    // jose reports max-age violations as expiry: the client should fetch a new token.
    const token = await neon.issueToken({ sub, email, issuedAt: -3600, expiresIn: 7200 });
    await expectRejected(token, 'expired');
  });

  it('rejects tokens from another Neon branch (different issuer), e.g. development tokens in production', async () => {
    const token = await neon.issueToken({
      sub,
      email,
      issuer: 'https://ep-dev-branch.neonauth.example',
    });
    await expectRejected(token, 'invalid');
  });

  it('rejects tokens with the wrong audience', async () => {
    const token = await neon.issueToken({
      sub,
      email,
      audience: 'https://some-other-service.example',
    });
    await expectRejected(token, 'invalid');
  });

  it('rejects tokens signed with a key that is not in the JWKS', async () => {
    await neon.addKey('attacker', false);
    const token = await neon.issueToken({ sub, email, kid: 'attacker' });
    await expectRejected(token, 'invalid');
  });

  it('rejects tampered tokens', async () => {
    const token = await neon.issueToken({ sub, email });
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: randomUUID() })).toString(
      'base64url',
    );
    await expectRejected(`${header}.${forged}.${signature}`, 'invalid');
  });

  it('rejects HMAC-signed and unsigned tokens (algorithm allow-list)', async () => {
    const secret = await generateSecret('HS256');
    const hmac = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setIssuer(neon.origin)
      .setAudience(neon.origin)
      .sign(secret);
    await expectRejected(hmac, 'invalid');

    const unsigned = new UnsecuredJWT({ email })
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setIssuer(neon.origin)
      .setAudience(neon.origin)
      .encode();
    await expectRejected(unsigned, 'invalid');
  });

  it('rejects tokens with missing or inconsistent identity claims', async () => {
    await expectRejected(
      await neon.issueToken({ sub, email, claims: { id: randomUUID() } }),
      'invalid',
    );
    await expectRejected(
      await neon.issueToken({ sub, email, claims: { email: 'not-an-email' } }),
      'invalid',
    );
    await expectRejected(await neon.issueToken({ sub: 'seed:alice', email }), 'invalid');
  });

  it('rejects malformed and oversized input', async () => {
    await expectRejected('not.a.jwt', 'invalid');
    await expectRejected('', 'invalid');
    await expectRejected('a'.repeat(9000), 'invalid');
  });

  it('picks up rotated signing keys from the JWKS without a restart', async () => {
    const rotating = createVerifier();
    await expect(rotating.verify(await neon.issueToken({ sub, email }))).resolves.toBeDefined();

    // Neon rotates: a new key is published and new tokens use it.
    await neon.addKey('key-2');
    const before = neon.jwksRequests;
    await expect(
      rotating.verify(await neon.issueToken({ sub, email, kid: 'key-2' })),
    ).resolves.toBeDefined();
    expect(neon.jwksRequests).toBeGreaterThan(before);

    // Once the old key is withdrawn, tokens signed with it are rejected.
    neon.unpublish('key-1');
    const fresh = createVerifier();
    await expectRejected(await neon.issueToken({ sub, email, kid: 'key-1' }), 'invalid', fresh);
    neon.publish('key-1');
  });

  it('fails closed as "unavailable" when the JWKS cannot be fetched', async () => {
    const offline = createVerifier({
      jwksUrl: new URL('http://127.0.0.1:1/neondb/auth/.well-known/jwks.json'),
    });
    await expectRejected(await neon.issueToken({ sub, email }), 'unavailable', offline);
  });
});
