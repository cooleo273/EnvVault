import {
  isCryptoError,
  type KeyManagementProvider,
  type Keyring,
  LocalKeyProvider,
  readKeyringFile,
} from '@envvault/crypto';
import { createPrismaClient, type PrismaClient, summarizeDatabaseError } from '@envvault/database';
import type { Env } from '../config/env.js';
import { loadEnv } from '../config/load-env.js';

/** Output sink. Commands print counts, ids and statuses only, never key material or values. */
export interface OpsIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export class OpsError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'OpsError';
  }
}

/**
 * Lazily built dependencies, so commands that only touch files (recovery
 * keys, restoring a backup into an isolated directory) run without the API
 * configuration or a database.
 */
export class OpsContext {
  #env: Env | undefined;
  #db: PrismaClient | undefined;

  constructor(
    readonly io: OpsIo,
    private readonly envSource: () => Env = loadEnv,
    /** Tests pass the client they already hold; it is left open on close. */
    private readonly sharedDb?: PrismaClient,
  ) {}

  get env(): Env {
    this.#env ??= this.envSource();
    return this.#env;
  }

  get db(): PrismaClient {
    if (this.sharedDb) return this.sharedDb;
    if (!this.#db) {
      // Operators must see which database a command touches; credentials are left out.
      const url = new URL(this.env.DATABASE_URL);
      this.io.err(`Database: ${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`);
    }
    this.#db ??= createPrismaClient({
      connectionString: this.env.DATABASE_URL,
      applicationName: 'envvault-ops',
      connectionTimeoutMs: this.env.DATABASE_CONNECT_TIMEOUT_MS,
    });
    return this.#db;
  }

  /** The configured keyring file. Rotation and retirement need a file, not an inline keyring. */
  keyringPath(): string {
    if (this.env.ENCRYPTION_PROVIDER !== 'local' || !this.env.ENCRYPTION_KEYRING_FILE) {
      throw new OpsError(
        'This command needs ENCRYPTION_PROVIDER=local and ENCRYPTION_KEYRING_FILE',
      );
    }
    return this.env.ENCRYPTION_KEYRING_FILE;
  }

  async keyring(): Promise<Keyring> {
    return readKeyringFile(this.keyringPath());
  }

  /** A provider over the given keyring, under the same usage rules as the API. */
  provider(
    keyring: Keyring,
    path = this.keyringPath(),
  ): KeyManagementProvider & {
    destroy(): void;
  } {
    return new LocalKeyProvider(keyring, {
      nodeEnv: this.env.NODE_ENV,
      acceptSelfManagedProduction: this.env.ENCRYPTION_SELF_MANAGED_ACKNOWLEDGED,
      source: { kind: 'file', path },
    });
  }

  async close(): Promise<void> {
    await this.#db?.$disconnect();
  }
}

/** A failure description safe to print: categories, never contents. */
export function describeFailure(error: unknown): string {
  if (error instanceof OpsError) return error.message;
  if (isCryptoError(error)) return error.message;
  const database = summarizeDatabaseError(error);
  if (database) return `database error (${database.code ?? database.type})`;
  if (error instanceof Error && error.name === 'EnvValidationError') return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code ? `file system error (${code})` : 'unexpected error';
}
