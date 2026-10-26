import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server-env', () => ({
  serverEnv: () => ({ NEXT_PUBLIC_API_URL: 'http://localhost:4000' }),
}));

const { toReference } = await import('./openapi');
const { examplesFor } = await import('./examples');

const document = {
  openapi: '3.0.3',
  info: { title: 'EnvVault API', version: '1' },
  'x-envvault-protocol-version': 1,
  'x-envvault-error-codes': { general: { NOT_FOUND: 'NOT_FOUND', BAD_REQUEST: 'BAD_REQUEST' } },
  tags: [{ name: 'Machine', description: 'Machines' }],
  paths: {
    '/machine/environments/{environmentId}/runtime': {
      post: {
        operationId: 'postMachineEnvironmentsRuntime',
        summary: 'Values for the calling process',
        tags: ['Machine'],
        'x-envvault-callers': ['machine'],
        'x-envvault-permission': 'secret:runtime',
        parameters: [
          { name: 'environmentId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { includeInherited: { type: 'boolean' } } },
            },
          },
        },
        responses: {
          '200': {
            description: 'Success',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '429': { description: 'Rate limited' },
        },
      },
    },
  },
};

describe('API reference', () => {
  it('reduces the OpenAPI document to operations', () => {
    const reference = toReference(document);
    expect(reference?.protocolVersion).toBe(1);
    expect(reference?.errorCodes.general).toEqual(['BAD_REQUEST', 'NOT_FOUND']);
    const [operation] = reference?.operations ?? [];
    expect(operation).toMatchObject({
      id: 'postMachineEnvironmentsRuntime',
      method: 'POST',
      callers: ['machine'],
      permission: 'secret:runtime',
      tag: 'Machine',
    });
    expect(operation?.body?.properties?.includeInherited).toEqual({ type: 'boolean' });
    expect(operation?.responses.map((r) => r.status)).toEqual(['200', '429']);
  });

  it('rejects documents that are not OpenAPI', () => {
    expect(toReference(null)).toBeNull();
    expect(toReference({ paths: [] })).toBeNull();
  });

  it('builds examples with placeholders only', () => {
    const examples = examplesFor({
      method: 'POST',
      path: '/machine/environments/{environmentId}/runtime',
      callers: ['machine'],
      hasBody: true,
    });
    expect(examples.map((e) => e.label)).toEqual(['curl', 'TypeScript', 'Python']);
    const curl = examples[0]?.code ?? '';
    expect(curl).toContain('$ENVVAULT_API_URL/api/v1/machine/environments/$ENVIRONMENT_ID/runtime');
    expect(curl).toContain('Bearer $ENVVAULT_ACCESS_TOKEN');
    for (const example of examples) {
      expect(example.code).not.toMatch(/evv_(sk|mt|at|rt)_[A-Za-z0-9]/);
    }
    const exchange = examplesFor({
      method: 'POST',
      path: '/machine/token',
      callers: ['service-credential'],
      hasBody: true,
    });
    expect(exchange[0]?.code).toContain('Bearer $ENVVAULT_SERVICE_CREDENTIAL');
    const health = examplesFor({
      method: 'GET',
      path: '/health',
      callers: ['anonymous'],
      hasBody: false,
    });
    expect(health[0]?.code).not.toContain('Authorization');
  });
});
