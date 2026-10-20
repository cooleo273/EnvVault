import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
