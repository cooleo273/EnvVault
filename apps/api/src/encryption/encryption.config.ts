import { isCryptoError, type KeyManagementProvider, loadLocalKeyProvider } from '@envvault/crypto';
import type { Env } from '../config/env.js';

/** Encryption state resolved before the Nest application is created. */
export type EncryptionRuntime =
  | { readonly status: 'disabled' }
  | { readonly status: 'ready'; readonly provider: KeyManagementProvider };

export const DISABLED_ENCRYPTION: EncryptionRuntime = Object.freeze({ status: 'disabled' });

/**
 * Raised when encryption is configured but unusable (missing or malformed
 * keyring, wrong permissions, forbidden environment). Distinct from
 * EnvValidationError and from general start-up failures. The message names
 * the problem only, never key material or file contents.
 */
export class EncryptionConfigurationError extends Error {
  constructor(reason: string) {
    super(`Invalid encryption configuration: ${reason}`);
    this.name = 'EncryptionConfigurationError';
  }
}

/**
 * Loads and self-tests the configured key provider. Never generates keys:
 * without explicit configuration encryption stays disabled.
 */
export async function loadEncryption(env: Env): Promise<EncryptionRuntime> {
  if (env.ENCRYPTION_PROVIDER === 'none') return DISABLED_ENCRYPTION;
  try {
    const provider = await loadLocalKeyProvider(
      env.ENCRYPTION_KEYRING_FILE !== undefined
        ? { file: env.ENCRYPTION_KEYRING_FILE }
        : { inline: env.ENCRYPTION_LOCAL_KEYRING ?? '' },
      env.NODE_ENV,
    );
    return { status: 'ready', provider };
  } catch (error) {
    throw new EncryptionConfigurationError(
      isCryptoError(error) ? error.message : 'the key provider could not be initialised',
    );
  }
}
