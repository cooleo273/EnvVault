/**
 * Error categories raised by @envvault/crypto.
 *
 * Messages are fixed, generic strings. They never contain key material,
 * plaintext, ciphertext or OpenSSL diagnostics, and no underlying error is
 * attached as `cause`, so errors are safe to log and to map to API responses.
 */
export type CryptoErrorCode =
  /** Keys are missing, malformed, wrongly sized or not allowed in this environment. */
  | 'KEY_CONFIGURATION'
  /** The envelope references a key id or version this provider does not hold. */
  | 'KEY_NOT_FOUND'
  /** Authentication failed: tampering, a wrong key or a wrong context (indistinguishable on purpose). */
  | 'DECRYPTION_FAILED'
  /** The envelope is structurally invalid (types, lengths, encodings). */
  | 'MALFORMED_ENVELOPE'
  /** The envelope format version, algorithm or provider is not supported. */
  | 'UNSUPPORTED_ENVELOPE'
  /** The caller passed invalid input (context, plaintext size, encoding). */
  | 'INVALID_INPUT'
  /** Encryption is not configured for this process. */
  | 'NOT_CONFIGURED';

export class CryptoError extends Error {
  constructor(
    readonly code: CryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CryptoError';
  }

  /** Serialises without the stack: code and generic message only. */
  toJSON(): { name: string; code: CryptoErrorCode; message: string } {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export class KeyConfigurationError extends CryptoError {
  constructor(message = 'Encryption keys are not configured correctly') {
    super('KEY_CONFIGURATION', message);
    this.name = 'KeyConfigurationError';
  }
}

export class KeyNotFoundError extends CryptoError {
  constructor(message = 'The referenced encryption key is not available') {
    super('KEY_NOT_FOUND', message);
    this.name = 'KeyNotFoundError';
  }
}

export class DecryptionError extends CryptoError {
  constructor() {
    super('DECRYPTION_FAILED', 'Unable to decrypt');
    this.name = 'DecryptionError';
  }
}

export class MalformedEnvelopeError extends CryptoError {
  constructor(message = 'Malformed encrypted envelope') {
    super('MALFORMED_ENVELOPE', message);
    this.name = 'MalformedEnvelopeError';
  }
}

export class UnsupportedEnvelopeError extends CryptoError {
  constructor(message = 'Unsupported encrypted envelope') {
    super('UNSUPPORTED_ENVELOPE', message);
    this.name = 'UnsupportedEnvelopeError';
  }
}

export class CryptoInputError extends CryptoError {
  constructor(message: string) {
    super('INVALID_INPUT', message);
    this.name = 'CryptoInputError';
  }
}

export class EncryptionNotConfiguredError extends CryptoError {
  constructor() {
    super('NOT_CONFIGURED', 'Encryption is not configured');
    this.name = 'EncryptionNotConfiguredError';
  }
}

export function isCryptoError(error: unknown): error is CryptoError {
  return error instanceof CryptoError;
}
