import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { operationIdFor } from '../openapi/openapi.js';

export const DEPRECATION_KEY = 'envvault:api:deprecated';

export interface DeprecationNotice {
  /** When the route was deprecated (ISO date). */
  since: string;
  /** When it stops working (ISO date); at least 6 months after `since` (docs/api-versioning.md). */
  sunset?: string;
  /** Path of the route that replaces it, for documentation. */
  replacement?: string;
}

/**
 * Marks a route as deprecated. Responses then carry `Deprecation` (RFC 9745),
 * `Sunset` (RFC 8594) and `Link`s to the route's entry in the web app's API
 * reference and to the OpenAPI document, both of which show the dates and the
 * replacement.
 */
export const Deprecated = (notice: DeprecationNotice) => SetMetadata(DEPRECATION_KEY, notice);

export function deprecationHeaders(
  notice: DeprecationNotice,
  documentation: string,
): Record<string, string> {
  const since = Math.floor(Date.parse(notice.since) / 1000);
  return {
    Deprecation: `@${String(since)}`,
    ...(notice.sunset ? { Sunset: new Date(notice.sunset).toUTCString() } : {}),
    Link: `<${documentation}>; rel="deprecation"; type="text/html", </api/v1/openapi.json>; rel="service-desc"; type="application/json"`,
  };
}

/**
 * The reference page entry for a route, from its Express path
 * (`/api/v1/machine/environments/:environmentId/runtime`). The anchor is the
 * OpenAPI operation id, which the page uses for deep links; an undocumented
 * route gets the page itself.
 */
export function referenceUrl(origin: string, method: string, routePath: string): string {
  const path = routePath.replace(/^\/api\/v\d+/, '').replace(/:(\w+)/g, '{$1}');
  const id = operationIdFor(method, path);
  return `${origin}/developers/api${id ? `#${id}` : ''}`;
}

@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  private readonly webOrigin: string;

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_ENV) env: Env,
  ) {
    // Same rule as the CLI sign in links: the web app's public origin.
    this.webOrigin = env.APP_BASE_URL ?? env.CORS_ORIGINS[0] ?? 'http://localhost:3000';
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const notice = this.reflector.getAllAndOverride<DeprecationNotice | undefined>(
      DEPRECATION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (notice && context.getType() === 'http') {
      const http = context.switchToHttp();
      const request = http.getRequest<Request>();
      const response = http.getResponse<Response>();
      const routePath = (request.route as { path?: unknown } | undefined)?.path;
      const documentation = referenceUrl(
        this.webOrigin,
        request.method,
        typeof routePath === 'string' ? routePath : request.path,
      );
      for (const [name, value] of Object.entries(deprecationHeaders(notice, documentation))) {
        response.setHeader(name, value);
      }
    }
    return next.handle();
  }
}
