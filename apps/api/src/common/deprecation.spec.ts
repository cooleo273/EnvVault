import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import {
  Deprecated,
  DeprecationInterceptor,
  deprecationHeaders,
  referenceUrl,
} from './deprecation.js';

describe('deprecation', () => {
  it('builds RFC 9745 and RFC 8594 headers', () => {
    expect(
      deprecationHeaders(
        { since: '2027-01-01T00:00:00Z', sunset: '2027-07-01T00:00:00Z' },
        'https://app.example.test/developers/api#getMachineIdentity',
      ),
    ).toEqual({
      Deprecation: '@1798761600',
      Sunset: 'Thu, 01 Jul 2027 00:00:00 GMT',
      Link: '<https://app.example.test/developers/api#getMachineIdentity>; rel="deprecation"; type="text/html", </api/v1/openapi.json>; rel="service-desc"; type="application/json"',
    });
  });

  it('links to the route in the web reference by its operation id', () => {
    expect(
      referenceUrl(
        'https://app.example.test',
        'POST',
        '/api/v1/machine/environments/:environmentId/runtime',
      ),
    ).toBe('https://app.example.test/developers/api#postMachineEnvironmentsRuntime');
    // Colliding ids keep the suffix the OpenAPI document gives them.
    expect(referenceUrl('https://app.example.test', 'GET', '/api/v1/workspaces/:workspaceId')).toBe(
      'https://app.example.test/developers/api#getWorkspaces_',
    );
    expect(referenceUrl('https://app.example.test', 'GET', '/api/v1/undocumented')).toBe(
      'https://app.example.test/developers/api',
    );
  });

  it('adds the headers only to deprecated routes', () => {
    const Routes = { name: 'Routes' };
    const old = () => 'old';
    const current = () => 'current';
    Deprecated({ since: '2027-01-01T00:00:00Z' })(Routes, 'old', { value: old });
    const env = { APP_BASE_URL: 'https://app.example.test', CORS_ORIGINS: [] } as unknown as Env;
    const interceptor = new DeprecationInterceptor(new Reflector(), env);
    const next: CallHandler = { handle: () => of(null) };
    for (const [handler, expected] of [
      [old, 2],
      [current, 0],
    ] as const) {
      const setHeader = vi.fn();
      const request = { method: 'GET', route: { path: '/api/v1/machine/identity' }, path: '' };
      const context = {
        getHandler: () => handler,
        getClass: () => Routes,
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader }) }),
      } as unknown as ExecutionContext;
      interceptor.intercept(context, next);
      expect(setHeader).toHaveBeenCalledTimes(expected);
      if (expected) {
        expect(setHeader).toHaveBeenCalledWith(
          'Link',
          expect.stringContaining('<https://app.example.test/developers/api#getMachineIdentity>'),
        );
      }
    }
  });
});
