import { HttpStatus, Injectable } from '@nestjs/common';
import {
  createRepositories,
  getConstraintViolation,
  type VariableRow,
  withTransaction,
} from '@envvault/database';
import {
  canModifyEnvironment,
  type EffectiveConfiguration,
  type EffectiveVariable,
  type EnvironmentRef,
  INTELLIGENCE_ERROR_CODES,
  INTELLIGENCE_LIMITS,
} from '@envvault/shared';
import type { AuthorizedEnvironment } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import { protectionRequired } from '../projects/project.helpers.js';
import { SecretVault } from '../secrets/secret-vault.service.js';
import { EnvironmentAccessService, type ProjectCaller } from './environment-access.service.js';
import { metaFromRow } from './variable-meta.js';

type BaseState = NonNullable<EffectiveConfiguration['base']>['state'];

export interface ResolvedBase {
  ref: EnvironmentRef & { state: BaseState };
  /** Present when the caller may read the base's variables and the base is usable. */
  environment: AuthorizedEnvironment | null;
}

export interface EffectiveRows {
  local: VariableRow[];
  /** Inheritable variables of a usable base that no local variable overrides. */
  inherited: VariableRow[];
  /** Local variables that replace an inheritable base variable. */
  overriddenKeys: Set<string>;
  /** The base variables those local variables replace. */
  overridden: VariableRow[];
  base: ResolvedBase | null;
}

function invalid(message: string): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    INTELLIGENCE_ERROR_CODES.INHERITANCE_INVALID,
    message,
  );
}

export function tooLarge(): ApiException {
  return new ApiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    INTELLIGENCE_ERROR_CODES.ENVIRONMENT_TOO_LARGE,
    `This environment has more than ${String(INTELLIGENCE_LIMITS.variables)} variables, which this feature does not handle yet.`,
  );
}

/**
 * Configuration inheritance. An environment may name one base environment of
 * the same project; it then sees the base's live variables that are marked
 * inheritable (never SECRET, enforced in the database), unless it defines a
 * variable with the same name itself (an override). Nothing is copied: the
 * effective configuration is resolved on every read, and inherited values
 * stay in the base and are read through the base's own authorization.
 *
 * A base is usable only while it is live, active, unprotected and readable by
 * the caller (`secret:list` there). Otherwise nothing is inherited and the
 * reason is reported.
 */
@Injectable()
export class ConfigurationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly vault: SecretVault,
    private readonly access: EnvironmentAccessService,
  ) {}

  async resolveBase(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
  ): Promise<ResolvedBase | null> {
    const repos = this.vault.repos;
    const detail = await repos.environments.getDetail(environment.scope);
    if (!detail?.baseEnvironmentId) return null;
    const base = await repos.environments.inProject(caller.project.scope, detail.baseEnvironmentId);
    if (!base) return null;
    const ref = {
      id: base.id,
      name: base.name,
      slug: base.slug,
      isProtected: base.isProtected,
      status: base.status,
    };
    const authorized = base.deleted ? null : await this.access.environment(caller, base.id);
    let state: BaseState = 'ok';
    if (base.deleted) state = 'deleted';
    else if (!authorized?.permissions.has('secret:list')) state = 'no_access';
    else if (base.status === 'ARCHIVED') state = 'archived';
    else if (base.isProtected) state = 'protected';
    // Without access, even the base's name is withheld.
    if (state === 'no_access') {
      return {
        ref: { ...ref, name: 'Restricted environment', slug: '', state },
        environment: null,
      };
    }
    return { ref: { ...ref, state }, environment: state === 'ok' ? authorized : null };
  }

  async rows(caller: ProjectCaller, environment: AuthorizedEnvironment): Promise<EffectiveRows> {
    const repos = this.vault.repos;
    const local = await repos.secretBulk.variables(
      environment.scope,
      INTELLIGENCE_LIMITS.variables,
    );
    if (local.length > INTELLIGENCE_LIMITS.variables) throw tooLarge();
    const base = await this.resolveBase(caller, environment);
    if (!base?.environment) {
      return { local, inherited: [], overriddenKeys: new Set(), overridden: [], base };
    }
    const baseRows = (
      await repos.secretBulk.variables(base.environment.scope, INTELLIGENCE_LIMITS.variables)
    )
      .slice(0, INTELLIGENCE_LIMITS.variables)
      .filter((row) => row.inheritable && row.type !== 'SECRET');
    const localKeys = new Set(local.map((r) => r.key));
    return {
      local,
      inherited: baseRows.filter((r) => !localKeys.has(r.key)),
      overriddenKeys: new Set(baseRows.filter((r) => localKeys.has(r.key)).map((r) => r.key)),
      overridden: baseRows.filter((r) => localKeys.has(r.key)),
      base,
    };
  }

  async effective(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
  ): Promise<EffectiveConfiguration> {
    const resolved = await this.rows(caller, environment);
    const items: EffectiveVariable[] = [
      ...resolved.local.map((row) => ({
        key: row.key,
        source: 'local' as const,
        overridesInherited: resolved.overriddenKeys.has(row.key),
        meta: metaFromRow(row),
        environmentId: environment.scope.environmentId,
      })),
      ...resolved.inherited.map((row) => ({
        key: row.key,
        source: 'inherited' as const,
        overridesInherited: false,
        meta: metaFromRow(row),
        environmentId: resolved.base?.ref.id ?? environment.scope.environmentId,
      })),
    ].sort((a, b) => a.key.localeCompare(b.key));
    return {
      environmentId: environment.scope.environmentId,
      base: resolved.base?.ref ?? null,
      items,
      summary: {
        local: resolved.local.length,
        inherited: resolved.inherited.length,
        overridden: resolved.overriddenKeys.size,
      },
    };
  }

  /**
   * Sets or clears the base. Needs `environment:update` here (and
   * `environment:protect` for a protected environment) and `secret:list` on
   * the base, so nobody links to configuration they cannot read.
   */
  async setBase(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
    baseEnvironmentId: string | null,
  ): Promise<EffectiveConfiguration> {
    if (
      !canModifyEnvironment(environment.permissions, 'environment:update', environment.isProtected)
    ) {
      throw protectionRequired();
    }
    const repos = this.vault.repos;
    const before = await repos.environments.getDetail(environment.scope);
    if (!before) throw invalid('The environment no longer exists');
    if (baseEnvironmentId !== null) {
      if (baseEnvironmentId === environment.scope.environmentId) {
        throw invalid('An environment cannot inherit from itself');
      }
      const target = await this.access.environment(caller, baseEnvironmentId);
      const base = await repos.environments.inProject(caller.project.scope, baseEnvironmentId);
      if (!target || !base || base.deleted) {
        throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
      }
      if (!target.permissions.has('secret:list')) {
        throw invalid('You cannot read the variables of that environment');
      }
      if (base.isProtected) throw invalid('Protected environments cannot be used as a base');
      if (base.status === 'ARCHIVED')
        throw invalid('Archived environments cannot be used as a base');
      if (base.baseEnvironmentId !== null) {
        throw invalid('That environment inherits from another one; only one level is supported');
      }
      if ((await repos.environments.inheritors(environment.scope)).length > 0) {
        throw invalid('Other environments inherit from this one, so it cannot inherit itself');
      }
    }
    try {
      await withTransaction(this.database.client, async (tx) => {
        const writes = createRepositories(tx);
        if (!(await writes.environments.setBase(environment.scope, baseEnvironmentId))) {
          throw invalid('Archived environments cannot change their base');
        }
        await this.vault.audit(
          writes,
          { principal: caller.principal, environment, requestId: caller.requestId },
          'environment.inheritance_changed',
          environment.scope.environmentId,
          { from: before.baseEnvironmentId, to: baseEnvironmentId },
          { resourceType: 'environment' },
        );
      });
    } catch (error) {
      // The trigger is the final word on chains and cycles under concurrency.
      if (getConstraintViolation(error)?.kind === 'check') {
        throw invalid('That base would create a chain or a cycle of inheritance');
      }
      throw error;
    }
    return this.effective(caller, environment);
  }
}
