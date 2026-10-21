import {
  MalformedEnvelopeError,
  SECRET_ENVELOPE_ALGORITHM,
  type SecretEnvelope,
  UnsupportedEnvelopeError,
} from '@envvault/crypto';
import type { NewSecretVersion, StoredSecretVersion } from '@envvault/database';

/**
 * Column mapping of `secret_versions` (see docs/encryption.md, section 3).
 * The provider and key id live on the referenced `encryption_keys` row; the
 * key version is stored per version because rewrapping changes it.
 */
export function envelopeFromRow(row: StoredSecretVersion): SecretEnvelope {
  if (row.algorithm !== 'AES_256_GCM') throw new UnsupportedEnvelopeError();
  const keyVersion = Number(row.kmsKeyVersion);
  if (row.kmsKeyVersion === null || !/^[1-9]\d*$/.test(row.kmsKeyVersion)) {
    throw new MalformedEnvelopeError();
  }
  return {
    formatVersion: row.envelopeVersion,
    algorithm: SECRET_ENVELOPE_ALGORITHM,
    providerId: row.kmsProvider,
    keyId: row.kmsKeyRef,
    keyVersion,
    wrappedKey: row.encryptedDataKey,
    nonce: row.iv,
    ciphertext: row.ciphertext,
    tag: row.authTag,
  };
}

export function versionRowFromEnvelope(
  versionId: string,
  encryptionKeyId: string,
  envelope: SecretEnvelope,
): Omit<NewSecretVersion, 'origin' | 'changeReason' | 'restoredFromVersionId'> {
  return {
    id: versionId,
    encryptionKeyId,
    kmsKeyVersion: String(envelope.keyVersion),
    envelopeVersion: envelope.formatVersion,
    ciphertext: envelope.ciphertext,
    iv: envelope.nonce,
    authTag: envelope.tag,
    encryptedDataKey: envelope.wrappedKey,
  };
}
