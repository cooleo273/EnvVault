import {
  API_BASE_PATH,
  API_ERROR_CATALOG,
  API_PROTOCOL_VERSION,
  apiErrorResponseSchema,
} from '@envvault/shared';
import { z } from 'zod';
import type { RouteAccess } from './route-access.js';
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

const TAG_DESCRIPTIONS: Record<string, string> = {
  Health: 'Liveness, readiness, protocol version and this document. No authentication.',
  Auth: 'Session revocation, logout and password step up for people.',
  Users: 'The signed in person.',
  Workspaces: 'Workspaces the caller belongs to.',
  Members: 'Workspace members and roles.',
  Invitations: 'Workspace invitations.',
  Projects: 'Projects inside a workspace.',
  'Project members': 'Who has access to a project.',
  Environments: 'Environments of a project.',
  'Environment access': 'Per environment grants for people.',
  Templates: 'Environment templates.',
  Secrets:
    'Variables, versions and runtime loading. Values are returned only by reveal, export and runtime routes.',
  'Secret transfers': 'Import and export of .env, JSON and YAML.',
  'Environment intelligence': 'Comparison, inheritance, validation, readiness and snapshots.',
  Retention: 'Retention policy and purge runs.',
  CLI: 'Browser approved CLI sign in and CLI sessions.',
  'Machine identities': 'Machine identities, service credentials and grants, managed by people.',
  Machine: 'Routes for machine identities: token exchange, environments and runtime values.',
  'GitHub Actions':
    'Trust bindings that let GitHub Actions workflows authenticate as a machine identity with OIDC.',
};

const SECURITY_SCHEMES = {
  personBearer: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Short lived Neon Auth access token minted by the web app for the signed in person. Never exposed to browsers.',
  },
  cliToken: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'evv_at_',
    description:
      'CLI access token from the browser approved device flow (1 hour, refreshable). Accepted only where `x-envvault-callers` includes `cli`.',
  },
  machineToken: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'evv_mt_',
    description:
      'Machine access token from `POST /machine/token` (at most 15 minutes). Accepted only by `/machine` routes.',
  },
  serviceCredential: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'evv_sk_',
    description:
      'Long lived service credential of a machine identity. Accepted only by `POST /machine/token`.',
  },
  githubOidc: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'GitHub Actions OIDC identity token requested by the job (`id-token: write`) for the audience configured on a trust binding. Accepted only by `POST /machine/oidc/token`.',
  },
};

const RESPONSE_HEADERS = {
  'X-Request-Id': {
    description:
      'Request id, also in `error.requestId`. Send your own (up to 128 safe characters) to correlate.',
    schema: { type: 'string' },
  },
};

const RATE_LIMITED = {
  description: 'Rate limited (`TOO_MANY_REQUESTS`); retry after `Retry-After` seconds',
  headers: {
    ...RESPONSE_HEADERS,
    'Retry-After': { description: 'Seconds to wait before retrying', schema: { type: 'integer' } },
  },
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
};

const ERROR_REF = {
  description: 'Error (see `error.code`)',
  headers: RESPONSE_HEADERS,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
};

/** `GET /workspaces/{workspaceId}/projects` → `getWorkspacesProjects`; stable while paths are. */
export function operationIdOf(method: string, path: string): string {
  const words = path
    .split('/')
    .filter((part) => part !== '' && !part.startsWith('{'))
    .flatMap((part) => part.split(/[-_.]/));
  return [method, ...words]
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join('');
}

let operationIds: Map<string, string> | undefined;

/**
 * The published operation id of every documented route, keyed `METHOD /path`
 * (`GET /workspaces/{workspaceId}`). Routes whose ids would collide get a `_`
 * suffix in ROUTES order, so deprecation links and the document always agree.
 */
export function operationIdFor(method: string, path: string): string | undefined {
  if (!operationIds) {
    operationIds = new Map();
    const used = new Set<string>();
    for (const route of ROUTES) {
      let id = operationIdOf(route.method, route.path);
      while (used.has(id)) id = `${id}_`;
      used.add(id);
      operationIds.set(`${route.method.toUpperCase()} ${route.path}`, id);
    }
  }
  return operationIds.get(`${method.toUpperCase()} ${path}`);
}

function securityFor(route: RouteDoc, access: RouteAccess | undefined): JsonSchema[] {
  if (route.machine === 'credential') return [{ serviceCredential: [] }];
  if (route.machine === 'oidc') return [{ githubOidc: [] }];
  const callers = access?.callers ?? (route.public ? ['anonymous'] : ['person']);
  if (callers.includes('anonymous')) return [];
  return callers.flatMap((caller): JsonSchema[] =>
    caller === 'person'
      ? [{ personBearer: [] }]
      : caller === 'cli'
        ? [{ cliToken: [] }]
        : caller === 'machine'
          ? [{ machineToken: [] }]
          : [],
  );
}

/**
 * OpenAPI 3.0 description of the REST API. Schemas come from the same Zod
 * validators the API uses; who may call each route (`security`,
 * `x-envvault-callers`), its permission, step up and deprecation come from
 * the decorators the guards enforce (`access`), so neither can drift.
 */
export function buildOpenApiDocument(
  version: string,
  access: ReadonlyMap<string, RouteAccess> = new Map(),
): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const route of ROUTES) {
    const key = `${route.method.toUpperCase()} ${route.path}`;
    const meta = access.get(key);
    // Effective requirement (checked in the services) as documented, and the guard's gate.
    const permission = route.permission ?? meta?.permission ?? null;
    const gate = meta?.permission ?? null;
    const stepUp = meta ? meta.stepUp : route.stepUp === true;
    const callers =
      route.machine === 'credential'
        ? ['service-credential']
        : route.machine === 'oidc'
          ? ['github-oidc']
          : (meta?.callers ?? (route.public ? ['anonymous'] : ['person']));
    const notes = [
      permission ? `Requires \`${permission}\`.` : null,
      stepUp ? 'Requires a recent password step-up (`POST /auth/step-up`).' : null,
      route.machine === 'credential'
        ? 'Authenticate with a service credential: `Authorization: Bearer evv_sk_…`.'
        : null,
      route.machine === 'oidc'
        ? 'Authenticate with a GitHub Actions OIDC token: `Authorization: Bearer <JWT>`. See docs/integrations/github-oidc.md.'
        : null,
      route.machine === 'token'
        ? 'Machine identities only: `Authorization: Bearer evv_mt_…` from `POST /machine/token`.'
        : null,
      meta?.deprecated
        ? `Deprecated since ${meta.deprecated.since}${meta.deprecated.sunset ? `; stops working on ${meta.deprecated.sunset}` : ''}${meta.deprecated.replacement ? `; use \`${meta.deprecated.replacement}\`` : ''}.`
        : null,
    ].filter(Boolean);
    const operationId =
      operationIdFor(route.method, route.path) ?? operationIdOf(route.method, route.path);
    const anonymous = callers.includes('anonymous');
    const operation: JsonSchema = {
      operationId,
      summary: route.summary,
      ...(notes.length ? { description: notes.join(' ') } : {}),
      tags: [route.tag],
      security: securityFor(route, meta),
      'x-envvault-callers': callers,
      ...(permission ? { 'x-envvault-permission': permission } : {}),
      ...(gate ? { 'x-envvault-gate-permission': gate } : {}),
      ...(stepUp ? { 'x-envvault-step-up': true } : {}),
      ...(meta?.deprecated ? { deprecated: true } : {}),
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
              headers: RESPONSE_HEADERS,
              content: { 'application/json': { schema: schema(route.response, 'output') } },
            }
          : {
              description: route.status === 204 ? 'No content' : 'Success',
              headers: RESPONSE_HEADERS,
            },
        '400': ERROR_REF,
        ...(anonymous && route.machine !== 'credential' && route.machine !== 'oidc'
          ? {}
          : { '401': ERROR_REF, '403': ERROR_REF, '404': ERROR_REF }),
        '429': RATE_LIMITED,
      },
    };
    (paths[route.path] ??= {})[route.method] = operation;
  }
  const tags = [...new Set(ROUTES.map((r) => r.tag))].map((name) => ({
    name,
    ...(TAG_DESCRIPTIONS[name] ? { description: TAG_DESCRIPTIONS[name] } : {}),
  }));
  return {
    openapi: '3.0.3',
    info: {
      title: 'EnvVault API',
      version,
      description:
        'Versioned REST API (`/api/v1`). People call it through the web app with short lived Neon Auth tokens; the CLI uses CLI access tokens on an allow list of routes; machine identities exchange a service credential at `POST /machine/token` and call the `/machine` routes. Authorization denies by default; resources outside the caller’s access return 404. Errors share one envelope; branch on `error.code` (catalog in `x-envvault-error-codes`). Conventions: docs/api-reference.md.',
    },
    servers: [{ url: API_BASE_PATH }],
    tags,
    components: {
      securitySchemes: SECURITY_SCHEMES,
      schemas: { ApiError: schema(apiErrorResponseSchema, 'output') },
    },
    security: [{ personBearer: [] }],
    'x-envvault-protocol-version': API_PROTOCOL_VERSION,
    'x-envvault-error-codes': API_ERROR_CATALOG,
    paths,
  };
}
