import { readFile, stat } from 'node:fs/promises';
import { SERVICE_CREDENTIAL_PATTERN } from '@envvault/shared';
import { EnvVaultMachineClient, type EnvVaultMachineClientOptions } from './machine.js';

/**
 * Node only helpers (`@envvault/sdk/node`). Kept out of the main entry so the
 * SDK stays usable where `node:fs` does not exist.
 */

export const CREDENTIAL_ENV = 'ENVVAULT_SERVICE_CREDENTIAL';
export const CREDENTIAL_FILE_ENV = 'ENVVAULT_SERVICE_CREDENTIAL_FILE';
export const API_URL_ENV = 'ENVVAULT_API_URL';

export class EnvVaultConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvVaultConfigurationError';
  }
}

function checked(value: string, origin: string): string {
  const token = value.trim();
  // Never include what was read: it may be some other secret pasted by mistake.
  if (!SERVICE_CREDENTIAL_PATTERN.test(token)) {
    throw new EnvVaultConfigurationError(`${origin} does not hold an EnvVault service credential`);
  }
  return token;
}

/** Reads the credential from a file only its owner can read (POSIX permissions). */
export async function readCredentialFile(path: string): Promise<string> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new EnvVaultConfigurationError('The credential file cannot be read');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new EnvVaultConfigurationError(
      'The credential file can be read by other users (chmod 600)',
    );
  }
  return checked(await readFile(path, 'utf8'), 'The credential file');
}

/**
 * A machine client configured from the environment, as in CI:
 * ENVVAULT_API_URL, and ENVVAULT_SERVICE_CREDENTIAL or
 * ENVVAULT_SERVICE_CREDENTIAL_FILE. The credential is read when first
 * needed and is never stored elsewhere.
 */
export function machineClientFromEnvironment(
  env: Record<string, string | undefined> = process.env,
  options: Omit<EnvVaultMachineClientOptions, 'baseUrl' | 'credential'> & { baseUrl?: string } = {},
): EnvVaultMachineClient {
  const baseUrl = options.baseUrl ?? env[API_URL_ENV];
  if (!baseUrl) throw new EnvVaultConfigurationError(`Set ${API_URL_ENV}`);
  const inline = env[CREDENTIAL_ENV];
  const file = env[CREDENTIAL_FILE_ENV];
  if (!inline && !file) {
    throw new EnvVaultConfigurationError(`Set ${CREDENTIAL_ENV} or ${CREDENTIAL_FILE_ENV}`);
  }
  return new EnvVaultMachineClient({
    ...options,
    baseUrl,
    credential: inline ? checked(inline, CREDENTIAL_ENV) : () => readCredentialFile(file ?? ''),
  });
}
