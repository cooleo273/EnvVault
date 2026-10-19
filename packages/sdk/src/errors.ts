import type { ApiErrorResponse } from '@envvault/shared';

export class EnvVaultApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(statusCode: number, body: ApiErrorResponse['error'] | undefined) {
    super(body?.message ?? `EnvVault API request failed with status ${statusCode}`);
    this.name = 'EnvVaultApiError';
    this.statusCode = statusCode;
    this.code = body?.code ?? 'UNKNOWN_ERROR';
    this.requestId = body?.requestId;
  }
}

export class EnvVaultResponseValidationError extends Error {
  constructor(path: string) {
    super(`Unexpected response shape from ${path}`);
    this.name = 'EnvVaultResponseValidationError';
  }
}
