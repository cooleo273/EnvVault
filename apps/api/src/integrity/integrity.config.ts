import { IntegrityKeys, isCryptoError, readIntegrityKeyFile } from '@envvault/crypto';
import type { Env } from '../config/env.js';

/**
 * `configured`: keys from INTEGRITY_KEY_FILE; audit events are sealed.
 * `ephemeral`: development without a key file; keys live only in this
 * process, so nothing is sealed (seals could not be verified after a
 * restart) and idempotency fingerprints do not survive restarts.
 */
export type IntegrityRuntime =
  | { readonly status: 'configured'; readonly keys: IntegrityKeys }
  | { readonly status: 'ephemeral'; readonly keys: IntegrityKeys };

export class IntegrityConfigurationError extends Error {
  constructor(reason: string) {
    super(`Invalid integrity key configuration: ${reason}`);
    this.name = 'IntegrityConfigurationError';
  }
}

export async function loadIntegrity(env: Env): Promise<IntegrityRuntime> {
  if (!env.INTEGRITY_KEY_FILE) return { status: 'ephemeral', keys: IntegrityKeys.ephemeral() };
  try {
    return {
      status: 'configured',
      keys: new IntegrityKeys(await readIntegrityKeyFile(env.INTEGRITY_KEY_FILE)),
    };
  } catch (error) {
    throw new IntegrityConfigurationError(
      isCryptoError(error) ? error.message : 'the key file could not be loaded',
    );
  }
}

export const INTEGRITY_RUNTIME = Symbol('INTEGRITY_RUNTIME');
