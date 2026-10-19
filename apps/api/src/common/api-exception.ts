import { HttpException } from '@nestjs/common';

/**
 * HTTP exception carrying a stable machine-readable `code` (rendered as
 * `error.code` by AllExceptionsFilter) and optional response headers such as
 * `WWW-Authenticate`. Messages must be safe to show to clients.
 */
export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super({ code, message }, status);
  }
}
