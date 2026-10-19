import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiErrorResponse, ValidationIssue } from '@envvault/shared';
import type { Request, Response } from 'express';
import { ApiException } from '../api-exception.js';

const STATUS_CODES: Partial<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

/** Exception body thrown by {@link ZodValidationPipe}. */
export interface ValidationExceptionBody {
  message: string;
  issues: ValidationIssue[];
}

/** Errors raised by Express middleware (e.g. body-parser) carry an HTTP status but are not HttpExceptions. */
interface HttpLikeError {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
}

function isValidationBody(value: unknown): value is ValidationExceptionBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as ValidationExceptionBody).issues)
  );
}

function httpLikeStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, statusCode, expose } = exception as HttpLikeError;
  const code = typeof status === 'number' ? status : statusCode;
  return typeof code === 'number' && code >= 400 && code < 500 && expose === true
    ? code
    : undefined;
}

/**
 * Converts every thrown error into the uniform {@link ApiErrorResponse} envelope.
 * Server errors are logged with their stack (never the request body) and are
 * returned to clients with a generic message only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();

    let statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let issues: ValidationIssue[] | undefined;
    let code: string | undefined;

    if (exception instanceof ApiException) {
      code = exception.code;
      for (const [name, value] of Object.entries(exception.headers)) {
        response.setHeader(name, value);
      }
    }

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      // ApiException messages are client-safe by contract, including 5xx.
      if (statusCode < 500 || exception instanceof ApiException) {
        message = exception.message;
        if (isValidationBody(body)) {
          message = body.message;
          issues = body.issues;
        }
      }
    } else {
      const status = httpLikeStatus(exception);
      if (status !== undefined) {
        statusCode = status;
        message = status === 413 ? 'Request body too large' : 'Malformed request';
      }
    }

    const requestId = typeof request.id === 'string' ? request.id : undefined;

    if (statusCode >= 500 && !(exception instanceof ApiException)) {
      this.logger.error(
        { err: exception, requestId, method: request.method, path: request.path },
        'Unhandled exception',
      );
      message = 'Internal server error';
    } else if (statusCode >= 500) {
      this.logger.warn(
        { requestId, code, path: request.path },
        'Request failed: dependency unavailable',
      );
    }

    const payload: ApiErrorResponse = {
      error: {
        statusCode,
        code:
          code ??
          STATUS_CODES[statusCode] ??
          (statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'ERROR'),
        message,
        ...(requestId === undefined ? {} : { requestId }),
        ...(issues === undefined ? {} : { issues }),
      },
    };

    response.status(statusCode).json(payload);
  }
}
