/** DI token for the NeonTokenVerifier (overridable in tests). */
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** DI token for the CredentialVerifier used by step-up (overridable in tests). */
export const CREDENTIAL_VERIFIER = Symbol('CREDENTIAL_VERIFIER');
