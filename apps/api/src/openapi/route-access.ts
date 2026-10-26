import { Injectable, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import {
  AUTHORIZATION_KEY,
  type AuthorizationRequirement,
  CLI_ACCESS_KEY,
  IS_PUBLIC_KEY,
  MACHINE_ROUTE_KEY,
  REQUIRE_STEP_UP_KEY,
} from '../auth/auth.decorators.js';
import { DEPRECATION_KEY, type DeprecationNotice } from '../common/deprecation.js';

/** Who may call a route, as the authentication guard decides it. */
export type Caller = 'anonymous' | 'person' | 'cli' | 'machine';

export interface RouteAccess {
  callers: Caller[];
  /** Permission the authorization guard requires, if any. */
  permission: string | null;
  stepUp: boolean;
  deprecated: DeprecationNotice | null;
}

const METHODS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

function join(...parts: (string | undefined)[]): string {
  const path = parts
    .flatMap((p) => (p ?? '').split('/'))
    .filter((p) => p !== '')
    .join('/');
  return `/${path}`.replace(/:(\w+)/g, '{$1}');
}

/**
 * Reads the access rules of every route from the same decorators the global
 * guards enforce, so the API description cannot claim something the guards
 * do not do. Keys are `METHOD /path` relative to `/api/v1`.
 */
@Injectable()
export class RouteAccessService {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  collect(): Map<string, RouteAccess> {
    const routes = new Map<string, RouteAccess>();
    for (const wrapper of this.discovery.getControllers()) {
      const metatype = wrapper.metatype;
      const instance = wrapper.instance as object | null | undefined;
      if (!metatype || !instance) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const base = Reflect.getMetadata(PATH_METADATA, metatype) as string | undefined;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function') continue;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        const method = verb === undefined ? undefined : METHODS[verb];
        if (!method) continue;
        const path = join(base, Reflect.getMetadata(PATH_METADATA, handler) as string | undefined);
        const targets = [handler as (...args: unknown[]) => unknown, metatype];
        const isPublic =
          this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true;
        const machine =
          this.reflector.getAllAndOverride<boolean | undefined>(MACHINE_ROUTE_KEY, targets) ===
          true;
        const cli =
          this.reflector.getAllAndOverride<boolean | undefined>(CLI_ACCESS_KEY, targets) === true;
        const requirement = this.reflector.getAllAndOverride<AuthorizationRequirement | undefined>(
          AUTHORIZATION_KEY,
          targets,
        );
        routes.set(`${method.toUpperCase()} ${path}`, {
          callers: isPublic
            ? ['anonymous']
            : machine
              ? ['machine']
              : cli
                ? ['person', 'cli']
                : ['person'],
          permission:
            requirement && requirement.kind !== 'authenticated' ? requirement.permission : null,
          stepUp:
            this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_STEP_UP_KEY, targets) ===
            true,
          deprecated:
            this.reflector.getAllAndOverride<DeprecationNotice | undefined>(
              DEPRECATION_KEY,
              targets,
            ) ?? null,
        });
      }
    }
    return routes;
  }
}
