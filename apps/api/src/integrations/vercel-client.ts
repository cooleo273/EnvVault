import { INTEGRATION_ERROR_CODES } from '@envvault/shared';

/**
 * Minimal Vercel REST API client for deployment integrations, written against
 * the documented endpoints (docs/integrations/vercel.md, section 9):
 *
 * - GET /v2/user, GET /v2/teams/{teamId}: verify the token and its account
 * - GET /v10/projects, GET /v9/projects/{id}: discover and link projects
 * - GET /v9/projects/{id}/custom-environments
 * - GET /v10/projects/{id}/env (never with decrypt=true): ids, keys, targets
 *   and updatedAt only
 * - POST /v10/projects/{id}/env, PATCH and DELETE /v9/projects/{id}/env/{envId}
 *
 * The token is sent only in the Authorization header and never logged.
 * Errors carry a sanitised code, never the provider's body (which can echo
 * submitted values).
 */

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
    this.name = 'ProviderError';
  }

  /** Repeating the same request cannot help (and may harm). */
  get permanent(): boolean {
    return this.status !== null && this.status < 500 && this.status !== 429;
  }
}

export interface VercelAccount {
  id: string;
  name: string;
  type: 'team' | 'user';
}

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
}

export interface VercelCustomEnvironment {
  id: string;
  slug: string;
  type: 'development' | 'preview' | 'production';
}

export type VercelTarget = 'development' | 'preview' | 'production';

/** A provider variable as listed: no value is requested or kept. */
export interface VercelVariable {
  id: string;
  key: string;
  target: VercelTarget[];
  gitBranch: string | null;
  customEnvironmentIds: string[];
  type: string;
  updatedAt: number;
}

export interface VariableWrite {
  key: string;
  value: string;
  type: 'encrypted' | 'sensitive';
  target?: VercelTarget[];
  gitBranch?: string;
  customEnvironmentIds?: string[];
  comment: string;
}

function retryAfter(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header && /^\d+$/.test(header)) return Number(header);
  // Not documented by Vercel as stable; used only when Retry-After is absent.
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset && /^\d+$/.test(reset)) {
    return Math.max(1, Number(reset) - Math.floor(Date.now() / 1000));
  }
  return null;
}

function errorFor(response: Response): ProviderError {
  switch (response.status) {
    case 401:
      return new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_AUTH_FAILED, 401);
    case 403:
      return new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_FORBIDDEN, 403);
    case 404:
      return new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_NOT_FOUND, 404);
    case 429:
      return new ProviderError(
        INTEGRATION_ERROR_CODES.PROVIDER_RATE_LIMITED,
        429,
        retryAfter(response),
      );
    default:
      return response.status >= 500
        ? new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_UNAVAILABLE, response.status)
        : new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, response.status);
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function toVariable(raw: unknown): VercelVariable | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  const key = text(r.key);
  if (!id || !key || typeof r.updatedAt !== 'number') return null;
  const targets = Array.isArray(r.target)
    ? r.target
    : typeof r.target === 'string'
      ? [r.target]
      : [];
  return {
    id,
    key,
    target: targets.filter((t): t is VercelTarget =>
      ['development', 'preview', 'production'].includes(String(t)),
    ),
    // Vercel reports no branch as an empty string or omits it.
    gitBranch: text(r.gitBranch) === '' ? null : text(r.gitBranch),
    customEnvironmentIds: Array.isArray(r.customEnvironmentIds)
      ? r.customEnvironmentIds.filter((v): v is string => typeof v === 'string')
      : [],
    type: text(r.type) ?? 'encrypted',
    updatedAt: r.updatedAt,
  };
}

export interface VercelClientOptions {
  baseUrl: string;
  token: string;
  teamId: string | null;
  fetch?: typeof fetch;
}

export class VercelClient {
  readonly #token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: VercelClientOptions) {
    this.#token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string, query: Record<string, string | undefined> = {}): string {
    const url = new URL(path, this.options.baseUrl);
    if (this.options.teamId) url.searchParams.set('teamId', this.options.teamId);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    return url.toString();
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    query: Record<string, string | undefined> = {},
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, query), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_UNAVAILABLE, null);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw errorFor(response);
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_RESPONSE_BYTES) {
      throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, response.status);
    }
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) {
      throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, response.status);
    }
    try {
      return raw === '' ? null : (JSON.parse(raw) as unknown);
    } catch {
      throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, response.status);
    }
  }

  /** Verifies the token and names the account it acts for. */
  async account(): Promise<VercelAccount> {
    if (this.options.teamId) {
      const team = (await this.request(
        'GET',
        `/v2/teams/${encodeURIComponent(this.options.teamId)}`,
      )) as Record<string, unknown> | null;
      const id = text(team?.id);
      if (!id) throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, 200);
      return { id, name: text(team?.name) ?? text(team?.slug) ?? id, type: 'team' };
    }
    const body = (await this.request('GET', '/v2/user')) as Record<string, unknown> | null;
    const user = (body?.user ?? null) as Record<string, unknown> | null;
    const id = text(user?.id) ?? text(user?.uid);
    if (!id) throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, 200);
    return { id, name: text(user?.username) ?? text(user?.name) ?? id, type: 'user' };
  }

  async projects(search?: string): Promise<VercelProject[]> {
    const body = await this.request('GET', '/v10/projects', { limit: '100', search });
    const list = Array.isArray(body)
      ? body
      : Array.isArray((body as { projects?: unknown } | null)?.projects)
        ? (body as { projects: unknown[] }).projects
        : [];
    return list.flatMap((p) => {
      const r = p as Record<string, unknown>;
      const id = text(r.id);
      const name = text(r.name);
      return id && name ? [{ id, name, framework: text(r.framework) }] : [];
    });
  }

  async project(projectId: string): Promise<VercelProject> {
    const r = (await this.request(
      'GET',
      `/v9/projects/${encodeURIComponent(projectId)}`,
    )) as Record<string, unknown> | null;
    const id = text(r?.id);
    const name = text(r?.name);
    if (!id || !name) throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, 200);
    return { id, name, framework: text(r?.framework) };
  }

  async customEnvironments(projectId: string): Promise<VercelCustomEnvironment[]> {
    const body = (await this.request(
      'GET',
      `/v9/projects/${encodeURIComponent(projectId)}/custom-environments`,
    )) as { environments?: unknown } | null;
    const list = Array.isArray(body?.environments) ? body.environments : [];
    return list.flatMap((e) => {
      const r = e as Record<string, unknown>;
      const id = text(r.id);
      const slug = text(r.slug);
      const type = text(r.type);
      return id && slug && (type === 'development' || type === 'preview' || type === 'production')
        ? [{ id, slug, type }]
        : [];
    });
  }

  /** Every variable of the project, without values (EnvVault never asks for decryption). */
  async variables(projectId: string): Promise<VercelVariable[]> {
    const body = (await this.request(
      'GET',
      `/v10/projects/${encodeURIComponent(projectId)}/env`,
    )) as { envs?: unknown } | null;
    const list = Array.isArray(body?.envs) ? body.envs : [];
    return list.flatMap((v) => {
      const parsed = toVariable(v);
      return parsed ? [parsed] : [];
    });
  }

  /** One variable per request, so a failure names exactly one key. */
  async create(projectId: string, write: VariableWrite): Promise<VercelVariable> {
    const body = (await this.request(
      'POST',
      `/v10/projects/${encodeURIComponent(projectId)}/env`,
      {},
      write,
    )) as { created?: unknown; failed?: unknown } | null;
    const failed = Array.isArray(body?.failed) ? body.failed : [];
    if (failed.length > 0) {
      throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, 400);
    }
    const created = toVariable(Array.isArray(body?.created) ? body.created[0] : body?.created);
    if (!created) throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, 201);
    return created;
  }

  async update(
    projectId: string,
    variableId: string,
    write: VariableWrite,
  ): Promise<VercelVariable> {
    const body = await this.request(
      'PATCH',
      `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(variableId)}`,
      {},
      write,
    );
    const updated = toVariable(body);
    if (!updated) throw new ProviderError(INTEGRATION_ERROR_CODES.PROVIDER_REJECTED, 200);
    return updated;
  }

  async remove(projectId: string, variableId: string, customEnvironmentId?: string): Promise<void> {
    await this.request(
      'DELETE',
      `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(variableId)}`,
      { customEnvironmentId },
    );
  }

  /** Never serialises the token. */
  toJSON(): Record<string, unknown> {
    return { type: 'VercelClient', teamId: this.options.teamId };
  }
}
