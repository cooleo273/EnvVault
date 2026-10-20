import { KeyConfigurationError } from '../errors.js';
import { parseKeyringJson } from './keyring.js';
import { readKeyringFile, writeKeyringFile } from './keyring-file.js';
import { LocalKeyProvider } from './local-provider.js';

const INLINE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type LocalKeyringConfig =
  /** Absolute path to a keyring file created by `pnpm crypto:init:dev`. */
  | { file: string; inline?: never }
  /** Base64 of the keyring JSON, from a server-side secret environment variable. */
  | { inline: string; file?: never };

/**
 * Loads and self-tests the local provider. Never creates keys: a missing or
 * invalid keyring is a configuration error, not a reason to generate one.
 */
export async function loadLocalKeyProvider(
  config: LocalKeyringConfig,
  nodeEnv: string | undefined,
): Promise<LocalKeyProvider> {
  let provider: LocalKeyProvider;
  if (config.file !== undefined) {
    const path = config.file;
    provider = new LocalKeyProvider(await readKeyringFile(path), {
      nodeEnv,
      source: { kind: 'file', path },
      reload: () => readKeyringFile(path),
      persist: (keyring) => writeKeyringFile(path, keyring),
    });
  } else {
    const encoded = config.inline.trim();
    if (encoded === '' || !INLINE_PATTERN.test(encoded)) {
      throw new KeyConfigurationError('Inline keyring is not valid base64');
    }
    const text = Buffer.from(encoded, 'base64').toString('utf8');
    // Rotation needs durable storage; an environment variable cannot be updated in place.
    provider = new LocalKeyProvider(parseKeyringJson(text), {
      nodeEnv,
      source: { kind: 'environment' },
    });
  }
  await provider.validateKeyConfiguration();
  return provider;
}
