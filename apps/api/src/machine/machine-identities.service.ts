import { HttpStatus, Injectable } from '@nestjs/common';
import {
  createRepositories,
  decodeActivityCursor,
  encodeActivityCursor,
  getConstraintViolation,
  type MachineIdentityRecord,
  type Repositories,
  type ServiceCredentialRecord,
  withTransaction,
  workspaceScopeOf,
} from '@envvault/database';
import {
  AUTH_ERROR_CODES,
  evaluateMachinePermissions,
  type createMachineGrantInputSchema,
  type createMachineIdentityInputSchema,
  type createServiceCredentialInputSchema,
  type disableMachineIdentityInputSchema,
  isMachineGrantable,
  type IssuedServiceCredential,
  MACHINE_ERROR_CODES,
  MACHINE_LIMITS,
  type MachineActivityPage,
  type MachineIdentityList,
  type MachineIdentityStatus,
  type MachineIdentitySummary,
  type machineIdentityQuerySchema,
  PROJECT_ERROR_CODES,
  type revokeServiceCredentialInputSchema,
  type rotateServiceCredentialInputSchema,
  type ServiceCredential,
  type updateMachineIdentityInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  EnvironmentAccessService,
  type ProjectCaller,
} from '../intelligence/environment-access.service.js';
import { SensitiveRateLimiter } from '../rate-limit/sensitive-rate-limiter.js';
import { MachineAuthService } from './machine-auth.service.js';
import { displayPrefix, issueCredentialToken } from './machine-tokens.js';

type Out<T extends z.ZodType> = z.output<T>;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function fail(status: HttpStatus, code: string, message: string): ApiException {
  return new ApiException(status, code, message);
}
const notFound = () => fail(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
const invalid = (message: string) =>
  fail(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', message);

function statusOf(identity: MachineIdentityRecord, now: Date): MachineIdentityStatus {
  if (identity.retiredAt) return 'RETIRED';
  if (identity.status === 'DISABLED') return 'DISABLED';
  if (identity.expiresAt && identity.expiresAt <= now) return 'EXPIRED';
  return 'ACTIVE';
}

function credentialStatus(c: ServiceCredentialRecord, now: Date): ServiceCredential['status'] {
  if (c.revokedAt) return 'REVOKED';
  if (c.expiresAt <= now) return 'EXPIRED';
  if (c.replacedById) return 'EXPIRING';
  return 'ACTIVE';
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * Management of machine identities by people with `service_identity:*` on
 * the project. Identities never inherit their creator's access: grants are
 * explicit, limited to machine permissions, and nobody can grant more than
 * they hold on that environment themselves. Issuing, rotating and revoking
 * credentials, enabling an identity again and widening its access need a
 * recent password confirmation.
 */
@Injectable()
export class MachineIdentitiesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: EnvironmentAccessService,
    private readonly auth: MachineAuthService,
    private readonly limiter: SensitiveRateLimiter,
  ) {}

  private get repos(): Repositories {
    return createRepositories(this.database.client);
  }

  private summary(identity: MachineIdentityRecord, now: Date): MachineIdentitySummary {
    return {
      id: identity.id,
      name: identity.name,
      description: identity.description,
      projectId: identity.projectId,
      status: statusOf(identity, now),
      expiresAt: iso(identity.expiresAt),
      credentialMaxLifetimeDays: identity.credentialMaxLifetimeDays,
      createdAt: identity.createdAt.toISOString(),
      createdBy: identity.createdBy,
      lastAuthenticatedAt: iso(identity.lastAuthenticatedAt),
      lastUsedAt: iso(identity.lastUsedAt),
      disabledAt: iso(identity.disabledAt),
      disabledReason: identity.disabledReason,
      activeCredentials: identity.activeCredentials,
      grants: identity.grants.map((g) => ({
        id: g.id,
        environment: g.environment,
        role: g.role,
        effect: g.effect,
        expiresAt: iso(g.expiresAt),
        createdAt: g.createdAt.toISOString(),
        createdBy: g.createdBy,
      })),
    };
  }

  private credential(c: ServiceCredentialRecord, now: Date): ServiceCredential {
    return {
      id: c.id,
      name: c.name,
      displayPrefix: displayPrefix(c.tokenPrefix),
      scopes: c.scopes as ServiceCredential['scopes'],
      status: credentialStatus(c, now),
      createdAt: c.createdAt.toISOString(),
      createdBy: c.createdBy,
      expiresAt: c.expiresAt.toISOString(),
      lastUsedAt: iso(c.lastUsedAt),
      revokedAt: iso(c.revokedAt),
      revocationReason: c.revocationReason,
      rotatedFromId: c.rotatedFromId,
      replacedById: c.replacedById,
    };
  }

  private async audit(
    repos: Repositories,
    caller: ProjectCaller,
    identityId: string,
    action: string,
    metadata: Record<string, string | number | boolean | string[] | null>,
    environmentId: string | null = null,
  ): Promise<void> {
    await repos.audit.append({
      workspaceId: caller.project.scope.workspaceId,
      projectId: caller.project.scope.projectId,
      environmentId,
      actorUserId: caller.principal.userId,
      action,
      outcome: 'SUCCESS',
      resourceType: 'service_identity',
      resourceId: identityId,
      requestId: caller.requestId,
      metadata,
    });
  }

  /** For actions whose route cannot carry @RequireStepUp because it depends on the input. */
  private async requireStepUp(caller: ProjectCaller): Promise<void> {
    const expiry = await this.repos.authState.findActiveStepUpExpiry(caller.principal.userId);
    if (!expiry) {
      throw fail(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.STEP_UP_REQUIRED,
        'Confirm your password to continue',
      );
    }
  }

  private async liveIdentity(caller: ProjectCaller, id: string, now: Date) {
    const identity = await this.repos.machineIdentities.get(caller.project.scope, id, now);
    if (!identity) throw notFound();
    if (identity.retiredAt) {
      throw fail(
        HttpStatus.CONFLICT,
        MACHINE_ERROR_CODES.IDENTITY_RETIRED,
        'This identity is retired',
      );
    }
    return identity;
  }

  /* ------------------------------------------------------------ identities */

  async list(
    caller: ProjectCaller,
    query: Out<typeof machineIdentityQuerySchema>,
  ): Promise<MachineIdentityList> {
    const now = new Date();
    const repos = this.repos;
    const [records, roles] = await Promise.all([
      repos.machineIdentities.list(
        caller.project.scope,
        { q: query.q, includeRetired: query.includeRetired === true || query.status === 'RETIRED' },
        now,
      ),
      repos.roles.listScopedRoles(workspaceScopeOf(caller.project.scope), 'ENVIRONMENT'),
    ]);
    const items = records
      .map((r) => this.summary(r, now))
      .filter((s) => !query.status || s.status === query.status);
    return {
      items,
      roles: roles
        .filter((r) => isMachineGrantable(r.permissions))
        .map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          permissions: [...r.permissions].sort(),
        })),
      credentialsDurable: this.auth.durable,
    };
  }

  async get(caller: ProjectCaller, id: string): Promise<MachineIdentitySummary> {
    const now = new Date();
    const identity = await this.repos.machineIdentities.get(caller.project.scope, id, now);
    if (!identity) throw notFound();
    return this.summary(identity, now);
  }

  async create(
    caller: ProjectCaller,
    input: Out<typeof createMachineIdentityInputSchema>,
  ): Promise<MachineIdentitySummary> {
    const now = new Date();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt <= now) throw invalid('Expiry must be in the future');
    const id = await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (
        (await repos.machineIdentities.countLive(caller.project.scope)) >=
        MACHINE_LIMITS.maxIdentitiesPerProject
      ) {
        throw fail(
          HttpStatus.CONFLICT,
          MACHINE_ERROR_CODES.IDENTITY_LIMIT_REACHED,
          `A project can have at most ${String(MACHINE_LIMITS.maxIdentitiesPerProject)} machine identities`,
        );
      }
      const created = await this.nameSafe(() =>
        repos.machineIdentities.create(caller.project.scope, {
          name: input.name,
          description: input.description ?? null,
          expiresAt,
          credentialMaxLifetimeDays: input.credentialMaxLifetimeDays,
          createdById: caller.principal.userId,
        }),
      );
      await this.audit(repos, caller, created, 'machine_identity.created', {
        name: input.name,
        credentialMaxLifetimeDays: input.credentialMaxLifetimeDays,
        expiresAt: iso(expiresAt),
      });
      return created;
    });
    return this.get(caller, id);
  }

  private async nameSafe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        getConstraintViolation(error)?.constraint === 'service_identities_workspace_name_live_key'
      ) {
        throw fail(
          HttpStatus.CONFLICT,
          MACHINE_ERROR_CODES.IDENTITY_NAME_TAKEN,
          'A machine identity with this name already exists in this workspace',
        );
      }
      throw error;
    }
  }

  async update(
    caller: ProjectCaller,
    id: string,
    input: Out<typeof updateMachineIdentityInputSchema>,
  ): Promise<MachineIdentitySummary> {
    const now = new Date();
    const identity = await this.liveIdentity(caller, id, now);
    const patch: Parameters<Repositories['machineIdentities']['update']>[2] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined)
      patch.description = input.description === '' ? null : input.description;
    if (input.credentialMaxLifetimeDays !== undefined) {
      patch.credentialMaxLifetimeDays = input.credentialMaxLifetimeDays;
    }
    if (input.expiresAt !== undefined) {
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (expiresAt && expiresAt <= now) throw invalid('Expiry must be in the future');
      const current = identity.expiresAt;
      // Removing or extending an expiry widens access, so it needs a confirmation.
      const widens = current !== null && (expiresAt === null || expiresAt > current);
      if (widens) await this.requireStepUp(caller);
      patch.expiresAt = expiresAt;
    }
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      await this.nameSafe(() => repos.machineIdentities.update(caller.project.scope, id, patch));
      await this.audit(repos, caller, id, 'machine_identity.updated', {
        fields: Object.keys(patch).sort(),
        ...(patch.expiresAt !== undefined ? { expiresAt: iso(patch.expiresAt) } : {}),
      });
    });
    return this.get(caller, id);
  }

  async disable(
    caller: ProjectCaller,
    id: string,
    input: Out<typeof disableMachineIdentityInputSchema>,
  ): Promise<MachineIdentitySummary> {
    const now = new Date();
    await this.liveIdentity(caller, id, now);
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const changed = await repos.machineIdentities.disable(
        caller.project.scope,
        id,
        caller.principal.userId,
        input.reason ?? null,
        now,
      );
      if (changed) {
        await this.audit(repos, caller, id, 'machine_identity.disabled', {
          reason: input.reason ?? null,
        });
      }
    });
    return this.get(caller, id);
  }

  async enable(caller: ProjectCaller, id: string): Promise<MachineIdentitySummary> {
    const now = new Date();
    await this.liveIdentity(caller, id, now);
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (await repos.machineIdentities.enable(caller.project.scope, id)) {
        await this.audit(repos, caller, id, 'machine_identity.enabled', {});
      }
    });
    return this.get(caller, id);
  }

  async retire(caller: ProjectCaller, id: string): Promise<void> {
    const now = new Date();
    await this.liveIdentity(caller, id, now);
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (
        await repos.machineIdentities.retire(caller.project.scope, id, caller.principal.userId, now)
      ) {
        await this.audit(repos, caller, id, 'machine_identity.retired', {});
      }
    });
  }

  /* ----------------------------------------------------------- credentials */

  async credentials(caller: ProjectCaller, id: string): Promise<{ items: ServiceCredential[] }> {
    const now = new Date();
    const identity = await this.repos.machineIdentities.get(caller.project.scope, id, now);
    if (!identity) throw notFound();
    const rows = await this.repos.machineIdentities.listCredentials(caller.project.scope, id);
    return { items: rows.map((c) => this.credential(c, now)) };
  }

  private lifetimeEnd(identity: MachineIdentityRecord, days: number, now: Date): Date {
    if (days > identity.credentialMaxLifetimeDays) {
      throw invalid(
        `Credentials of this identity can last at most ${String(identity.credentialMaxLifetimeDays)} days`,
      );
    }
    const end = new Date(now.getTime() + days * DAY_MS);
    return identity.expiresAt && identity.expiresAt < end ? identity.expiresAt : end;
  }

  private assertIssuable(identity: MachineIdentityRecord, now: Date): void {
    const status = statusOf(identity, now);
    if (status === 'DISABLED') {
      throw fail(
        HttpStatus.CONFLICT,
        MACHINE_ERROR_CODES.IDENTITY_DISABLED,
        'Enable the identity first',
      );
    }
    if (status === 'EXPIRED') {
      throw fail(
        HttpStatus.CONFLICT,
        MACHINE_ERROR_CODES.IDENTITY_EXPIRED,
        'This identity has expired',
      );
    }
  }

  /**
   * Whoever receives a credential can use everything it reaches, so the
   * issuer must hold, on every environment the identity is granted, the
   * permissions this credential's scopes would unlock there. Otherwise a
   * project admin without Production access could issue a credential for an
   * identity someone else granted Production, and read Production through it.
   */
  private async assertIssuerAuthority(
    caller: ProjectCaller,
    identity: MachineIdentityRecord,
    scopes: readonly string[],
  ): Promise<void> {
    const byEnvironment = new Map<string, MachineIdentityRecord['grants']>();
    for (const grant of identity.grants) {
      byEnvironment.set(grant.environment.id, [
        ...(byEnvironment.get(grant.environment.id) ?? []),
        grant,
      ]);
    }
    const missing: string[] = [];
    for (const [environmentId, grants] of byEnvironment) {
      const reached = evaluateMachinePermissions({
        grants: grants.map((g) => ({
          effect: g.effect,
          expiresAt: g.expiresAt,
          permissions: g.role.permissions,
        })),
        scopes,
      });
      if (reached.size === 0) continue;
      const own = await this.access.environment(caller, environmentId);
      const lacking = [...reached].filter((p) => !own?.permissions.has(p)).sort();
      if (lacking.length > 0) {
        missing.push(`${grants[0]?.environment.name ?? environmentId}: ${lacking.join(', ')}`);
      }
    }
    if (missing.length === 0) return;
    await this.repos.audit.append({
      workspaceId: caller.project.scope.workspaceId,
      projectId: caller.project.scope.projectId,
      actorUserId: caller.principal.userId,
      action: 'service_credential.refused',
      outcome: 'DENIED',
      resourceType: 'service_identity',
      resourceId: identity.id,
      requestId: caller.requestId,
      metadata: { missing },
    });
    throw fail(
      HttpStatus.FORBIDDEN,
      MACHINE_ERROR_CODES.GRANT_EXCEEDS_AUTHORITY,
      `This credential would reach more than you can yourself (${missing.join('; ')}). Ask someone with that access to issue it, or narrow its scopes.`,
    );
  }

  async issue(
    caller: ProjectCaller,
    id: string,
    input: Out<typeof createServiceCredentialInputSchema>,
  ): Promise<IssuedServiceCredential> {
    const now = new Date();
    const identity = await this.liveIdentity(caller, id, now);
    this.assertIssuable(identity, now);
    await this.assertIssuerAuthority(caller, identity, input.scopes);
    const expiresAt = this.lifetimeEnd(identity, input.expiresInDays, now);
    await this.limiter.consume({ userId: caller.principal.userId, action: 'credential-issue' });
    const issued = issueCredentialToken(this.auth.keys);
    const credentialId = await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (
        (await repos.machineIdentities.countActiveCredentials(id, now)) >=
        MACHINE_LIMITS.maxActiveCredentials
      ) {
        throw fail(
          HttpStatus.CONFLICT,
          MACHINE_ERROR_CODES.CREDENTIAL_LIMIT_REACHED,
          `An identity can have at most ${String(MACHINE_LIMITS.maxActiveCredentials)} active credentials. Revoke one first.`,
        );
      }
      const created = await repos.machineIdentities.createCredential({
        workspaceId: caller.project.scope.workspaceId,
        serviceIdentityId: id,
        name: input.name,
        lookupId: issued.lookupId,
        digest: issued.digest,
        digestKeyId: issued.digestKeyId,
        scopes: [...input.scopes].sort(),
        expiresAt,
        createdById: caller.principal.userId,
      });
      await this.audit(repos, caller, id, 'service_credential.created', {
        credentialId: created,
        name: input.name,
        scopes: [...input.scopes].sort(),
        expiresAt: expiresAt.toISOString(),
      });
      return created;
    });
    const record = await this.repos.machineIdentities.getCredential(
      caller.project.scope,
      id,
      credentialId,
    );
    if (!record) throw notFound();
    return {
      credential: this.credential(record, now),
      token: issued.token,
      previousExpiresAt: null,
    };
  }

  /**
   * Issues a replacement with the same name and scopes. The old credential
   * keeps working for the overlap (0 ends it now), so deployments can switch
   * without downtime. A credential is replaced at most once: concurrent
   * rotations of the same one fail on the unique `rotated_from_id`.
   */
  async rotate(
    caller: ProjectCaller,
    id: string,
    credentialId: string,
    input: Out<typeof rotateServiceCredentialInputSchema>,
  ): Promise<IssuedServiceCredential> {
    const now = new Date();
    const identity = await this.liveIdentity(caller, id, now);
    this.assertIssuable(identity, now);
    const old = await this.repos.machineIdentities.getCredential(
      caller.project.scope,
      id,
      credentialId,
    );
    if (!old) throw notFound();
    await this.assertIssuerAuthority(caller, identity, old.scopes);
    if (old.replacedById) {
      throw fail(
        HttpStatus.CONFLICT,
        MACHINE_ERROR_CODES.CREDENTIAL_ALREADY_ROTATED,
        'This credential was already rotated',
      );
    }
    if (old.revokedAt || old.expiresAt <= now) {
      throw fail(
        HttpStatus.CONFLICT,
        old.revokedAt
          ? MACHINE_ERROR_CODES.CREDENTIAL_REVOKED
          : MACHINE_ERROR_CODES.CREDENTIAL_EXPIRED,
        'Only a working credential can be rotated; issue a new one instead',
      );
    }
    const originalDays = Math.max(
      1,
      Math.round((old.expiresAt.getTime() - old.createdAt.getTime()) / DAY_MS),
    );
    const expiresAt = this.lifetimeEnd(
      identity,
      input.expiresInDays ?? Math.min(originalDays, identity.credentialMaxLifetimeDays),
      now,
    );
    await this.limiter.consume({ userId: caller.principal.userId, action: 'credential-issue' });
    const issued = issueCredentialToken(this.auth.keys);
    const overlapEnd = new Date(now.getTime() + input.overlapHours * HOUR_MS);
    const newId = await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      let created: string;
      try {
        created = await repos.machineIdentities.createCredential({
          workspaceId: caller.project.scope.workspaceId,
          serviceIdentityId: id,
          name: old.name,
          lookupId: issued.lookupId,
          digest: issued.digest,
          digestKeyId: issued.digestKeyId,
          scopes: old.scopes,
          expiresAt,
          createdById: caller.principal.userId,
          rotatedFromId: old.id,
        });
      } catch (error) {
        if (
          getConstraintViolation(error)?.constraint === 'service_credentials_rotated_from_id_key'
        ) {
          throw fail(
            HttpStatus.CONFLICT,
            MACHINE_ERROR_CODES.CREDENTIAL_ALREADY_ROTATED,
            'This credential was already rotated',
          );
        }
        throw error;
      }
      if (input.overlapHours === 0) {
        await repos.machineIdentities.revokeCredential(
          caller.project.scope,
          id,
          old.id,
          caller.principal.userId,
          'rotated',
          now,
        );
      } else {
        await repos.machineIdentities.endCredentialAt(old.id, overlapEnd);
      }
      await this.audit(repos, caller, id, 'service_credential.rotated', {
        credentialId: created,
        rotatedFromId: old.id,
        overlapHours: input.overlapHours,
        expiresAt: expiresAt.toISOString(),
      });
      return created;
    });
    const record = await this.repos.machineIdentities.getCredential(
      caller.project.scope,
      id,
      newId,
    );
    if (!record) throw notFound();
    const previous = await this.repos.machineIdentities.getCredential(
      caller.project.scope,
      id,
      old.id,
    );
    return {
      credential: this.credential(record, now),
      token: issued.token,
      previousExpiresAt: previous?.revokedAt
        ? previous.revokedAt.toISOString()
        : (previous?.expiresAt.toISOString() ?? null),
    };
  }

  async revoke(
    caller: ProjectCaller,
    id: string,
    credentialId: string,
    input: Out<typeof revokeServiceCredentialInputSchema>,
  ): Promise<ServiceCredential> {
    const now = new Date();
    const identity = await this.repos.machineIdentities.get(caller.project.scope, id, now);
    if (!identity) throw notFound();
    const reason = input.reason ?? 'revoked';
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const existing = await repos.machineIdentities.getCredential(
        caller.project.scope,
        id,
        credentialId,
      );
      if (!existing) throw notFound();
      if (
        await repos.machineIdentities.revokeCredential(
          caller.project.scope,
          id,
          credentialId,
          caller.principal.userId,
          reason,
          now,
        )
      ) {
        await this.audit(repos, caller, id, 'service_credential.revoked', { credentialId, reason });
      }
    });
    const record = await this.repos.machineIdentities.getCredential(
      caller.project.scope,
      id,
      credentialId,
    );
    if (!record) throw notFound();
    return this.credential(record, now);
  }

  /* ---------------------------------------------------------------- grants */

  /**
   * ALLOW grants widen access, so the person granting must hold every
   * permission of the role on that environment themselves (a workspace owner
   * without secret access cannot hand a machine runtime access to
   * Production), plus `access_policy:manage`, `environment:protect` on a
   * protected environment, and a recent password confirmation.
   */
  async grant(
    caller: ProjectCaller,
    id: string,
    input: Out<typeof createMachineGrantInputSchema>,
  ): Promise<MachineIdentitySummary> {
    const now = new Date();
    await this.liveIdentity(caller, id, now);
    const environment = await this.access.environment(caller, input.environmentId);
    if (!environment) throw notFound();
    if (environment.archived) {
      throw fail(
        HttpStatus.CONFLICT,
        PROJECT_ERROR_CODES.ENVIRONMENT_ARCHIVED,
        'This environment is archived.',
      );
    }
    if (!environment.permissions.has('access_policy:manage')) {
      throw fail(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.FORBIDDEN,
        'You cannot manage access to this environment',
      );
    }
    if (environment.isProtected && !environment.permissions.has('environment:protect')) {
      throw fail(
        HttpStatus.FORBIDDEN,
        PROJECT_ERROR_CODES.PROTECTION_REQUIRED,
        'Changing access to a protected environment needs environment:protect',
      );
    }
    const repos = this.repos;
    const role = await repos.roles.findScopedRole(
      workspaceScopeOf(caller.project.scope),
      'ENVIRONMENT',
      input.roleKey,
    );
    if (!role) throw notFound();
    if (!isMachineGrantable(role.permissions)) {
      throw fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        MACHINE_ERROR_CODES.ROLE_NOT_MACHINE_GRANTABLE,
        'Machines can only hold environment:read, secret:list and secret:runtime',
      );
    }
    if (input.effect === 'ALLOW') {
      const missing = role.permissions.filter((p) => !environment.permissions.has(p));
      if (missing.length > 0) {
        await repos.audit.append({
          workspaceId: caller.project.scope.workspaceId,
          projectId: caller.project.scope.projectId,
          environmentId: environment.scope.environmentId,
          actorUserId: caller.principal.userId,
          action: 'machine.grant_refused',
          outcome: 'DENIED',
          resourceType: 'service_identity',
          resourceId: id,
          requestId: caller.requestId,
          metadata: { role: role.key, missing: missing.sort() },
        });
        throw fail(
          HttpStatus.FORBIDDEN,
          MACHINE_ERROR_CODES.GRANT_EXCEEDS_AUTHORITY,
          `You can only grant what you hold here yourself (missing ${missing.sort().join(', ')})`,
        );
      }
      await this.requireStepUp(caller);
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt <= now) throw invalid('Expiry must be in the future');
    await this.limiter.consume({ userId: caller.principal.userId, action: 'access-change' });
    await withTransaction(this.database.client, async (tx) => {
      const txRepos = createRepositories(tx);
      let grantId: string;
      try {
        grantId = await txRepos.machineIdentities.createGrant(environment.scope, {
          serviceIdentityId: id,
          roleId: role.id,
          effect: input.effect,
          expiresAt,
          createdById: caller.principal.userId,
        });
      } catch (error) {
        if (getConstraintViolation(error)?.kind === 'unique') {
          throw fail(
            HttpStatus.CONFLICT,
            MACHINE_ERROR_CODES.GRANT_EXISTS,
            'This identity already has this role here',
          );
        }
        throw error;
      }
      await this.audit(
        txRepos,
        caller,
        id,
        'machine_identity.grant_added',
        {
          grantId,
          role: role.key,
          effect: input.effect,
          protected: environment.isProtected,
          expiresAt: iso(expiresAt),
        },
        environment.scope.environmentId,
      );
    });
    return this.get(caller, id);
  }

  /** Removing a DENY widens access, so it needs the same authority as an ALLOW. */
  async removeGrant(
    caller: ProjectCaller,
    id: string,
    grantId: string,
  ): Promise<MachineIdentitySummary> {
    const repos = this.repos;
    const grant = await repos.machineIdentities.findGrant(caller.project.scope, id, grantId);
    if (!grant) throw notFound();
    const environment = await this.access.environment(caller, grant.environmentId);
    if (!environment?.permissions.has('access_policy:manage')) {
      throw fail(
        HttpStatus.FORBIDDEN,
        AUTH_ERROR_CODES.FORBIDDEN,
        'You cannot manage access to this environment',
      );
    }
    if (environment.isProtected && !environment.permissions.has('environment:protect')) {
      throw fail(
        HttpStatus.FORBIDDEN,
        PROJECT_ERROR_CODES.PROTECTION_REQUIRED,
        'Changing access to a protected environment needs environment:protect',
      );
    }
    if (grant.effect === 'DENY') {
      const role = await repos.roles.findScopedRole(
        workspaceScopeOf(caller.project.scope),
        'ENVIRONMENT',
        grant.role.key,
      );
      const missing = (role?.permissions ?? []).filter((p) => !environment.permissions.has(p));
      if (missing.length > 0) {
        throw fail(
          HttpStatus.FORBIDDEN,
          MACHINE_ERROR_CODES.GRANT_EXCEEDS_AUTHORITY,
          `Lifting this DENY needs what it denies (missing ${missing.sort().join(', ')})`,
        );
      }
      await this.requireStepUp(caller);
    }
    await this.limiter.consume({ userId: caller.principal.userId, action: 'access-change' });
    await withTransaction(this.database.client, async (tx) => {
      const txRepos = createRepositories(tx);
      if (await txRepos.machineIdentities.removeGrant(caller.project.scope, id, grantId)) {
        await this.audit(
          txRepos,
          caller,
          id,
          'machine_identity.grant_removed',
          { grantId, role: grant.role.key, effect: grant.effect },
          grant.environmentId,
        );
      }
    });
    return this.get(caller, id);
  }

  /* -------------------------------------------------------------- activity */

  async activity(
    caller: ProjectCaller,
    id: string,
    query: { cursor?: string | undefined; limit: number },
  ): Promise<MachineActivityPage> {
    const repos = this.repos;
    const identity = await repos.machineIdentities.get(caller.project.scope, id);
    if (!identity) throw notFound();
    const cursor = query.cursor ? decodeActivityCursor(query.cursor) : null;
    if (query.cursor && !cursor) throw invalid('Invalid cursor');
    const page = await repos.machineIdentities.activity(caller.project.scope, id, {
      cursor: cursor ?? undefined,
      limit: query.limit,
    });
    return {
      items: page.items.map((e) => ({
        id: e.id,
        action: e.action,
        outcome: e.outcome,
        occurredAt: e.occurredAt.toISOString(),
        actor:
          e.actorType === 'SERVICE_IDENTITY'
            ? { kind: 'machine' as const, name: identity.name }
            : e.user
              ? { kind: 'user' as const, email: e.user.email, displayName: e.user.displayName }
              : { kind: 'system' as const },
        environmentId: e.environmentId,
        metadata:
          typeof e.metadata === 'object' && e.metadata !== null && !Array.isArray(e.metadata)
            ? (e.metadata as Record<string, unknown>)
            : {},
      })),
      nextCursor: page.next ? encodeActivityCursor(page.next) : null,
    };
  }
}
