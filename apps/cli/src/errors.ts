import {
  EnvVaultApiError,
  EnvVaultIncompatibleApiError,
  EnvVaultNetworkError,
  EnvVaultResponseValidationError,
} from '@envvault/sdk';

/** Process exit codes. `envvault run` exits with the child's code instead. */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  config: 3,
  auth: 4,
  forbidden: 5,
  notFound: 6,
  unavailable: 7,
  missingSecrets: 8,
  rateLimited: 9,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.failure,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const SIGNED_OUT = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'TOKEN_INVALID']);

const ROTATE = 'Issue a new credential in the project settings and update the CI secret.';
const MACHINE_AUTH: Record<string, { message: string; hint: string } | undefined> = {
  INVALID_CREDENTIAL: {
    message: 'The service credential is not valid.',
    hint: 'Check that the CI secret holds the whole evv_sk_ value.',
  },
  SERVICE_CREDENTIAL_NOT_ACCEPTED: {
    message: 'The service credential was sent where an access token belongs.',
    hint: 'Use ENVVAULT_SERVICE_CREDENTIAL with this CLI; it exchanges the credential for you.',
  },
  CREDENTIAL_EXPIRED: { message: 'The service credential expired.', hint: ROTATE },
  CREDENTIAL_REVOKED: { message: 'The service credential was revoked.', hint: ROTATE },
  IDENTITY_DISABLED: {
    message: 'The machine identity is disabled.',
    hint: 'Ask a project admin to enable it in the project settings.',
  },
  IDENTITY_EXPIRED: {
    message: 'The machine identity expired.',
    hint: 'Ask a project admin to extend it in the project settings.',
  },
};

/**
 * Turns any failure into a message safe to print. API messages are client
 * safe by contract; everything else is reduced to a category, so no stack,
 * URL, header or response body reaches the terminal.
 */
export function toCliError(
  error: unknown,
  links: { confirmUrl?: string; machine?: boolean } = {},
): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof EnvVaultApiError) {
    const machine = MACHINE_AUTH[error.code];
    if (machine) return new CliError(machine.message, EXIT.auth, machine.hint);
    if (links.machine && SIGNED_OUT.has(error.code)) {
      return new CliError(
        'The machine access token was refused.',
        EXIT.auth,
        'Run the command again; if it keeps failing, check the identity in the project settings.',
      );
    }
    if (error.code === 'SCOPE_NOT_GRANTED') {
      return new CliError(error.message, EXIT.forbidden, 'Check the credential scopes and grants.');
    }
    if (error.code === 'MACHINE_TOKEN_NOT_ALLOWED' || error.code === 'MACHINE_TOKEN_REQUIRED') {
      return new CliError(error.message, EXIT.forbidden);
    }
    if (SIGNED_OUT.has(error.code)) {
      return new CliError(
        error.code === 'TOKEN_REVOKED' ? 'Your CLI session was ended.' : 'You are not signed in.',
        EXIT.auth,
        'Run envvault login.',
      );
    }
    if (error.code === 'STEP_UP_REQUIRED') {
      return new CliError(
        'This environment is protected: confirm your password first.',
        EXIT.forbidden,
        links.confirmUrl
          ? `Open ${links.confirmUrl}, confirm your password, then run the command again within a few minutes (10 by default).`
          : 'Confirm your password in the EnvVault web app, then run the command again within a few minutes (10 by default).',
      );
    }
    if (error.code === 'CLI_TOKEN_NOT_ALLOWED') {
      return new CliError(
        error.message,
        EXIT.forbidden,
        'Use the EnvVault web app for this action.',
      );
    }
    if (error.statusCode === 403) return new CliError(error.message, EXIT.forbidden);
    if (error.statusCode === 404) {
      return new CliError(
        'Not found, or you no longer have access.',
        EXIT.notFound,
        'Check the link with envvault doctor, or run envvault init to link again.',
      );
    }
    if (error.statusCode === 409 && error.code.includes('ARCHIVED')) {
      return new CliError(
        error.message,
        EXIT.notFound,
        'Pick another environment with envvault env use.',
      );
    }
    if (error.statusCode === 429) return new CliError(error.message, EXIT.rateLimited);
    if (error.statusCode >= 500) {
      return new CliError(
        `The EnvVault API failed (${error.code}).`,
        EXIT.unavailable,
        error.requestId ? `Request id ${error.requestId}` : undefined,
      );
    }
    return new CliError(error.message, EXIT.failure);
  }
  if (error instanceof EnvVaultNetworkError) {
    return new CliError(
      error.message,
      EXIT.unavailable,
      'Check the API address and your connection.',
    );
  }
  if (error instanceof EnvVaultIncompatibleApiError) {
    return new CliError(
      error.message,
      EXIT.unavailable,
      'Update the CLI or point it at a compatible API.',
    );
  }
  if (error instanceof EnvVaultResponseValidationError) {
    return new CliError('The API answered in an unexpected format.', EXIT.unavailable);
  }
  return new CliError('Unexpected error.', EXIT.failure);
}
