export { AAD_DOMAINS, AAD_ENCODING_VERSION, encodeAad, type AadDomain } from './aad.js';
export { DATA_KEY_BYTES, DataKey } from './data-key.js';
export * from './errors.js';
export type * from './provider.js';
export {
  assertSecretEnvelope,
  MAX_SECRET_VALUE_BYTES,
  SECRET_ENVELOPE_ALGORITHM,
  SECRET_ENVELOPE_FORMAT_VERSION,
  SecretCipher,
  type RewrapResult,
  type SecretEncryptionContext,
  type SecretEnvelope,
} from './secret-cipher.js';
export {
  rewrapAll,
  type RewrapFailure,
  type RewrapItem,
  type RewrapOptions,
  type RewrapProgress,
} from './rotation.js';
export {
  generateKeyring,
  KEYRING_FORMAT,
  KEYRING_FORMAT_VERSION,
  LOCAL_PROVIDER_ID,
  parseKeyring,
  parseKeyringJson,
  retireKeyVersion,
  rotateKeyring,
  serializeKeyring,
  type Keyring,
  type KeyringVersion,
} from './local/keyring.js';
export { readKeyringFile, writeKeyringFile, keyringFileExists } from './local/keyring-file.js';
export {
  LOCAL_WRAPPED_KEY_BYTES,
  LocalKeyProvider,
  type LocalKeyProviderOptions,
  type LocalKeyringSource,
} from './local/local-provider.js';
export { loadLocalKeyProvider, type LocalKeyringConfig } from './local/load.js';
