import { Injectable, Logger } from '@nestjs/common';
import {
  type CredentialEncryptionContext,
  isCryptoError,
  type RewrapResult,
  SecretCipher,
  type SecretEncryptionContext,
  type SecretEnvelope,
} from '@envvault/crypto';
import { KeyManagementService } from './key-management.service.js';

/**
 * Encrypts and decrypts secret values for trusted backend services (Phase 3B
 * secret routes add authentication and authorization in front of it). Never
 * exposed over HTTP and never logs values; failures are logged by error
 * category and record ids only.
 */
@Injectable()
export class SecretEncryptionService {
  private readonly logger = new Logger(SecretEncryptionService.name);
  private cipher: SecretCipher | undefined;

  constructor(private readonly keys: KeyManagementService) {}

  private secretCipher(): SecretCipher {
    this.cipher ??= new SecretCipher(this.keys.provider());
    return this.cipher;
  }

  encryptSecret(plaintext: string, context: SecretEncryptionContext): Promise<SecretEnvelope> {
    return this.secretCipher().encryptSecret(plaintext, context);
  }

  async decryptSecret(envelope: SecretEnvelope, context: SecretEncryptionContext): Promise<string> {
    try {
      return await this.secretCipher().decryptSecret(envelope, context);
    } catch (error) {
      this.logFailure('decrypt', error, context);
      throw error;
    }
  }

  /** A provider credential (for example a Vercel token), under the same keyring and envelope scheme. */
  encryptCredential(
    plaintext: string,
    context: CredentialEncryptionContext,
  ): Promise<SecretEnvelope> {
    return this.secretCipher().encryptCredential(plaintext, context);
  }

  async decryptCredential(
    envelope: SecretEnvelope,
    context: CredentialEncryptionContext,
  ): Promise<string> {
    try {
      return await this.secretCipher().decryptCredential(envelope, context);
    } catch (error) {
      this.logger.warn(
        `Credential decrypt failed (${isCryptoError(error) ? error.code : 'UNKNOWN'}) for integration ${context.connectionId}`,
      );
      throw error;
    }
  }

  async rewrapSecret(
    envelope: SecretEnvelope,
    context: SecretEncryptionContext,
  ): Promise<RewrapResult> {
    try {
      return await this.secretCipher().rewrapSecret(envelope, context);
    } catch (error) {
      this.logFailure('rewrap', error, context);
      throw error;
    }
  }

  private logFailure(operation: string, error: unknown, context: SecretEncryptionContext): void {
    // Ids are not secret; they let operators find a tampered or orphaned record.
    this.logger.warn(
      `Secret ${operation} failed (${isCryptoError(error) ? error.code : 'UNKNOWN'}) for secret version ${context.secretVersionId}`,
    );
  }
}
