import { KeyConfigurationError } from './errors.js';

/**
 * Key management and secret encryption run on the server only. Refuses to run
 * where a DOM `window` exists (a browser bundle or a client component).
 */
export function assertServerRuntime(): void {
  if ('window' in globalThis || typeof process === 'undefined' || !process.versions.node) {
    throw new KeyConfigurationError('Encryption is only available in server-side code');
  }
}
