import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { StoredSecretVersion, VariableRow } from '@envvault/database';
import {
  CLI_ERROR_CODES,
  CLI_LIMITS,
  type RuntimeConfiguration,
  type runtimeConfigurationInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import type { AuthorizedEnvironment } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { SecretAuthorizationService } from '../secrets/secret-authorization.service.js';
import { SecretRateLimiter } from '../secrets/secret-rate-limiter.js';
import { SecretVault } from '../secrets/secret-vault.service.js';
import { ConfigurationService } from './configuration.service.js';
import type { ProjectCaller } from './environment-access.service.js';

type Input = z.output<typeof runtimeConfigurationInputSchema>;

const ACTION = 'secret.runtime_loaded';

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
    await this.authorization.require(ctx, 'secret:runtime', ACTION);
    await this.authorization.requireStepUpIfProtected(ctx, null, ACTION);
    await this.limiter.consume(ctx, 'runtime', environment.scope.environmentId);

    const rows = await this.configuration.rows(caller, environment);
    const base = rows.base?.environment ?? null;
    const baseAllowed =
      input.includeInherited &&
      base !== null &&
      !base.isProtected &&
      base.permissions.has('secret:runtime');
    const inherited = baseAllowed ? rows.inherited : [];
    const withheld = input.includeInherited ? rows.inherited.length - inherited.length : 0;
    if (rows.local.length + inherited.length > CLI_LIMITS.runtimeMaxValues) {
      throw tooLarge('This environment has more variables than one run can load');
    }

    const repos = this.vault.repos;
    const [localStored, baseStored] = await Promise.all([
      repos.secretBulk.currentVersions(
        environment.scope,
        rows.local.map((r) => r.id),
      ),
      base && inherited.length > 0
        ? repos.secretBulk.currentVersions(
            base.scope,
            inherited.map((r) => r.id),
          )
        : Promise.resolve(new Map<string, StoredSecretVersion>()),
    ]);

    const required = new Set(
      (await repos.validationRules.list(environment.scope))
        .filter((rule) => rule.required)
        .map((rule) => rule.key),
    );
    for (const row of [...rows.local, ...inherited]) if (row.isRequired) required.add(row.key);

    const values: RuntimeConfiguration['values'] = [];
    let bytes = 0;
    const decrypt = async (
      row: VariableRow,
      stored: StoredSecretVersion | undefined,
      target: AuthorizedEnvironment,
      source: 'local' | 'inherited',
    ) => {
      if (!stored) return;
      const value = await this.vault.open(
        { principal: caller.principal, environment: target, requestId: caller.requestId },
        row.id,
        stored,
        { key: row.key, attempted: ACTION },
      );
      bytes += Buffer.byteLength(row.key) + Buffer.byteLength(value);
      if (bytes > this.env.RUNTIME_MAX_BYTES) {
        throw tooLarge('The values of this environment exceed the size one run can load');
      }
      values.push({ key: row.key, value, source });
    };
    for (const row of rows.local) await decrypt(row, localStored.get(row.id), environment, 'local');
    if (base) {
      for (const row of inherited) await decrypt(row, baseStored.get(row.id), base, 'inherited');
    }
    const present = new Set(values.map((v) => v.key));
    const missingRequired = [...required].filter((key) => !present.has(key)).sort();

    // Recorded before anything is returned; if it cannot be, nothing is.
    await this.vault.auditRead(
      ctx,
      ACTION,
      environment.scope.environmentId,
      {
        count: values.length,
        inherited: values.filter((v) => v.source === 'inherited').length,
        withheldInherited: withheld,
        missingRequired: missingRequired.length,
        cli: caller.principal.cliSessionId !== undefined,
      },
      'environment',
      [
        ...rows.local.filter((r) => present.has(r.key)).map((r) => r.id),
        ...inherited.filter((r) => present.has(r.key)).map((r) => r.id),
      ],
    );
    return {
      environmentId: environment.scope.environmentId,
      values,
      missingRequired,
      withheldInherited: withheld,
      issuedAt: new Date().toISOString(),
    };
  }
}

function tooLarge(message: string): ApiException {
  return new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, CLI_ERROR_CODES.RUNTIME_TOO_LARGE, message);
}
