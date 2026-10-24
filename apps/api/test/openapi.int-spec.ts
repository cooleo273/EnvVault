import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ERROR_CODES, isPermissionKey } from '@envvault/shared';
import { operationIdFor } from '../src/openapi/openapi.js';
import { RouteAccessService } from '../src/openapi/route-access.js';
import { ROUTES } from '../src/openapi/routes.js';
import { Harness } from './support/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await Harness.start();
});
afterAll(async () => {
  await h.stop();
});

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Every route registered in the running application, as `METHOD /path`. */
function registeredRoutes(): string[] {
  const express = h.app.getHttpAdapter().getInstance() as {
    router?: { stack: ExpressLayer[] };
    _router?: { stack: ExpressLayer[] };
  };
  const stack = (express.router ?? express._router)?.stack ?? [];
  return stack.flatMap((layer) =>
    // Skip framework catch-alls (e.g. `/api{/*splat}` registered for every verb).
    layer.route && !layer.route.path.includes('*')
      ? Object.keys(layer.route.methods).map(
          (method) =>
            `${method.toUpperCase()} ${layer.route?.path.replace(/^\/api\/v1/, '').replace(/:(\w+)/g, '{$1}') ?? ''}`,
        )
      : [],
  );
}

describe('OpenAPI document', () => {
  it('documents exactly the routes the API serves', () => {
    const documented = ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
    const registered = registeredRoutes().sort();
    expect(registered.length).toBeGreaterThan(50);
    expect(documented).toEqual(registered);
  });

  it('is served publicly as valid OpenAPI 3.0 with schemas from the validators', async () => {
    const response = await h.api().get('/api/v1/openapi.json').expect(200);
    const doc = response.body as {
      openapi: string;
      paths: Record<string, Record<string, { requestBody?: unknown; security?: unknown[] }>>;
    };
    expect(doc.openapi).toBe('3.0.3');
    const create = doc.paths['/workspaces/{workspaceId}/projects']?.post;
    expect(JSON.stringify(create?.requestBody)).toContain('"environments"');
    expect(doc.paths['/health']?.get?.security).toEqual([]);
  });

  it('describes each route with the access rules the guards enforce', () => {
    const access = h.app.get(RouteAccessService).collect();
    const mismatches: string[] = [];
    for (const route of ROUTES) {
      const key = `${route.method.toUpperCase()} ${route.path}`;
      const actual = access.get(key);
      if (!actual) {
        mismatches.push(`${key}: no metadata`);
        continue;
      }
      const isPublic = actual.callers.includes('anonymous');
      if ((route.public === true) !== isPublic) mismatches.push(`${key}: public`);
      if ((route.machine === 'token') !== actual.callers.includes('machine')) {
        mismatches.push(`${key}: machine route`);
      }
      // The guard enforces an entry permission; services may require more. Both must be documented.
      if (actual.permission && !route.permission)
        mismatches.push(`${key}: permission undocumented`);
      for (const [named] of (route.permission ?? '').matchAll(/\b[a-z_]+:[a-z_]+\b/g)) {
        if (!isPermissionKey(named)) mismatches.push(`${key}: unknown permission ${named}`);
      }
      if ((route.stepUp === true) !== actual.stepUp) mismatches.push(`${key}: step up`);
    }
    expect(mismatches).toEqual([]);
  });

  it('is structurally sound: unique operation ids, resolvable refs, declared parameters', async () => {
    const response = await h.api().get('/api/v1/openapi.json').expect(200);
    const doc = response.body as {
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
      paths: Record<
        string,
        Record<
          string,
          {
            operationId: string;
            security: Record<string, unknown>[];
            parameters: { name: string; in: string }[];
            responses: Record<string, unknown>;
            'x-envvault-callers': string[];
          }
        >
      >;
      'x-envvault-error-codes': Record<string, Record<string, string>>;
    };
    const ids = new Set<string>();
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        expect(ids.has(operation.operationId), `${method} ${path}`).toBe(false);
        // Deprecation links find the reference anchor through operationIdFor.
        expect(operation.operationId, `${method} ${path}`).toBe(operationIdFor(method, path));
        ids.add(operation.operationId);
        for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
          expect(
            operation.parameters.some((p) => p.in === 'path' && p.name === name),
            `${method} ${path} ${String(name)}`,
          ).toBe(true);
        }
        expect(operation.responses['429']).toBeDefined();
        for (const requirement of operation.security) {
          for (const scheme of Object.keys(requirement)) {
            expect(doc.components.securitySchemes[scheme], scheme).toBeDefined();
          }
        }
      }
    }
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)];
    for (const [, name] of refs) expect(doc.components.schemas[name ?? '']).toBeDefined();
    // CLI tokens are documented exactly where the guard accepts them.
    expect(doc.paths['/users/me']?.get?.['x-envvault-callers']).toEqual(['person', 'cli']);
    expect(doc.paths['/workspaces']?.post?.['x-envvault-callers']).toEqual(['person']);
    expect(doc.paths['/machine/identity']?.get?.security).toEqual([{ machineToken: [] }]);
    expect(doc.paths['/machine/token']?.post?.security).toEqual([{ serviceCredential: [] }]);
    const published = Object.values(doc['x-envvault-error-codes']).flatMap((g) => Object.values(g));
    expect(new Set(published)).toEqual(new Set(API_ERROR_CODES));
  });

  it('has every error code in the API reference document', () => {
    const reference = readFileSync(
      new URL('../../../docs/api-reference.md', import.meta.url),
      'utf8',
    );
    expect(API_ERROR_CODES.filter((code) => !reference.includes(`\`${code}\``))).toEqual([]);
  });
});
