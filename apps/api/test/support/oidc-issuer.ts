import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

/**
 * Test only stand in for GitHub's Actions OIDC issuer: real RS256 keys, a
 * discovery document, a JWKS and signed tokens with GitHub's claim set. It
 * listens on loopback http, which the API accepts only with NODE_ENV=test and
 * the issuer listed explicitly in OIDC_TRUSTED_ISSUERS.
 *
 * It also serves the endpoint a GitHub runner exposes to a job
 * (ACTIONS_ID_TOKEN_REQUEST_URL), so the bundled action can request tokens
 * exactly as it does on GitHub.
 */

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

interface SigningKey {
  kid: string;
  privateKey: PrivateKey;
  publicJwk: JWK;
}

export interface GithubTokenOptions {
  audience?: string | string[];
  /** Claims replacing or adding to the defaults; `undefined` removes one. */
  claims?: Record<string, unknown>;
  /** Seconds relative to now. */
  issuedAt?: number;
  expiresIn?: number;
  notBefore?: number;
  kid?: string;
  issuer?: string;
}

export const DEFAULT_CLAIMS = {
  sub: 'repo:octo-org/app:ref:refs/heads/main',
  repository: 'octo-org/app',
  repository_id: '123456789',
  repository_owner: 'octo-org',
  repository_owner_id: '987654',
  repository_visibility: 'private',
  workflow: 'deploy',
  workflow_ref: 'octo-org/app/.github/workflows/deploy.yml@refs/heads/main',
  workflow_sha: 'a'.repeat(40),
  job_workflow_ref: 'octo-org/app/.github/workflows/deploy.yml@refs/heads/main',
  job_workflow_sha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  ref_type: 'branch',
  sha: 'a'.repeat(40),
  event_name: 'push',
  actor: 'octocat',
  actor_id: '1',
  run_id: '1001',
  run_number: '7',
  run_attempt: '1',
  runner_environment: 'github-hosted',
};

export class OidcIssuer {
  /** Answer discovery and JWKS requests with 503 (simulated outage). */
  unavailable = false;
  jwksRequests = 0;
  /** Bearer the runner endpoint expects (ACTIONS_ID_TOKEN_REQUEST_TOKEN). */
  readonly requestToken = `runner-${randomUUID()}`;
  /** Claims the runner endpoint puts in tokens it issues. */
  runnerClaims: Record<string, unknown> = {};
  readonly runnerAudiences: string[] = [];

  private readonly keys = new Map<string, SigningKey>();
  private readonly published = new Set<string>();
  private active = '';
  private server!: Server;
  private port = 0;

  static async start(): Promise<OidcIssuer> {
    const issuer = new OidcIssuer();
    await issuer.rotate();
    issuer.server = createServer((req, res) => {
      void issuer.handle(req, res);
    });
    await new Promise<void>((resolve) => issuer.server.listen(0, '127.0.0.1', resolve));
    issuer.port = (issuer.server.address() as AddressInfo).port;
    return issuer;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  /** What a runner sets as ACTIONS_ID_TOKEN_REQUEST_URL. */
  get runnerUrl(): string {
    return `${this.url}/_runner/id-token?api-version=2.0`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  /** New active key; old keys stay published unless `retire` is set. */
  async rotate(options: { retire?: boolean } = {}): Promise<string> {
    const kid = `key-${String(this.keys.size + 1)}`;
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
    this.keys.set(kid, { kid, privateKey, publicJwk });
    if (options.retire) this.published.clear();
    this.published.add(kid);
    this.active = kid;
    return kid;
  }

  /** Signs with a key that is never published (an attacker's key with a known kid). */
  async unpublishedKey(): Promise<string> {
    const kid = `rogue-${String(this.keys.size + 1)}`;
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    this.keys.set(kid, { kid, privateKey, publicJwk: await exportJWK(publicKey) });
    return kid;
  }

  async token(options: GithubTokenOptions = {}): Promise<string> {
    const key = this.keys.get(options.kid ?? this.active);
    if (!key) throw new Error('unknown key');
    const now = Math.floor(Date.now() / 1000);
    const iat = now + (options.issuedAt ?? 0);
    const merged: Record<string, unknown> = {
      ...DEFAULT_CLAIMS,
      jti: randomUUID(),
      ...options.claims,
    };
    const claims = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    );
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
      .setIssuer(options.issuer ?? this.url)
      .setIssuedAt(iat)
      .setNotBefore(now + (options.notBefore ?? options.issuedAt ?? 0))
      .setExpirationTime(iat + (options.expiresIn ?? 300));
    if (options.audience !== undefined) jwt.setAudience(options.audience);
    return jwt.sign(key.privateKey);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    if (url.pathname === '/.well-known/openid-configuration') {
      if (this.unavailable) {
        this.json(res, 503, {});
        return;
      }
      this.json(res, 200, {
        issuer: this.url,
        jwks_uri: `${this.url}/.well-known/jwks`,
        subject_types_supported: ['public', 'pairwise'],
        response_types_supported: ['id_token'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
      return;
    }
    if (url.pathname === '/.well-known/jwks') {
      this.jwksRequests += 1;
      if (this.unavailable) {
        this.json(res, 503, {});
        return;
      }
      const keys = [...this.published].flatMap((kid) => {
        const key = this.keys.get(kid);
        return key ? [key.publicJwk] : [];
      });
      this.json(res, 200, { keys });
      return;
    }
    if (url.pathname === '/_runner/id-token') {
      if (req.headers.authorization !== `Bearer ${this.requestToken}`) {
        this.json(res, 401, { message: 'bad runner token' });
        return;
      }
      const audience = url.searchParams.get('audience') ?? undefined;
      if (audience) this.runnerAudiences.push(audience);
      const value = await this.token({
        ...(audience ? { audience } : {}),
        claims: this.runnerClaims,
      });
      this.json(res, 200, { value });
      return;
    }
    this.json(res, 404, {});
  }
}
