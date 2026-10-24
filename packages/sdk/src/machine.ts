import type {
  MachineEnvironment,
  MachineScope,
  MachineSelf,
  MachineToken,
  MachineVariableList,
  RuntimeConfiguration,
  RuntimeConfigurationInput,
} from '@envvault/shared';
import { EnvVaultClient, type EnvVaultClientOptions } from './client.js';
import { EnvVaultApiError } from './errors.js';

export interface EnvVaultMachineClientOptions extends Omit<
  EnvVaultClientOptions,
  'getAccessToken'
> {
  /**
   * The service credential (`evv_sk_…`), or a function returning it (for
   * example from a secrets manager). It is sent only to `POST /machine/token`.
   */
  credential: string | (() => Promise<string>);
  /** Narrow access tokens to some of the credential's scopes. */
  scopes?: MachineScope[];
  /** Narrow access tokens to some environments of the identity's project. */
  environmentIds?: string[];
  /** Renew the access token this long before it expires. Default 60000. */
  renewBeforeMs?: number;
}

const TOKEN_REJECTED = new Set(['TOKEN_EXPIRED', 'TOKEN_REVOKED', 'TOKEN_INVALID']);

function matches(env: MachineEnvironment, ref: string): boolean {
  const lower = ref.toLowerCase();
  return env.id === lower || env.slug === lower || env.name.toLowerCase() === lower;
}

/**
 * Client for machine identities (CI jobs, servers, workers). It exchanges the
 * service credential for short lived access tokens on demand, renews them
 * before they expire, and calls only the `/machine` routes. Use
 * EnvVaultClient for everything a person does.
 *
 * Values returned by `runtime` are plaintext: keep them in memory, pass them
 * to the process that needs them, and never log them.
 */
export class EnvVaultMachineClient {
  readonly #credential: string | (() => Promise<string>);
  readonly #options: EnvVaultMachineClientOptions;
  readonly #anonymous: EnvVaultClient;
  readonly #api: EnvVaultClient;
  #token: MachineToken | null = null;
  #exchanging: Promise<MachineToken> | null = null;

  constructor(options: EnvVaultMachineClientOptions) {
    const { credential, scopes: _scopes, environmentIds: _environments, ...client } = options;
    this.#credential = credential;
    this.#options = options;
    this.#anonymous = new EnvVaultClient(client);
    this.#api = new EnvVaultClient({ ...client, getAccessToken: () => this.accessToken() });
  }

  /** The current access token, exchanging or renewing the credential when needed. */
  async accessToken(): Promise<string> {
    const renewBefore = this.#options.renewBeforeMs ?? 60_000;
    const token = this.#token;
    if (token && Date.parse(token.expiresAt) - renewBefore > Date.now()) return token.accessToken;
    return (await this.authenticate()).accessToken;
  }

  /** Exchanges the credential now. Concurrent callers share one exchange. */
  async authenticate(): Promise<MachineToken> {
    this.#exchanging ??= (async () => {
      try {
        const credential =
          typeof this.#credential === 'string' ? this.#credential : await this.#credential();
        const token = await this.#anonymous.exchangeServiceCredential(credential, {
          ...(this.#options.scopes ? { scopes: this.#options.scopes } : {}),
          ...(this.#options.environmentIds ? { environmentIds: this.#options.environmentIds } : {}),
        });
        this.#token = token;
        return token;
      } finally {
        this.#exchanging = null;
      }
    })();
    return this.#exchanging;
  }

  /**
   * Runs a call; when the server rejects the access token (expired early,
   * revoked by an admin) it exchanges once more and repeats. That is safe
   * for any method: a rejected token means the request was not processed.
   */
  async #call<T>(run: (api: EnvVaultClient) => Promise<T>): Promise<T> {
    try {
      return await run(this.#api);
    } catch (error) {
      if (!(error instanceof EnvVaultApiError) || error.statusCode !== 401) throw error;
      if (!TOKEN_REJECTED.has(error.code) || this.#token === null) throw error;
      this.#token = null;
      return run(this.#api);
    }
  }

  /** Identity, credential, token scopes and the environments it may use. */
  identity(): Promise<MachineSelf> {
    return this.#call((api) => api.machineSelf());
  }

  environments(): Promise<MachineEnvironment[]> {
    return this.#call((api) => api.machineEnvironments());
  }

  /** An environment by id, slug or name, among those the identity may read. */
  async resolveEnvironment(ref: string): Promise<MachineEnvironment> {
    const found = (await this.environments()).find((env) => matches(env, ref));
    if (!found) {
      throw new EnvVaultApiError(404, {
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `No environment "${ref}" is available to this machine identity`,
      });
    }
    return found;
  }

  /** Variable names and metadata (needs `secret:list`); never values. */
  async variables(environment: string): Promise<MachineVariableList> {
    const env = await this.resolveEnvironment(environment);
    return this.#call((api) => api.machineVariables(env.id));
  }

  /** Decrypted values for this process (needs `secret:runtime`). Audited; never cached. */
  async runtime(
    environment: string,
    input: RuntimeConfigurationInput = {},
  ): Promise<RuntimeConfiguration> {
    const env = await this.resolveEnvironment(environment);
    return this.#call((api) => api.machineRuntime(env.id, input));
  }

  /** Values as a plain record (later keys win), for handing to a framework or child process. */
  async runtimeValues(
    environment: string,
    input: RuntimeConfigurationInput = {},
  ): Promise<Record<string, string>> {
    const config = await this.runtime(environment, input);
    return Object.fromEntries(config.values.map((v) => [v.key, v.value]));
  }

  /** Ends the current access token on the server. The credential stays valid. */
  async close(): Promise<void> {
    const token = this.#token;
    this.#token = null;
    if (!token) return;
    const api = new EnvVaultClient({
      ...this.#options,
      getAccessToken: () => Promise.resolve(token.accessToken),
    });
    await api.revokeMachineToken().catch(() => undefined);
  }

  /** Never serializes the credential or tokens. */
  toJSON(): Record<string, unknown> {
    return { type: 'EnvVaultMachineClient', authenticated: this.#token !== null };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `EnvVaultMachineClient { authenticated: ${String(this.#token !== null)} }`;
  }
}
