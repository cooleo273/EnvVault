import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

/**
 * In-process stand-in for a Neon Auth (managed Better Auth) branch, shaped on
 * Neon's documented contract (https://neon.com/docs/auth/guides/plugins/jwt):
 *
 * - JWKS at `<base>/.well-known/jwks.json` with Ed25519 keys (alg EdDSA)
 * - tokens carry `iss` = `aud` = origin of the Auth URL, 15 minute lifetime
 * - `POST <base>/sign-in/email` and `POST <base>/sign-out` mimicking Better
 *   Auth's origin rules (requests with cookies or an Origin must use a
 *   trusted origin)
 *
 * Test-only. It holds plaintext passwords in memory for assertions.
 */

interface SigningKey {
  kid: string;
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  publicJwk: JWK;
}

export interface TokenOptions {
  sub: string;
  email: string;
  emailVerified?: boolean;
  name?: string;
  banned?: boolean;
  /** Seconds relative to now. */
  issuedAt?: number;
  expiresIn?: number;
  issuer?: string;
  audience?: string;
  kid?: string;
  /** Overrides/extra claims (e.g. `id` mismatch). */
  claims?: Record<string, unknown>;
}

const BASE_PATH = '/neondb/auth';

export class FakeNeonAuth {
  readonly users = new Map<string, { id: string; password: string }>();
  readonly sessions = new Set<string>();
  readonly trustedOrigins = new Set<string>(['http://localhost:3000']);
  readonly signInRequests: { origin: string | undefined; cookie: string | undefined }[] = [];
  readonly signOutRequests: { origin: string | undefined; cookie: string | undefined }[] = [];
  jwksRequests = 0;

  private readonly keys = new Map<string, SigningKey>();
  private readonly published = new Set<string>();
  private server!: Server;
  private port = 0;

  static async start(): Promise<FakeNeonAuth> {
    const fake = new FakeNeonAuth();
    await fake.addKey('key-1');
    fake.server = createServer((req, res) => {
      void fake.handle(req, res);
    });
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    fake.port = (fake.server.address() as AddressInfo).port;
    return fake;
  }

  get origin(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  /** NEON_AUTH_BASE_URL for this fake branch. */
  get baseUrl(): string {
    return `${this.origin}${BASE_PATH}`;
  }

  async addKey(kid: string, publish = true): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };
    this.keys.set(kid, { kid, privateKey, publicJwk });
    if (publish) this.published.add(kid);
  }

  publish(kid: string): void {
    this.published.add(kid);
  }

  unpublish(kid: string): void {
    this.published.delete(kid);
  }

  addUser(email: string, password: string, id: string = randomUUID()): string {
    this.users.set(email, { id, password });
    return id;
  }

  async issueToken(options: TokenOptions): Promise<string> {
    const kid = options.kid ?? 'key-1';
    const key = this.keys.get(kid);
    if (!key) throw new Error(`Unknown key ${kid}`);
    const now = Math.floor(Date.now() / 1000);
    const iat = now + (options.issuedAt ?? 0);
    return new SignJWT({
      id: options.sub,
      email: options.email,
      emailVerified: options.emailVerified ?? true,
      name: options.name ?? 'Test User',
      role: 'authenticated',
      banned: options.banned ?? false,
      ...options.claims,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setSubject(options.sub)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (options.expiresIn ?? 900))
      .setIssuer(options.issuer ?? this.origin)
      .setAudience(options.audience ?? this.origin)
      .sign(key.privateKey);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    if (req.method === 'GET' && url.pathname === `${BASE_PATH}/.well-known/jwks.json`) {
      this.jwksRequests += 1;
      const keys = [...this.published].map((kid) => this.keys.get(kid)?.publicJwk);
      json(res, 200, { keys });
      return;
    }

    const origin = header(req, 'origin');
    const cookie = header(req, 'cookie');
    const fetchMetadata = header(req, 'sec-fetch-mode') ?? header(req, 'sec-fetch-site');
    // Better Auth: requests carrying cookies, Fetch-Metadata (Node's fetch always
    // sends Sec-Fetch-Mode) or an Origin must come from a trusted origin.
    if ((cookie || origin || fetchMetadata) && (!origin || !this.trustedOrigins.has(origin))) {
      json(res, 403, { code: 'INVALID_ORIGIN' });
      return;
    }

    if (req.method === 'POST' && url.pathname === `${BASE_PATH}/sign-in/email`) {
      this.signInRequests.push({ origin, cookie });
      const body = (await readJson(req)) as { email?: string; password?: string };
      const user = body.email ? this.users.get(body.email) : undefined;
      if (!user || user.password !== body.password) {
        json(res, 401, { code: 'INVALID_EMAIL_OR_PASSWORD' });
        return;
      }
      const sessionToken = randomBytes(16).toString('hex');
      this.sessions.add(sessionToken);
      res.setHeader('set-cookie', [
        `__Secure-neon-auth.session_token=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=None`,
      ]);
      json(res, 200, { token: sessionToken, user: { id: user.id, email: body.email } });
      return;
    }

    if (req.method === 'POST' && url.pathname === `${BASE_PATH}/sign-out`) {
      this.signOutRequests.push({ origin, cookie });
      const token = /__Secure-neon-auth\.session_token=([^;]+)/.exec(cookie ?? '')?.[1];
      if (token) this.sessions.delete(token);
      json(res, 200, { success: true });
      return;
    }

    json(res, 404, { code: 'NOT_FOUND' });
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return {};
  }
}
