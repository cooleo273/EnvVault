import { API_BASE_PATH, apiErrorResponseSchema } from '@envvault/shared';
import { z } from 'zod';
import { ROUTES, type RouteDoc } from './routes.js';

type JsonSchema = Record<string, unknown>;

function schema(type: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(type, {
    io,
    unrepresentable: 'any',
    target: 'openapi-3.0',
  }) as JsonSchema;
  return rest;
}

function queryParameters(route: RouteDoc): JsonSchema[] {
  if (!route.query) return [];
  const json = schema(route.query, 'input') as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    name,
    in: 'query',
    required: json.required?.includes(name) ?? false,
    schema: property,
  }));
}

function pathParameters(path: string): JsonSchema[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  }));
}

const ERROR_RESPONSE = {
  description: 'Error (see `error.code`)',
  content: { 'application/json': { schema: schema(apiErrorResponseSchema, 'output') } },
};

/**
 * OpenAPI 3.0 description of the REST API, generated from the same Zod
 * schemas the API validates requests with (so the contract cannot drift).
 */
export function buildOpenApiDocument(version: string): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const route of ROUTES) {
    const notes = [
      route.permission ? `Requires \`${route.permission}\`.` : null,
      route.stepUp ? 'Requires a recent password step-up (`POST /auth/step-up`).' : null,
    ].filter(Boolean);
    const operation: JsonSchema = {
      summary: route.summary,
      ...(notes.length ? { description: notes.join(' ') } : {}),
      tags: [route.tag],
      ...(route.public ? { security: [] } : {}),
      parameters: [...pathParameters(route.path), ...queryParameters(route)],
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schema(route.body, 'input') } },
            },
          }
        : {}),
      responses: {
        [String(route.status)]: route.response
          ? {
              description: 'Success',
              content: { 'application/json': { schema: schema(route.response, 'output') } },
            }
          : { description: route.status === 204 ? 'No content' : 'Success' },
        ...(route.public
          ? {}
          : { '401': ERROR_RESPONSE, '403': ERROR_RESPONSE, '404': ERROR_RESPONSE }),
        '400': ERROR_RESPONSE,
      },
    };
    (paths[route.path] ??= {})[route.method] = operation;
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'EnvVault API',
      version,
      description:
        'Versioned REST API. Authenticate with a Neon Auth access token: `Authorization: Bearer <JWT>`. Authorization is default-deny; resources outside the caller’s access return 404.',
    },
    servers: [{ url: API_BASE_PATH }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
    security: [{ bearer: [] }],
    paths,
  };
}
