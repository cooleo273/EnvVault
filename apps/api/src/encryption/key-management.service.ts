import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  EncryptionNotConfiguredError,
  type KeyManagementProvider,
  type KeyMetadata,
  type KeyReference,
  LocalKeyProvider,
} from '@envvault/crypto';
import type { EncryptionRuntime } from './encryption.config.js';

export const ENCRYPTION_RUNTIME = Symbol('ENCRYPTION_RUNTIME');

export type EncryptionStatus =
  | { readonly status: 'disabled' }
  | {
      readonly status: 'ready';
      readonly providerId: string;
      readonly active: KeyReference;
      readonly keys: readonly KeyMetadata[];
    };

/**
 * Server-side access to the key provider for trusted backend services. Exposes
 * metadata only; master keys never leave the provider. Rotation is an
 * operator task (`pnpm crypto:rotate:dev`) and is intentionally not offered here.
 */
@Injectable()
export class KeyManagementService implements OnApplicationShutdown {
  constructor(@Inject(ENCRYPTION_RUNTIME) private readonly runtime: EncryptionRuntime) {}

  get isConfigured(): boolean {
    return this.runtime.status === 'ready';
  }

  /** The provider, or EncryptionNotConfiguredError (fail closed). */
  provider(): KeyManagementProvider {
    if (this.runtime.status !== 'ready') throw new EncryptionNotConfiguredError();
    return this.runtime.provider;
  }

  async status(): Promise<EncryptionStatus> {
    if (this.runtime.status !== 'ready') return { status: 'disabled' };
    const { provider } = this.runtime;
    const [active, keys] = await Promise.all([
      provider.getActiveKeyVersion(),
      provider.listKeyMetadata(),
    ]);
    return { status: 'ready', providerId: provider.providerId, active, keys };
  }

  onApplicationShutdown(): void {
    if (this.runtime.status === 'ready' && this.runtime.provider instanceof LocalKeyProvider) {
      this.runtime.provider.destroy();
    }
  }
}
