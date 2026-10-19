import { Logger } from '@nestjs/common';

export type CredentialCheckResult = 'valid' | 'invalid' | 'unavailable';

/**
 * Re-verifies a signed-in user's credentials for step-up ("sudo mode").
 * EnvVault never checks passwords itself; implementations delegate to the
 * identity provider.
 */
export interface CredentialVerifier {
  verifyPassword(input: {
    authUserId: string;
    email: string;
    password: string;
  }): Promise<CredentialCheckResult>;
}

export interface NeonPasswordVerifierOptions {
  /** NEON_AUTH_BASE_URL (no trailing slash). */
  baseUrl: string;
  /** Web app origin registered as a trusted domain in Neon Auth. */
  trustedOrigin: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface SignInResponseBody {
  user?: { id?: unknown };
}

/**
 * Re-verifies a password by asking Neon Auth to sign the user in, server to
 * server (Better Auth `POST /sign-in/email`), then immediately signing out the
 * temporary session that creates. The password is forwarded once over TLS and
 * never stored or logged.
 *
 * Both requests send the web app's origin, which must be a trusted domain in
 * Neon Auth: Better Auth enforces its CSRF origin check whenever a request
 * carries cookies or Fetch-Metadata headers, and Node's fetch always sends
 * `Sec-Fetch-Mode`. (Verified against Better Auth 1.7.6, the version used by
 * the Neon SDK.)
 */
export class NeonPasswordVerifier implements CredentialVerifier {
  private readonly logger = new Logger(NeonPasswordVerifier.name);
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: NeonPasswordVerifierOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async verifyPassword(input: {
    authUserId: string;
    email: string;
    password: string;
  }): Promise<CredentialCheckResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          origin: this.options.trustedOrigin,
        },
        body: JSON.stringify({ email: input.email, password: input.password, rememberMe: false }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return 'unavailable';
    }

    if (response.status === 429 || response.status >= 500) return 'unavailable';
    if (!response.ok) {
      await response.body?.cancel();
      return 'invalid';
    }

    const body = (await response.json().catch(() => undefined)) as SignInResponseBody | undefined;
    await this.endTemporarySession(response);

    // Defence in depth: the credentials must belong to the token's subject.
    return body?.user?.id === input.authUserId ? 'valid' : 'invalid';
  }

  private async endTemporarySession(signIn: Response): Promise<void> {
    const cookie = signIn.headers
      .getSetCookie()
      .map((header) => header.split(';', 1)[0]?.trim())
      .filter((pair): pair is string => Boolean(pair))
      .join('; ');
    if (!cookie) return;
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/sign-out`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: this.options.trustedOrigin,
        },
        body: '{}',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await response.body?.cancel();
      if (!response.ok) {
        this.logger.warn({ status: response.status }, 'Could not end temporary step-up session');
      }
    } catch {
      this.logger.warn('Could not end temporary step-up session');
    }
  }
}
