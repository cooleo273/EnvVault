import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  createRepositories,
  type MachineEnvironmentGrants,
  type MachineIdentityRecord,
  type OidcBindingRecord,
  type OidcPolicyPatch,
  type Repositories,
  withTransaction,
} from '@envvault/database';
import {
  type createOidcTrustBindingInputSchema,
  evaluateMachinePermissions,
  GITHUB_OIDC_ISSUER,
  MACHINE_ERROR_CODES,
  type OidcBindingAttemptList,
  OIDC_ERROR_CODES,
  OIDC_LIMITS,
  type OidcTrustBinding,
  type OidcTrustBindingList,
  type oidcTrustBindingQuerySchema,
  protectedPolicyProblems,
  type updateOidcTrustBindingInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  EnvironmentAccessService,
  type ProjectCaller,
} from '../intelligence/environment-access.service.js';
import { SensitiveRateLimiter } from '../rate-limit/sensitive-rate-limiter.js';
import { OIDC_VERIFIER, type OidcVerifier } from './oidc-verifier.provider.js';

type Out<T extends z.ZodType> = z.output<T>;
const DAY_MS = 86_400_000;

const fail = (status: HttpStatus, code: string, message: string) =>
  new ApiException(status, code, message);
const notFound = () => fail(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
const invalid = (message: string) =>
  fail(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', message);
const iso = (d: Date | null) => d?.toISOString() ?? null;
const text = (value: unknown) => (typeof value === 'string' ? value : null);

type Conditions = Required<OidcPolicyPatch>;

/**
 * GitHub Actions trust bindings, managed by people with
 * `service_identity:manage` on the project: a binding lets matching workflows
 * authenticate as a machine identity, the same power as issuing it a
 * credential, so the same rules apply. Nobody can bind environments the
 * identity has no grant on, or that would reach more than they hold
 * themselves; protected environments need a strict binding.
 */
@Injectable()
export class OidcBindingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: EnvironmentAccessService,
    private readonly limiter: SensitiveRateLimiter,
    @Inject(OIDC_VERIFIER) private readonly verifier: OidcVerifier,
  ) {}

  private get repos(): Repositories {
    return createRepositories(this.database.client);
  }

  private status(b: OidcBindingRecord, now: Date): OidcTrustBinding['status'] {
    if (b.revokedAt) return 'REVOKED';
    if (b.disabledAt) return 'DISABLED';
    if (b.expiresAt <= now) return 'EXPIRED';
    return 'ACTIVE';
  }

  private present(
    b: OidcBindingRecord,
    environments: Map<string, MachineEnvironmentGrants['environment']>,
    now: Date,
  ): OidcTrustBinding {
    return {
      id: b.id,
      name: b.name,
      provider: 'github',
      identity: b.identity,
      issuer: b.issuer,
      audience: b.audience,
      scopes: b.scopes as OidcTrustBinding['scopes'],
      repository: { id: b.repositoryId, ownerId: b.repositoryOwnerId, name: b.repositoryName },
      workflowPath: b.workflowPath,
      jobWorkflowRef: b.jobWorkflowRef,
      refs: b.refs,
      githubEnvironments: b.githubEnvironments,
      eventNames: b.eventNames,
      subject: b.subject,
      environments: b.environmentIds.flatMap((id) => {
        const e = environments.get(id);
        return e ? [{ id: e.id, name: e.name, slug: e.slug, isProtected: e.isProtected }] : [];
      }),
      status: this.status(b, now),
      expiresAt: b.expiresAt.toISOString(),
      createdAt: b.createdAt.toISOString(),
      createdBy: b.createdBy,
      updatedAt: b.updatedAt.toISOString(),
      updatedBy: b.updatedBy,
      disabledAt: iso(b.disabledAt),
      lastUsedAt: iso(b.lastUsedAt),
      revokedAt: iso(b.revokedAt),
    };
  }

  private async environmentsOf(caller: ProjectCaller, identityId: string) {
    const rows = await this.repos.machineIdentities.environmentsWithGrants(
      caller.project.scope.workspaceId,
      caller.project.scope.projectId,
      identityId,
    );
    return new Map(rows.map((r) => [r.environment.id, r.environment]));
  }

  private async presentAll(
    caller: ProjectCaller,
    bindings: OidcBindingRecord[],
  ): Promise<OidcTrustBinding[]> {
    const now = new Date();
    const byIdentity = new Map<string, Map<string, MachineEnvironmentGrants['environment']>>();
    for (const identityId of new Set(bindings.map((b) => b.identity.id))) {
      byIdentity.set(identityId, await this.environmentsOf(caller, identityId));
    }
    const none = new Map<string, MachineEnvironmentGrants['environment']>();
    return bindings.map((b) => this.present(b, byIdentity.get(b.identity.id) ?? none, now));
  }

  async list(
    caller: ProjectCaller,
    query: Out<typeof oidcTrustBindingQuerySchema>,
  ): Promise<OidcTrustBindingList> {
    const rows = await this.repos.oidcTrust.list(caller.project.scope, {
      identityId: query.identityId,
      includeRevoked: query.includeRevoked === true,
    });
    return { items: await this.presentAll(caller, rows), issuers: [...this.verifier.issuers] };
  }

  async get(caller: ProjectCaller, id: string): Promise<OidcTrustBinding> {
    const row = await this.repos.oidcTrust.get(caller.project.scope, id);
    if (!row) throw notFound();
    const [binding] = await this.presentAll(caller, [row]);
    if (!binding) throw notFound();
    return binding;
  }

  private async liveBinding(caller: ProjectCaller, id: string): Promise<OidcBindingRecord> {
    const row = await this.repos.oidcTrust.get(caller.project.scope, id);
    if (!row || row.revokedAt) throw notFound();
    return row;
  }

  private async usableIdentity(caller: ProjectCaller, id: string, now: Date) {
    const identity = await this.repos.machineIdentities.get(caller.project.scope, id, now);
    if (!identity || identity.retiredAt) throw notFound();
    if (identity.status === 'DISABLED') {
      throw fail(
        HttpStatus.CONFLICT,
        MACHINE_ERROR_CODES.IDENTITY_DISABLED,
        'Enable the identity first',
      );
    }
    if (identity.expiresAt && identity.expiresAt <= now) {
      throw fail(
        HttpStatus.CONFLICT,
        MACHINE_ERROR_CODES.IDENTITY_EXPIRED,
        'This identity has expired',
      );
    }
    return identity;
  }

  /**
   * Every bound environment must be one the identity is granted, the caller
   * must hold there what the binding's scopes would unlock, and protected ones
   * need strict conditions.
   */
  private async assertBindable(
    caller: ProjectCaller,
    identity: MachineIdentityRecord,
    scopes: readonly string[],
    conditions: Conditions,
  ): Promise<void> {
    const grantsByEnvironment = new Map<string, MachineIdentityRecord['grants']>();
    for (const grant of identity.grants) {
      grantsByEnvironment.set(grant.environment.id, [
        ...(grantsByEnvironment.get(grant.environment.id) ?? []),
        grant,
      ]);
    }
    const missing: string[] = [];
    let protectedReached = false;
    for (const environmentId of conditions.environmentIds) {
      const grants = grantsByEnvironment.get(environmentId.toLowerCase()) ?? [];
      const [first] = grants;
      if (!first) throw invalid('Grant the machine identity each environment before binding it');
      const environment = first.environment;
      protectedReached ||= environment.isProtected;
      const reached = evaluateMachinePermissions({
        grants: grants.map((g) => ({
          effect: g.effect,
          expiresAt: g.expiresAt,
          permissions: g.role.permissions,
        })),
        scopes,
      });
      const own = await this.access.environment(caller, environmentId);
      const lacking = [...reached].filter((p) => !own?.permissions.has(p)).sort();
      if (lacking.length > 0) missing.push(`${environment.name}: ${lacking.join(', ')}`);
    }
    if (missing.length > 0) {
      throw fail(
        HttpStatus.FORBIDDEN,
        MACHINE_ERROR_CODES.GRANT_EXCEEDS_AUTHORITY,
        `This binding would reach more than you can yourself (${missing.join('; ')}).`,
      );
    }
    if (protectedReached) {
      const problems = protectedPolicyProblems(conditions);
      if (problems.length > 0) {
        throw fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          OIDC_ERROR_CODES.OIDC_PROTECTED_POLICY_REQUIRED,
          `A protected environment needs a stricter binding: ${problems.join('; ')}.`,
        );
      }
    }
  }

  private async audit(
    repos: Repositories,
    caller: ProjectCaller,
    identityId: string,
    action: string,
    metadata: Record<string, string | number | boolean | string[] | null>,
  ): Promise<void> {
    await repos.audit.append({
      workspaceId: caller.project.scope.workspaceId,
      projectId: caller.project.scope.projectId,
      actorUserId: caller.principal.userId,
      action,
      outcome: 'SUCCESS',
      resourceType: 'service_identity',
      resourceId: identityId,
      requestId: caller.requestId,
      metadata,
    });
  }

  private summaryOf(conditions: Conditions): Record<string, string | string[] | null> {
    return {
      repositoryName: conditions.repositoryName,
      workflowPath: conditions.workflowPath,
      jobWorkflowRef: conditions.jobWorkflowRef,
      refs: conditions.refs,
      githubEnvironments: conditions.githubEnvironments,
      eventNames: conditions.eventNames,
      subject: conditions.subject,
      environmentIds: conditions.environmentIds,
    };
  }

  async create(
    caller: ProjectCaller,
    input: Out<typeof createOidcTrustBindingInputSchema>,
  ): Promise<OidcTrustBinding> {
    const now = new Date();
    const issuer = input.issuer?.replace(/\/+$/, '') ?? GITHUB_OIDC_ISSUER;
    if (!this.verifier.issuers.includes(issuer)) {
      throw fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        OIDC_ERROR_CODES.OIDC_ISSUER_NOT_TRUSTED,
        'This EnvVault API does not trust that issuer (OIDC_TRUSTED_ISSUERS)',
      );
    }
    const identity = await this.usableIdentity(caller, input.identityId, now);
    const conditions: Conditions = {
      repositoryName: input.repositoryName,
      workflowPath: input.workflowPath ?? null,
      jobWorkflowRef: input.jobWorkflowRef ?? null,
      refs: input.refs ?? [],
      githubEnvironments: input.githubEnvironments ?? [],
      eventNames: input.eventNames ?? [],
      subject: input.subject ?? null,
      environmentIds: input.environmentIds.map((id) => id.toLowerCase()),
    };
    await this.assertBindable(caller, identity, input.scopes, conditions);
    const end = new Date(now.getTime() + input.expiresInDays * DAY_MS);
    const expiresAt = identity.expiresAt && identity.expiresAt < end ? identity.expiresAt : end;
    await this.limiter.consume({ userId: caller.principal.userId, action: 'credential-issue' });

    const id = await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (
        (await repos.oidcTrust.countLive(identity.id, now)) >= OIDC_LIMITS.maxBindingsPerIdentity
      ) {
        throw fail(
          HttpStatus.CONFLICT,
          OIDC_ERROR_CODES.OIDC_BINDING_LIMIT_REACHED,
          `An identity can have at most ${String(OIDC_LIMITS.maxBindingsPerIdentity)} trust bindings`,
        );
      }
      const created = await repos.oidcTrust.create({
        workspaceId: caller.project.scope.workspaceId,
        projectId: caller.project.scope.projectId,
        serviceIdentityId: identity.id,
        name: input.name,
        issuer,
        audience: input.audience,
        scopes: [...input.scopes].sort(),
        expiresAt,
        createdById: caller.principal.userId,
        repositoryId: input.repositoryId,
        repositoryOwnerId: input.repositoryOwnerId,
        ...conditions,
      });
      await this.audit(repos, caller, identity.id, 'oidc_trust_binding.created', {
        credentialId: created,
        name: input.name,
        issuer,
        audience: input.audience,
        repositoryId: input.repositoryId,
        repositoryOwnerId: input.repositoryOwnerId,
        scopes: [...input.scopes].sort(),
        expiresAt: expiresAt.toISOString(),
        ...this.summaryOf(conditions),
      });
      return created;
    });
    return this.get(caller, id);
  }

  async update(
    caller: ProjectCaller,
    id: string,
    input: Out<typeof updateOidcTrustBindingInputSchema>,
  ): Promise<OidcTrustBinding> {
    const now = new Date();
    const current = await this.liveBinding(caller, id);
    const identity = await this.usableIdentity(caller, current.identity.id, now);
    const conditions: Conditions = {
      repositoryName: input.repositoryName ?? current.repositoryName,
      workflowPath: input.workflowPath === undefined ? current.workflowPath : input.workflowPath,
      jobWorkflowRef:
        input.jobWorkflowRef === undefined ? current.jobWorkflowRef : input.jobWorkflowRef,
      refs: input.refs ?? current.refs,
      githubEnvironments: input.githubEnvironments ?? current.githubEnvironments,
      eventNames: input.eventNames ?? current.eventNames,
      subject: input.subject === undefined ? current.subject : input.subject,
      environmentIds: (input.environmentIds ?? current.environmentIds).map((e) => e.toLowerCase()),
    };
    await this.assertBindable(caller, identity, current.scopes, conditions);
    const fields = Object.keys(input).sort();
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const changed = await repos.oidcTrust.update(
        caller.project.scope,
        id,
        { ...conditions, ...(input.name !== undefined ? { name: input.name } : {}) },
        caller.principal.userId,
      );
      if (!changed) throw notFound();
      // Tokens issued under the old conditions stop now; jobs exchange again.
      await repos.oidcTrust.revokeTokens(id, now);
      await this.audit(repos, caller, identity.id, 'oidc_trust_binding.updated', {
        credentialId: id,
        fields,
        ...this.summaryOf(conditions),
      });
    });
    return this.get(caller, id);
  }

  async disable(caller: ProjectCaller, id: string): Promise<OidcTrustBinding> {
    const now = new Date();
    const current = await this.liveBinding(caller, id);
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (
        await repos.oidcTrust.setDisabled(caller.project.scope, id, caller.principal.userId, now)
      ) {
        await this.audit(repos, caller, current.identity.id, 'oidc_trust_binding.disabled', {
          credentialId: id,
        });
      }
    });
    return this.get(caller, id);
  }

  /** Enabling widens access again, so it is checked like a new binding. */
  async enable(caller: ProjectCaller, id: string): Promise<OidcTrustBinding> {
    const now = new Date();
    const current = await this.liveBinding(caller, id);
    const identity = await this.usableIdentity(caller, current.identity.id, now);
    await this.assertBindable(caller, identity, current.scopes, {
      repositoryName: current.repositoryName,
      workflowPath: current.workflowPath,
      jobWorkflowRef: current.jobWorkflowRef,
      refs: current.refs,
      githubEnvironments: current.githubEnvironments,
      eventNames: current.eventNames,
      subject: current.subject,
      environmentIds: current.environmentIds,
    });
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (await repos.oidcTrust.setDisabled(caller.project.scope, id, null, now)) {
        await this.audit(repos, caller, current.identity.id, 'oidc_trust_binding.enabled', {
          credentialId: id,
        });
      }
    });
    return this.get(caller, id);
  }

  /** Revoked, not deleted: tokens and audit history reference it. Its tokens stop at once. */
  async remove(caller: ProjectCaller, id: string): Promise<void> {
    const now = new Date();
    const current = await this.liveBinding(caller, id);
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      const revoked = await repos.machineIdentities.revokeCredential(
        caller.project.scope,
        current.identity.id,
        id,
        caller.principal.userId,
        'Trust binding deleted',
        now,
      );
      if (revoked) {
        await this.audit(repos, caller, current.identity.id, 'oidc_trust_binding.deleted', {
          credentialId: id,
          name: current.name,
          repositoryId: current.repositoryId,
        });
      }
    });
  }

  async attempts(caller: ProjectCaller, id: string): Promise<OidcBindingAttemptList> {
    const row = await this.repos.oidcTrust.get(caller.project.scope, id);
    if (!row) throw notFound();
    const events = await this.repos.oidcTrust.attempts(caller.project.scope, id, 25);
    return {
      items: events.map((e) => {
        const m = (e.metadata ?? {}) as Record<string, unknown>;
        return {
          id: e.id,
          outcome: e.outcome,
          occurredAt: e.occurredAt.toISOString(),
          reason: text(m.reason),
          repository: text(m.repository),
          ref: text(m.ref),
          eventName: text(m.eventName),
          workflowRef: text(m.workflowRef),
          githubEnvironment: text(m.githubEnvironment),
          runId: text(m.runId),
          runAttempt: text(m.runAttempt),
        };
      }),
    };
  }
}
