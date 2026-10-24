import { spawn } from 'node:child_process';
import { createEnvVaultClient, type EnvVaultClient } from '@envvault/sdk';
import pc from 'picocolors';
import {
  DEFAULT_API_URL,
  findProjectConfig,
  normalizeApiUrl,
  readUserConfig,
  type FoundProjectConfig,
  type UserConfig,
} from './config.js';
import { credentialStore, type CredentialStore } from './credentials.js';
import { machineMode } from './machine.js';
import { configDir } from './paths.js';

export const CLI_VERSION = '0.1.0';

export interface Choice<T> {
  name: string;
  value: T;
  description?: string;
}

export interface Prompts {
  select<T>(message: string, choices: Choice<T>[]): Promise<T>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
}

/** Everything a command touches outside its own logic, so tests can replace it. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  interactive: boolean;
  prompts?: Prompts;
  openBrowser?: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Reads all of standard input (for --from-stdin); absent when stdin is a terminal. */
  readStdin?: () => Promise<string>;
}

export interface GlobalOptions {
  apiUrl?: string;
  json?: boolean;
}

export class Context {
  readonly dir: string;
  readonly color: boolean;
  #project: FoundProjectConfig | null | undefined;
  #user: UserConfig | undefined;
  #store: CredentialStore | undefined;

  constructor(
    readonly io: CliIo,
    readonly options: GlobalOptions,
  ) {
    this.dir = configDir(io.env);
    this.color = io.interactive && io.env.NO_COLOR === undefined && io.env.TERM !== 'dumb';
  }

  get json(): boolean {
    return this.options.json === true;
  }

  /** A service credential in the environment makes every command act as that machine identity. */
  get machine(): boolean {
    return machineMode(this.io.env);
  }

  get paint() {
    return pc.createColors(this.color);
  }

  async project(): Promise<FoundProjectConfig | null> {
    if (this.#project === undefined) this.#project = await findProjectConfig(this.io.cwd);
    return this.#project;
  }

  async user(): Promise<UserConfig> {
    this.#user ??= await readUserConfig(this.dir);
    return this.#user;
  }

  get store(): CredentialStore {
    this.#store ??= credentialStore(this.io.env, this.dir);
    return this.#store;
  }

  /** Flag, environment, project link, user configuration, then the default. */
  async apiUrl(): Promise<string> {
    const value =
      this.options.apiUrl ??
      this.io.env.ENVVAULT_API_URL ??
      (await this.project())?.config.apiUrl ??
      (await this.user()).apiUrl ??
      DEFAULT_API_URL;
    return normalizeApiUrl(value);
  }

  client(baseUrl: string, getAccessToken?: () => Promise<string | null>): EnvVaultClient {
    return createEnvVaultClient({
      baseUrl,
      timeoutMs: 15_000,
      retries: 2,
      userAgent: `envvault-cli/${CLI_VERSION}`,
      ...(this.io.fetch ? { fetch: this.io.fetch } : {}),
      ...(getAccessToken ? { getAccessToken } : {}),
    });
  }

  out(text: string): void {
    this.io.stdout(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** Progress and warnings go to stderr, so stdout stays clean for --json and pipes. */
  note(text: string): void {
    this.io.stderr(text.endsWith('\n') ? text : `${text}\n`);
  }

  printJson(value: unknown): void {
    this.out(JSON.stringify(value, null, 2));
  }

  sleep(ms: number): Promise<void> {
    return this.io.sleep ? this.io.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  async openBrowser(url: string): Promise<void> {
    if (this.io.openBrowser) return this.io.openBrowser(url);
    await openWithSystem(url);
  }
}

/** Opens a URL with the platform's handler, without a shell. */
function openWithSystem(url: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Renders rows as aligned columns. */
export function table(rows: string[][]): string {
  const widths = rows.reduce<number[]>(
    (acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)),
    [],
  );
  return rows
    .map((row) =>
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  '),
    )
    .join('\n');
}
