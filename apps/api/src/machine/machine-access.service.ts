import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  createAuthorizedEnvironmentScope,
  type MachineEnvironmentGrants,
  type VariableRow,
} from '@envvault/database';
import {
  AUTH_ERROR_CODES,
  evaluateMachinePermissions,
  INTELLIGENCE_LIMITS,
  type MachineEnvironment,
  type MachineSelf,
  type MachineVariableList,
  PROJECT_ERROR_CODES,
  type RuntimeConfiguration,
  type runtimeConfigurationInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import type { AuthorizedEnvironment, MachinePrincipal } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { loadRuntimeValues, RUNTIME_ACTION } from '../intelligence/runtime-values.js';
import { SensitiveRateLimiter } from '../rate-limit/sensitive-rate-limiter.js';
import type { MachineRequestContext } from '../secrets/secret-authorization.service.js';
import { SecretVault } from '../secrets/secret-vault.service.js';

type RuntimeInput = z.output<typeof runtimeConfigurationInputSchema>;

interface Evaluated {
  record: MachineEnvironmentGrants;
  permissions: Set<string>;
}

function notFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
}

/**
 * What a machine identity may do, decided per request from the database:
 * its grants on each environment of its own project, minus DENY, confined to
 * the machine permissions and to the token's scopes and environments.
 * Environments it may not read are indistinguishable from missing ones.
 */
@Injectable()
export class MachineAccessService {
  constructor(
    private readonly vault: SecretVault,
    private readonly limiter: SensitiveRateLimiter,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  private async evaluate(machine: MachinePrincipal, now = new Date()): Promise<Evaluated[]> {
    const project = await this.vault.repos.machineIdentities.liveProject(
      machine.workspaceId,
      machine.projectId,
    );
    if (!project) return [];
    const restricted = new Set(machine.environmentIds);
    const records = await this.vault.repos.machineIdentities.environmentsWithGrants(
      machine.workspaceId,
      machine.projectId,
      machine.serviceIdentityId,
    );
    return records
      .filter((r) => restricted.size === 0 || restricted.has(r.environment.id))
      .map((record) => ({
        record,
        permissions: evaluateMachinePermissions({
          grants: record.grants,
          scopes: machine.scopes,
          now,
        }),
      }))
      .filter((e) => e.permissions.has('environment:read'));
  }

  private toEnvironment(e: Evaluated): MachineEnvironment {
    const env = e.record.environment;
    return {
      id: env.id,
      name: env.name,
      slug: env.slug,
      kind: env.kind as MachineEnvironment['kind'],
      isProtected: env.isProtected,
      status: env.status,
      permissions: [...e.permissions].sort(),
    };
  }

  async self(machine: MachinePrincipal): Promise<MachineSelf> {
    const project = await this.vault.repos.machineIdentities.liveProject(
      machine.workspaceId,
      machine.projectId,
    );
    if (!project) throw notFound();
    return {
      identity: {
        id: machine.serviceIdentityId,
        name: machine.identityName,
        workspaceId: machine.workspaceId,
        projectId: machine.projectId,
        projectName: project.name,
      },
      credential: {
        id: machine.credentialId,
        name: machine.credentialName,
        expiresAt: machine.credentialExpiresAt.toISOString(),
      },
      token: {
        expiresAt: machine.tokenExpiresAt.toISOString(),
        scopes: [...machine.scopes].sort() as MachineSelf['token']['scopes'],
        environmentIds: [...machine.environmentIds],
      },
      environments: (await this.evaluate(machine)).map((e) => this.toEnvironment(e)),
    };
  }

  async environments(machine: MachinePrincipal): Promise<MachineEnvironment[]> {
    return (await this.evaluate(machine)).map((e) => this.toEnvironment(e));
  }

  async environment(machine: MachinePrincipal, environmentId: string): Promise<MachineEnvironment> {
    return this.toEnvironment(await this.find(machine, environmentId));
  }

  private async find(machine: MachinePrincipal, environmentId: string): Promise<Evaluated> {
    const found = (await this.evaluate(machine)).find(
      (e) => e.record.environment.id === environmentId.toLowerCase(),
    );
    if (!found) throw notFound();
    return found;
  }

  /** The environment as the vault expects it, after the permission and archive checks. */
  private async authorize(
    machine: MachinePrincipal,
    environmentId: string,
    permission: string,
    action: string,
    requestId: string | null,
  ): Promise<{ ctx: MachineRequestContext; evaluated: Evaluated; all: Evaluated[] }> {
    const all = await this.evaluate(machine);
    const evaluated = all.find((e) => e.record.environment.id === environmentId.toLowerCase());
    if (!evaluated) throw notFound();
    const env = evaluated.record.environment;
    const authorized: AuthorizedEnvironment = {
      scope: createAuthorizedEnvironmentScope(machine.workspaceId, machine.projectId, env.id),
      permissions: evaluated.permissions,
      isProtected: env.isProtected,
      archived: env.status === 'ARCHIVED',
    };
    const ctx: MachineRequestContext = { machine, environment: authorized, requestId };
    if (!evaluated.permissions.has(permission)) {
      await this.vault.audit(
        this.vault.repos,
        ctx,
        'machine.access_denied',
        env.id,
        { permission, attempted: action, credentialId: machine.credentialId },
        { outcome: 'DENIED', resourceType: 'environment' },
      );
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.FORBIDDEN,
        env.isProtected
          ? `This environment is protected. ${permission} must be granted to this identity on it directly.`
          : `This identity lacks ${permission} here`,
      );
    }
    if (authorized.archived) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        PROJECT_ERROR_CODES.ENVIRONMENT_ARCHIVED,
        'This environment is archived.',
      );
    }
    return { ctx, evaluated, all };
  }

  async variables(
    machine: MachinePrincipal,
    environmentId: string,
    requestId: string | null,
  ): Promise<MachineVariableList> {
    const { ctx } = await this.authorize(
      machine,
      environmentId,
      'secret:list',
      'secret.listed',
      requestId,
    );
    const rows = await this.vault.repos.secretBulk.variables(
      ctx.environment.scope,
      INTELLIGENCE_LIMITS.variables,
    );
    return {
      environmentId: ctx.environment.scope.environmentId,
      items: rows
        .filter((r) => !r.deleted)
        .map((r) => ({
          key: r.key,
          type: r.type,
          isRequired: r.isRequired,
          hasValue: r.currentVersionId !== null,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  /**
   * Values for a machine process. Same rules as `envvault run` for people,
   * except there is no step up: a protected environment simply needs a
   * direct grant, which only someone holding the permission there could give.
   */
  async runtime(
    machine: MachinePrincipal,
    environmentId: string,
    input: RuntimeInput,
    requestId: string | null,
  ): Promise<RuntimeConfiguration> {
    const { ctx, evaluated, all } = await this.authorize(
      machine,
      environmentId,
      'secret:runtime',
      RUNTIME_ACTION,
      requestId,
    );
    await this.limiter.consume({
      userId: `machine:${machine.serviceIdentityId}`,
      action: 'machine-runtime',
      resourceId: ctx.environment.scope.environmentId,
      onBlocked: () =>
        this.vault.audit(
          this.vault.repos,
          ctx,
          'security.rate_limited',
          ctx.environment.scope.environmentId,
          { action: 'machine-runtime' },
          { outcome: 'DENIED', resourceType: 'environment' },
        ),
    });

    const repos = this.vault.repos;
    const local = (
      await repos.secretBulk.variables(ctx.environment.scope, INTELLIGENCE_LIMITS.variables)
    ).filter((r) => !r.deleted);

    let inherited: VariableRow[] = [];
    let withheld = 0;
    let base: AuthorizedEnvironment | null = null;
    const baseId = evaluated.record.environment.baseEnvironmentId;
    const baseEvaluated = baseId ? all.find((e) => e.record.environment.id === baseId) : undefined;
    // The base is used only while live, active, unprotected and listable by this identity.
    if (
      input.includeInherited &&
      baseEvaluated?.record.environment.status === 'ACTIVE' &&
      !baseEvaluated.record.environment.isProtected &&
      baseEvaluated.permissions.has('secret:list')
    ) {
      const localKeys = new Set(local.map((r) => r.key));
      const baseScope = createAuthorizedEnvironmentScope(
        machine.workspaceId,
        machine.projectId,
        baseEvaluated.record.environment.id,
      );
      const candidates = (
        await repos.secretBulk.variables(baseScope, INTELLIGENCE_LIMITS.variables)
      )
        .filter((r) => !r.deleted && r.inheritable && r.type !== 'SECRET')
        .filter((r) => !localKeys.has(r.key));
      if (baseEvaluated.permissions.has('secret:runtime')) {
        inherited = candidates;
        base = {
          scope: baseScope,
          permissions: baseEvaluated.permissions,
          isProtected: false,
          archived: false,
        };
      } else {
        withheld = candidates.length;
      }
    }
    return loadRuntimeValues(
      this.vault,
      this.env.RUNTIME_MAX_BYTES,
      { ctx, local, inherited, base, withheld },
      { machine: true, credentialId: machine.credentialId },
    );
  }
}
