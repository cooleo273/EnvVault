import type { ApiErrorResponse, ValidationIssue } from '@envvault/shared';

export class EnvVaultApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly requestId: string | undefined;
  /** Field level validation problems (paths and messages, never submitted values). */
  readonly issues: ValidationIssue[] | undefined;

  /** Seconds to wait before retrying, from `Retry-After` (rate limits, 503). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    statusCode: number,
    body: ApiErrorResponse['error'] | undefined,
    meta: { retryAfterSeconds?: number | undefined; requestId?: string | undefined } = {},
  ) {
    super(body?.message ?? `EnvVault API request failed with status ${statusCode}`);
    this.name = 'EnvVaultApiError';
    this.statusCode = statusCode;
    this.code = body?.code ?? 'UNKNOWN_ERROR';
    this.requestId = body?.requestId ?? meta.requestId;
    this.issues = body?.issues;
    this.retryAfterSeconds = meta.retryAfterSeconds;
  }

  /** Rate limited: wait `retryAfterSeconds` before trying again. */
  get isRateLimited(): boolean {
    return this.statusCode === 429;
  }
}

export class EnvVaultResponseValidationError extends Error {
  constructor(path: string) {
    super(`Unexpected response shape from ${path}`);
    this.name = 'EnvVaultResponseValidationError';
  }
}

/** The API could not be reached or did not answer in time. Carries no URL or response content. */
export class EnvVaultNetworkError extends Error {
  constructor(readonly reason: 'timeout' | 'unreachable') {
    super(
      reason === 'timeout'
        ? 'The EnvVault API did not answer in time'
        : 'The EnvVault API could not be reached',
    );
    this.name = 'EnvVaultNetworkError';
  }
}

/** The caller cancelled the request through its AbortSignal. */
export class EnvVaultAbortError extends Error {
  constructor() {
    super('The EnvVault API request was cancelled');
    this.name = 'EnvVaultAbortError';
  }
}

/** The server speaks a protocol version this client does not know. */
export class EnvVaultIncompatibleApiError extends Error {
  constructor(
    readonly serverVersion: number,
    readonly clientVersion: number,
  ) {
    super(
      `The EnvVault API speaks protocol ${String(serverVersion)}; this client supports ${String(clientVersion)}`,
    );
    this.name = 'EnvVaultIncompatibleApiError';
  }
}
