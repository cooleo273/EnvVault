import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CliError, EXIT } from './errors.js';

const SERVICE = 'envvault-cli';

/** What the CLI keeps between commands. Never written to project files or printed. */
export const credentialSchema = z.object({
  version: z.literal(1),
  apiUrl: z.string(),
  /** Origin of the web app, for links (password confirmation, approvals). */
  webUrl: z.string().optional(),
  sessionId: z.uuid(),
  email: z.string(),
  accessToken: z.string().startsWith('evv_at_'),
  accessExpiresAt: z.iso.datetime(),
  refreshToken: z.string().startsWith('evv_rt_'),
  refreshExpiresAt: z.iso.datetime(),
});
export type Credential = z.infer<typeof credentialSchema>;

export interface CredentialStore {
  readonly kind: 'keychain' | 'file';
  read(apiUrl: string): Promise<Credential | null>;
  write(credential: Credential): Promise<void>;
  remove(apiUrl: string): Promise<void>;
}

function parse(text: string | null | undefined): Credential | null {
  if (!text) return null;
  try {
    const parsed = credentialSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** macOS Keychain, Windows Credential Manager or the Secret Service on Linux. */
class KeychainStore implements CredentialStore {
  readonly kind = 'keychain' as const;

  private async entry(apiUrl: string) {
    try {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      return new AsyncEntry(SERVICE, apiUrl);
    } catch {
      throw unavailable();
    }
  }

  async read(apiUrl: string): Promise<Credential | null> {
    const entry = await this.entry(apiUrl);
    try {
      return parse(await entry.getPassword());
    } catch {
      throw unavailable();
    }
  }

  async write(credential: Credential): Promise<void> {
    const entry = await this.entry(credential.apiUrl);
    try {
      await entry.setPassword(JSON.stringify(credential));
    } catch {
      throw unavailable();
    }
  }

  async remove(apiUrl: string): Promise<void> {
    const entry = await this.entry(apiUrl);
    try {
      await entry.deletePassword();
    } catch {
      // Nothing stored is the goal; a missing entry is fine.
    }
  }
}

function unavailable(): CliError {
  return new CliError(
    'The operating system credential store is not available.',
    EXIT.config,
    'On a machine without one (for example a headless Linux host), set ENVVAULT_CREDENTIAL_STORE=file to keep credentials in a file only you can read.',
  );
}

/**
 * A JSON file readable only by its owner (mode 0600 on macOS and Linux; on
 * Windows the file inherits the ACL of the user profile). Opt in only.
 */
class FileStore implements CredentialStore {
  readonly kind = 'file' as const;
  constructor(private readonly dir: string) {}

  private get path(): string {
    return join(this.dir, 'credentials.json');
  }

  private async all(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new CliError('Cannot read the credential file.', EXIT.config);
    }
    if (process.platform !== 'win32' && ((await stat(this.path)).mode & 0o077) !== 0) {
      throw new CliError(
        'The credential file can be read by other users.',
        EXIT.config,
        `Run: chmod 600 "${this.path}" (or envvault logout to remove it).`,
      );
    }
    try {
      const value = JSON.parse(text) as unknown;
      return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async save(all: Record<string, unknown>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(all, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }

  async read(apiUrl: string): Promise<Credential | null> {
    const value = (await this.all())[apiUrl];
    return value === undefined ? null : parse(JSON.stringify(value));
  }

  async write(credential: Credential): Promise<void> {
    const all = await this.all();
    all[credential.apiUrl] = credential;
    await this.save(all);
  }

  async remove(apiUrl: string): Promise<void> {
    const all: Record<string, unknown> = await this.all().catch(() => ({}));
    if (!(apiUrl in all)) return;
    Reflect.deleteProperty(all, apiUrl);
    if (Object.keys(all).length === 0) await rm(this.path, { force: true });
    else await this.save(all);
  }
}

export function credentialStore(
  env: Record<string, string | undefined>,
  dir: string,
): CredentialStore {
  const choice = env.ENVVAULT_CREDENTIAL_STORE ?? 'keychain';
  if (choice === 'file') return new FileStore(dir);
  if (choice !== 'keychain') {
    throw new CliError('ENVVAULT_CREDENTIAL_STORE must be keychain or file.', EXIT.usage);
  }
  return new KeychainStore();
}
