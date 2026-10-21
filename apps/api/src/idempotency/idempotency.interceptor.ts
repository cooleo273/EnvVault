import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { createRepositories, type Prisma } from '@envvault/database';
import type { Response } from 'express';
import { from, mergeMap, type Observable, of, throwError, catchError } from 'rxjs';
import { canonicalJson } from '../audit/audit-seal.js';
import type { AuthenticatedRequest } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import { INTEGRITY_RUNTIME, type IntegrityRuntime } from '../integrity/integrity.config.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const TTL_MS = 24 * 60 * 60_000;

/**
 * Replays the stored response when a mutation is retried with the same
 * `Idempotency-Key`, instead of running it twice (two versions, two imports).
 *
 * - The request is fingerprinted with a keyed HMAC (bodies can carry secret
 *   values, so a plain hash would be a guessable fingerprint of them).
 * - A key reused for a different request is refused (422); a key whose first
 *   request is still running is refused (409).
 * - Only successful responses are stored; a failed request frees the key.
 * - Use only on routes whose responses hold no values: stored responses sit
 *   in the database for 24 hours.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly database: DatabaseService,
    @Inject(INTEGRITY_RUNTIME) private readonly integrity: IntegrityRuntime,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const header = request.headers[IDEMPOTENCY_HEADER];
    const principal = request.principal;
    if (header === undefined || !principal) return next.handle();
    if (typeof header !== 'string' || !KEY_PATTERN.test(header)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must be 16 to 128 letters, digits, dashes or underscores',
      );
    }
    const route = request.path;
    const method = request.method.toUpperCase();
    const material = Buffer.from(
      canonicalJson({
        method,
        route,
        query: request.query,
        body: (request.body as unknown) ?? null,
      }),
      'utf8',
    );
    const keys = this.integrity.keys;
    const repos = createRepositories(this.database.client);
    const begun = await repos.idempotency.begin({
      userId: principal.userId,
      key: header,
      method,
      route,
      fingerprint: keys.mac('idempotency', material),
      keyId: keys.activeKeyId,
      expiresAt: new Date(Date.now() + TTL_MS),
    });
    if (!begun.started) {
      const existing = begun.existing;
      const same =
        existing.method === method &&
        existing.route === route &&
        keys.verify('idempotency', material, existing.fingerprint, existing.keyId);
      if (!same) {
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request',
        );
      }
      if (existing.status !== 'completed' || existing.responseStatus === null) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'IDEMPOTENCY_IN_PROGRESS',
          'The first request with this Idempotency-Key is still running',
          { 'Retry-After': '2' },
        );
      }
      response.status(existing.responseStatus);
      response.setHeader('Idempotent-Replayed', 'true');
      return of(existing.responseBody ?? undefined);
    }
    const status =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);
    return next.handle().pipe(
      mergeMap((body: unknown) =>
        from(
          repos.idempotency.complete(
            begun.id,
            status,
            body === undefined ? null : (JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue),
          ),
        ).pipe(mergeMap(() => of(body))),
      ),
      catchError((error: unknown) =>
        from(repos.idempotency.discard(begun.id).catch(() => undefined)).pipe(
          mergeMap(() => throwError(() => error)),
        ),
      ),
    );
  }
}

/** Accepts an `Idempotency-Key` header on this mutation. */
export const Idempotent = () => UseInterceptors(IdempotencyInterceptor);
