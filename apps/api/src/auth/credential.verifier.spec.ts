import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeNeonAuth } from '../../test/support/fake-neon-auth.js';
import { extractBearerToken } from './bearer-token.js';
import { NeonPasswordVerifier } from './credential.verifier.js';

let neon: FakeNeonAuth;
let userId: string;

beforeAll(async () => {
  neon = await FakeNeonAuth.start();
  userId = neon.addUser('dev@example.test', 'correct horse battery staple');
});

afterAll(async () => {
  await neon.stop();
});

function verifier(trustedOrigin = 'http://localhost:3000') {
  return new NeonPasswordVerifier({ baseUrl: neon.baseUrl, trustedOrigin });
}

describe('NeonPasswordVerifier', () => {
  it('confirms the password with Neon Auth and ends the temporary session', async () => {
    const result = await verifier().verifyPassword({
      authUserId: userId,
      email: 'dev@example.test',
      password: 'correct horse battery staple',
    });
    expect(result).toBe('valid');

    // Sign-in carries the trusted web origin and no cookies...
    expect(neon.signInRequests.at(-1)).toEqual({
      origin: 'http://localhost:3000',
      cookie: undefined,
    });
    // ...and the session it created is signed out with the trusted web origin.
    expect(neon.signOutRequests.at(-1)?.origin).toBe('http://localhost:3000');
    expect(neon.signOutRequests.at(-1)?.cookie).toMatch(/^__Secure-neon-auth\.session_token=/);
    expect(neon.sessions.size).toBe(0);
  });

  it('reports a wrong password as invalid', async () => {
    await expect(
      verifier().verifyPassword({
        authUserId: userId,
        email: 'dev@example.test',
        password: 'wrong',
      }),
    ).resolves.toBe('invalid');
  });

  it('rejects credentials that belong to a different identity than the token subject', async () => {
    neon.addUser('other@example.test', 'other-password');
    await expect(
      verifier().verifyPassword({
        authUserId: userId,
        email: 'other@example.test',
        password: 'other-password',
      }),
    ).resolves.toBe('invalid');
  });

  it('treats rate limiting, server errors and network failures as unavailable', async () => {
    const respond = (status: number) =>
      new NeonPasswordVerifier({
        baseUrl: 'https://neon.example/auth',
        trustedOrigin: 'http://localhost:3000',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status })),
      });
    const input = { authUserId: userId, email: 'dev@example.test', password: 'x' };
    await expect(respond(429).verifyPassword(input)).resolves.toBe('unavailable');
    await expect(respond(503).verifyPassword(input)).resolves.toBe('unavailable');
    const offline = new NeonPasswordVerifier({
      baseUrl: 'http://127.0.0.1:1/neondb/auth',
      trustedOrigin: 'http://localhost:3000',
      timeoutMs: 1_000,
    });
    await expect(offline.verifyPassword(input)).resolves.toBe('unavailable');
  });
});

describe('extractBearerToken', () => {
  it('accepts only a single well-formed Bearer token', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    for (const header of [
      undefined,
      '',
      'bearer abc',
      'Basic dXNlcjpwYXNz',
      'Bearer',
      'Bearer abc def',
      'Bearer abc, Bearer def',
      ['Bearer a', 'Bearer b'],
    ]) {
      expect(extractBearerToken(header)).toBeNull();
    }
  });
});

describe('NeonPasswordVerifier origin handling', () => {
  it('is rejected by Neon Auth when the configured origin is not trusted', async () => {
    const untrusted = new NeonPasswordVerifier({
      baseUrl: neon.baseUrl,
      trustedOrigin: 'https://not-a-trusted-domain.example',
    });
    await expect(
      untrusted.verifyPassword({
        authUserId: userId,
        email: 'dev@example.test',
        password: 'correct horse battery staple',
      }),
    ).resolves.toBe('invalid');
  });
});
