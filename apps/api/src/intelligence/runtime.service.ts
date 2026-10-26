import { Inject, Injectable } from '@nestjs/common';
import type { RuntimeConfiguration, runtimeConfigurationInputSchema } from '@envvault/shared';
import type { z } from 'zod';
import type { AuthorizedEnvironment } from '../auth/principal.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { SecretAuthorizationService } from '../secrets/secret-authorization.service.js';
import { SecretRateLimiter } from '../secrets/secret-rate-limiter.js';
import { SecretVault } from '../secrets/secret-vault.service.js';
import { ConfigurationService } from './configuration.service.js';
import type { ProjectCaller } from './environment-access.service.js';
import { loadRuntimeValues, RUNTIME_ACTION } from './runtime-values.js';

type Input = z.output<typeof runtimeConfigurationInputSchema>;

/**
 * Values for running a local process (`envvault run`). Needs `secret:runtime`,
 * a capability of its own: neither `secret:export` nor `secret:read` implies
 * it. Protected environments need a direct grant (never inherited) and a
 * recent step up. Inherited values come only from a base environment the
 * caller may also load at runtime; the rest are counted, not returned.
 */
@Injectable()
export class RuntimeService {
  constructor(
    private readonly vault: SecretVault,
    private readonly authorization: SecretAuthorizationService,
    private readonly limiter: SecretRateLimiter,
    private readonly configuration: ConfigurationService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async load(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
    input: Input,
  ): Promise<RuntimeConfiguration> {
    const ctx = { principal: caller.principal, environment, requestId: caller.requestId };
    await this.authorization.require(ctx, 'secret:runtime', RUNTIME_ACTION);
    await this.authorization.requireStepUpIfProtected(ctx, null, RUNTIME_ACTION);
    await this.limiter.consume(ctx, 'runtime', environment.scope.environmentId);

    const rows = await this.configuration.rows(caller, environment);
    const base = rows.base?.environment ?? null;
    const baseAllowed =
      input.includeInherited &&
      base !== null &&
      !base.isProtected &&
      base.permissions.has('secret:runtime');
    const inherited = baseAllowed ? rows.inherited : [];
    return loadRuntimeValues(
      this.vault,
      this.env.RUNTIME_MAX_BYTES,
      {
        ctx,
        local: rows.local,
        inherited,
        base: baseAllowed ? base : null,
        withheld: input.includeInherited ? rows.inherited.length - inherited.length : 0,
      },
      { cli: caller.principal.cliSessionId !== undefined },
    );
  }
}
