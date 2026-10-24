import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.decorators.js';
import { buildOpenApiDocument } from './openapi.js';
import { RouteAccessService } from './route-access.js';

/**
 * `GET /api/v1/openapi.json`. Public: it describes the API surface only, never
 * data. Built once per process.
 */
@Public()
@Controller({ path: 'openapi.json', version: '1' })
export class OpenApiController {
  private document: Record<string, unknown> | undefined;

  constructor(private readonly routes: RouteAccessService) {}

  @Get()
  get(): Record<string, unknown> {
    this.document ??= buildOpenApiDocument('1', this.routes.collect());
    return this.document;
  }
}
