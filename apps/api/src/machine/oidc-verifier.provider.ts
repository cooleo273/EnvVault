import type { Provider } from '@nestjs/common';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { OidcVerifier } from './oidc-verifier.js';

export { OidcVerificationError, OidcVerifier, type VerifiedOidcToken } from './oidc-verifier.js';

export const OIDC_VERIFIER = Symbol('OIDC_VERIFIER');

/** One verifier per process, so discovery documents and key sets are cached across requests. */
export const oidcVerifierProvider: Provider = {
  provide: OIDC_VERIFIER,
  inject: [APP_ENV],
  useFactory: (env: Env) =>
    new OidcVerifier({
      issuers: env.OIDC_TRUSTED_ISSUERS,
      jwksCooldownMs: env.OIDC_JWKS_COOLDOWN_SECONDS * 1000,
    }),
};
