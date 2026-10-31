import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { SECRET_ENVELOPE_ALGORITHM, type SecretEnvelope } from '@envvault/crypto';
import {
  createRepositories,
  getConstraintViolation,
  type IntegrationConnectionRecord,
  type MappingRecord,
  type Repositories,
  type StoredCredential,
  withTransaction,
  workspaceScopeOf,
  type ProjectScope,
} from '@envvault/database';
import {
  type createMappingInputSchema,
  type createVercelConnectionInputSchema,
  type CustomEnvironmentList,
  INTEGRATION_ERROR_CODES,
  INTEGRATION_LIMITS,
  type IntegrationConnection,
  type IntegrationList,
  type IntegrationMapping,
  type ProviderProjectList,
} from '@envvault/shared';
import type { z } from 'zod';
import { ApiException } from '../common/api-exception.js';
import { uuidV7 } from '../common/uuid-v7.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { SecretEncryptionService } from '../encryption/secret-encryption.service.js';
import {
  EnvironmentAccessService,
  type ProjectCaller,
} from '../intelligence/environment-access.service.js';
import { SensitiveRateLimiter } from '../rate-limit/sensitive-rate-limiter.js';
import { cryptoFailure } from '../secrets/secret-vault.service.js';
import { ProviderError, VercelClient } from './vercel-client.js';

type Out<T extends z.ZodType> = z.output<T>;

const fail = (
  status: HttpStatus,
  code: string,
  message: string,
  headers?: Record<string, string>,
) => new ApiException(status, code, message, headers);
const notFound = () => fail(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Provider failures as EnvVault errors: a code and a fixed message, never the provider's body. */
export function providerFailure(error: unknown): ApiException {
  if (!(error instanceof ProviderError)) throw error;
  switch (error.code) {
    case INTEGRATION_ERROR_CODES.PROVIDER_AUTH_FAILED:
      return fail(
        HttpStatus.BAD_GATEWAY,
        error.code,
        'Vercel refused the access token. Replace it with a valid one.',
      );
    case INTEGRATION_ERROR_CODES.PROVIDER_FORBIDDEN:
      return fail(
        HttpStatus.BAD_GATEWAY,
        error.code,
        'The access token cannot reach this Vercel team or project.',
      );
    case INTEGRATION_ERROR_CODES.PROVIDER_NOT_FOUND:
      return fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        error.code,
        'Vercel has no such team or project.',
      );
    case INTEGRATION_ERROR_CODES.PROVIDER_RATE_LIMITED:
      return fail(
        HttpStatus.SERVICE_UNAVAILABLE,
        error.code,
        'Vercel is rate limiting requests. Try again later.',
        { 'Retry-After': String(error.retryAfterSeconds ?? 60) },
      );
    case INTEGRATION_ERROR_CODES.PROVIDER_UNAVAILABLE:
      return fail(
        HttpStatus.SERVICE_UNAVAILABLE,
        error.code,
        'Vercel did not answer. Try again shortly.',
        { 'Retry-After': '30' },
      );
    default:
      return fail(HttpStatus.BAD_GATEWAY, error.code, 'Vercel rejected the request.');
  }
}

export type VercelClientFactory = (token: string, teamId: string | null) => VercelClient;
export const VERCEL_CLIENT_FACTORY = Symbol('VERCEL_CLIENT_FACTORY');

export const vercelClientFactoryProvider = {
  provide: VERCEL_CLIENT_FACTORY,
  inject: [APP_ENV],
  useFactory:
    (env: Env): VercelClientFactory =>
    (token, teamId) =>
      new VercelClient({ baseUrl: env.VERCEL_API_URL, token, teamId }),
};

interface VercelConfig {
  account: { id: string; name: string; type: 'team' | 'user' };
  teamId: string | null;
  project: { id: string; name: string } | null;
}

export function configOf(connection: IntegrationConnectionRecord): VercelConfig {
  const c = connection.config as Partial<VercelConfig>;
  return {
    account: c.account ?? { id: connection.externalAccountId ?? '', name: '', type: 'user' },
    teamId: c.teamId ?? null,
    project: c.project ?? null,
  };
}

/**
 * Vercel connections of a project: the access token (envelope encrypted under
 * the workspace keyring, never returned), the linked Vercel project, and the
 * mappings of EnvVault environments to Vercel targets. Managing them needs
 * `integration:manage`; nothing here reads or writes variable values.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly encryption: SecretEncryptionService,
    private readonly access: EnvironmentAccessService,
    private readonly limiter: SensitiveRateLimiter,
    @Inject(VERCEL_CLIENT_FACTORY) private readonly clients: VercelClientFactory,
  ) {}

  private get repos(): Repositories {
    return createRepositories(this.database.client);
  }

  present(c: IntegrationConnectionRecord): IntegrationConnection {
    const config = configOf(c);
    return {
      id: c.id,
      provider: 'vercel',
      name: c.name,
      status: c.disconnectedAt ? 'DISCONNECTED' : c.status,
      account: config.account,
      linkedProject: config.project,
      hasCredential: c.hasCredential,
      lastCheckedAt: iso(c.lastCheckedAt),
      lastErrorCode: c.lastErrorCode,
      lastSyncedAt: iso(c.lastSyncedAt),
      createdAt: c.createdAt.toISOString(),
      createdBy: c.createdBy,
    };
  }

  private async audit(
    repos: Repositories,
    caller: ProjectCaller,
    connectionId: string,
    action: string,
    metadata: Record<string, string | number | boolean | null>,
    outcome: 'SUCCESS' | 'DENIED' | 'FAILURE' = 'SUCCESS',
  ): Promise<void> {
    await repos.audit.append({
      workspaceId: caller.project.scope.workspaceId,
      projectId: caller.project.scope.projectId,
      actorUserId: caller.principal.userId,
      action,
      outcome,
      resourceType: 'integration',
      resourceId: connectionId,
      requestId: caller.requestId,
      metadata,
    });
  }

  /* -------------------------------------------------------------- credential */

  private async seal(
    scope: ProjectScope,
    connectionId: string,
    token: string,
  ): Promise<StoredCredential> {
    let envelope: SecretEnvelope;
    try {
      envelope = await this.encryption.encryptCredential(token, {
        workspaceId: scope.workspaceId.toLowerCase(),
        connectionId: connectionId.toLowerCase(),
      });
    } catch (error) {
      throw cryptoFailure(error);
    }
    const workspace = workspaceScopeOf(scope);
    const found = await this.repos.encryptionKeys.find(
      workspace,
      envelope.providerId,
      envelope.keyId,
    );
    const key =
      found ??
      (await withTransaction(this.database.client, (tx) =>
        createRepositories(tx).encryptionKeys.ensureActive(
          workspace,
          envelope.providerId,
          envelope.keyId,
        ),
      ));
    return {
      ciphertext: envelope.ciphertext,
      iv: envelope.nonce,
      authTag: envelope.tag,
      encryptedDataKey: envelope.wrappedKey,
      envelopeVersion: envelope.formatVersion,
      kmsKeyVersion: envelope.keyVersion,
      encryptionKeyId: key.id,
      kmsProvider: envelope.providerId,
      kmsKeyRef: envelope.keyId,
    };
  }

  /** A client for a usable connection. The decrypted token lives only inside it. */
  async client(
    scope: ProjectScope,
    connection: IntegrationConnectionRecord,
  ): Promise<VercelClient> {
    if (connection.disconnectedAt || connection.status === 'DISABLED') {
      throw fail(
        HttpStatus.CONFLICT,
        INTEGRATION_ERROR_CODES.INTEGRATION_DISABLED,
        'This integration is disabled',
      );
    }
    const stored = await this.repos.integrations.credential(scope, connection.id);
    if (!stored) {
      throw fail(
        HttpStatus.CONFLICT,
        INTEGRATION_ERROR_CODES.INTEGRATION_DISABLED,
        'This integration has no credential',
      );
    }
    let token: string;
    try {
      token = await this.encryption.decryptCredential(
        {
          formatVersion: stored.envelopeVersion,
          algorithm: SECRET_ENVELOPE_ALGORITHM,
          providerId: stored.kmsProvider,
          keyId: stored.kmsKeyRef,
          keyVersion: stored.kmsKeyVersion,
          wrappedKey: stored.encryptedDataKey,
          nonce: stored.iv,
          ciphertext: stored.ciphertext,
          tag: stored.authTag,
        },
        {
          workspaceId: scope.workspaceId.toLowerCase(),
          connectionId: connection.id.toLowerCase(),
        },
      );
    } catch (error) {
      throw cryptoFailure(error);
    }
    return this.clients(token, configOf(connection).teamId);
  }

  async connection(caller: ProjectCaller, id: string): Promise<IntegrationConnectionRecord> {
    const found = await this.repos.integrations.getConnection(caller.project.scope, id);
    if (!found) throw notFound();
    return found;
  }

  /** Records a provider failure on the connection (health) and rethrows it as an API error. */
  async providerError(caller: ProjectCaller, id: string, error: unknown): Promise<never> {
    if (error instanceof ProviderError) {
      const lasting =
        error.code === INTEGRATION_ERROR_CODES.PROVIDER_AUTH_FAILED ||
        error.code === INTEGRATION_ERROR_CODES.PROVIDER_FORBIDDEN;
      await this.repos.integrations.updateConnection(caller.project.scope, id, {
        lastCheckedAt: new Date(),
        lastErrorCode: error.code,
        ...(lasting ? { status: 'ERROR' as const } : {}),
      });
    }
    throw providerFailure(error);
  }

  /* ------------------------------------------------------------- connections */

  async list(caller: ProjectCaller): Promise<IntegrationList> {
    const rows = await this.repos.integrations.listConnections(caller.project.scope);
    return { items: rows.map((r) => this.present(r)) };
  }

  async get(caller: ProjectCaller, id: string): Promise<IntegrationConnection> {
    return this.present(await this.connection(caller, id));
  }

  async connectVercel(
    caller: ProjectCaller,
    input: Out<typeof createVercelConnectionInputSchema>,
  ): Promise<IntegrationConnection> {
    const scope = caller.project.scope;
    await this.limiter.consume({ userId: caller.principal.userId, action: 'integration-change' });
    if (
      (await this.repos.integrations.countConnections(scope)) >=
      INTEGRATION_LIMITS.maxConnectionsPerProject
    ) {
      throw fail(
        HttpStatus.CONFLICT,
        INTEGRATION_ERROR_CODES.INTEGRATION_LIMIT_REACHED,
        `A project can have at most ${String(INTEGRATION_LIMITS.maxConnectionsPerProject)} integrations`,
      );
    }
    const teamId = input.teamId ?? null;
    let account;
    try {
      account = await this.clients(input.token, teamId).account();
    } catch (error) {
      throw providerFailure(error);
    }
    const id = uuidV7();
    const credential = await this.seal(scope, id, input.token);
    const now = new Date();
    try {
      await withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        await repos.integrations.createConnection(scope, {
          id,
          name: input.name,
          externalAccountId: account.id,
          config: { account, teamId, project: null },
          credential,
          createdById: caller.principal.userId,
          checkedAt: now,
        });
        await this.audit(repos, caller, id, 'integration.connected', {
          provider: 'vercel',
          name: input.name,
          accountId: account.id,
          accountType: account.type,
        });
      });
    } catch (error) {
      if (
        getConstraintViolation(error)?.constraint ===
        'integration_connections_workspace_id_provider_name_key'
      ) {
        throw fail(
          HttpStatus.CONFLICT,
          INTEGRATION_ERROR_CODES.CONNECTION_NAME_TAKEN,
          'An integration with this name exists in this workspace',
        );
      }
      throw error;
    }
    return this.get(caller, id);
  }

  async replaceToken(
    caller: ProjectCaller,
    id: string,
    token: string,
  ): Promise<IntegrationConnection> {
    const connection = await this.connection(caller, id);
    if (connection.disconnectedAt) throw notFound();
    await this.limiter.consume({ userId: caller.principal.userId, action: 'integration-change' });
    const config = configOf(connection);
    let account;
    try {
      account = await this.clients(token, config.teamId).account();
    } catch (error) {
      throw providerFailure(error);
    }
    if (account.id !== config.account.id) {
      throw fail(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'VALIDATION_FAILED',
        'The new token belongs to another Vercel account. Create a separate integration for it.',
      );
    }
    const credential = await this.seal(caller.project.scope, id, token);
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      await repos.integrations.replaceCredential(caller.project.scope, id, credential, new Date());
      await this.audit(repos, caller, id, 'integration.credential_replaced', {
        provider: 'vercel',
      });
    });
    return this.get(caller, id);
  }

  /** Checks the stored token against Vercel and records the result. */
  async check(caller: ProjectCaller, id: string): Promise<IntegrationConnection> {
    const connection = await this.connection(caller, id);
    const client = await this.client(caller.project.scope, connection);
    try {
      await client.account();
      if (configOf(connection).project)
        await client.project(configOf(connection).project?.id ?? '');
    } catch (error) {
      return this.providerError(caller, id, error);
    }
    await this.repos.integrations.updateConnection(caller.project.scope, id, {
      status: 'ACTIVE',
      lastCheckedAt: new Date(),
      lastErrorCode: null,
    });
    return this.get(caller, id);
  }

  async setEnabled(
    caller: ProjectCaller,
    id: string,
    enabled: boolean,
  ): Promise<IntegrationConnection> {
    const connection = await this.connection(caller, id);
    if (connection.disconnectedAt) throw notFound();
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      await repos.integrations.updateConnection(caller.project.scope, id, {
        status: enabled ? 'ACTIVE' : 'DISABLED',
      });
      await this.audit(
        repos,
        caller,
        id,
        enabled ? 'integration.enabled' : 'integration.disabled',
        { provider: 'vercel' },
      );
    });
    return this.get(caller, id);
  }

  /** Erases the token and mappings. Variables already written to Vercel stay there. */
  async disconnect(caller: ProjectCaller, id: string): Promise<void> {
    await this.connection(caller, id);
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (await repos.integrations.disconnect(caller.project.scope, id, new Date())) {
        await this.audit(repos, caller, id, 'integration.disconnected', { provider: 'vercel' });
      }
    });
  }

  /* ---------------------------------------------------------------- linking */

  async providerProjects(
    caller: ProjectCaller,
    id: string,
    search?: string,
  ): Promise<ProviderProjectList> {
    const connection = await this.connection(caller, id);
    const client = await this.client(caller.project.scope, connection);
    try {
      return {
        items: (await client.projects(search)).slice(0, INTEGRATION_LIMITS.maxProviderProjects),
      };
    } catch (error) {
      return this.providerError(caller, id, error);
    }
  }

  async link(caller: ProjectCaller, id: string, projectId: string): Promise<IntegrationConnection> {
    const connection = await this.connection(caller, id);
    const config = configOf(connection);
    if (config.project?.id === projectId) return this.present(connection);
    if ((await this.repos.integrations.countMappings(id)) > 0) {
      throw fail(
        HttpStatus.CONFLICT,
        'CONFLICT',
        'Remove the environment mappings before linking another Vercel project',
      );
    }
    const client = await this.client(caller.project.scope, connection);
    let project;
    try {
      project = await client.project(projectId);
    } catch (error) {
      return this.providerError(caller, id, error);
    }
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      await repos.integrations.updateConnection(caller.project.scope, id, {
        config: { ...config, project: { id: project.id, name: project.name } },
        lastCheckedAt: new Date(),
        lastErrorCode: null,
      });
      await this.audit(repos, caller, id, 'integration.project_linked', {
        provider: 'vercel',
        vercelProjectId: project.id,
        vercelProjectName: project.name,
      });
    });
    return this.get(caller, id);
  }

  linkedProject(connection: IntegrationConnectionRecord): { id: string; name: string } {
    const project = configOf(connection).project;
    if (!project) {
      throw fail(
        HttpStatus.CONFLICT,
        INTEGRATION_ERROR_CODES.INTEGRATION_NOT_LINKED,
        'Link a Vercel project first',
      );
    }
    return project;
  }

  async customEnvironments(caller: ProjectCaller, id: string): Promise<CustomEnvironmentList> {
    const connection = await this.connection(caller, id);
    const project = this.linkedProject(connection);
    const client = await this.client(caller.project.scope, connection);
    try {
      return { items: await client.customEnvironments(project.id) };
    } catch (error) {
      return this.providerError(caller, id, error);
    }
  }

  /* --------------------------------------------------------------- mappings */

  presentMapping(m: MappingRecord): IntegrationMapping {
    return {
      id: m.id,
      environment: {
        id: m.environment.id,
        name: m.environment.name,
        isProtected: m.environment.isProtected,
      },
      target: m.target,
      gitBranch: m.gitBranch,
      customEnvironment: m.customEnvironmentId
        ? { id: m.customEnvironmentId, slug: m.customEnvironmentSlug }
        : null,
      managedVariables: m.managedVariables,
      lastSyncedAt: iso(m.lastSyncedAt),
      createdAt: m.createdAt.toISOString(),
    };
  }

  async mappings(caller: ProjectCaller, id: string): Promise<{ items: IntegrationMapping[] }> {
    await this.connection(caller, id);
    const rows = await this.repos.integrations.listMappings(caller.project.scope, id);
    return {
      items: rows.filter((m) => !m.environment.deletedAt).map((m) => this.presentMapping(m)),
    };
  }

  async createMapping(
    caller: ProjectCaller,
    id: string,
    input: Out<typeof createMappingInputSchema>,
  ): Promise<IntegrationMapping> {
    const connection = await this.connection(caller, id);
    const project = this.linkedProject(connection);
    const environment = await this.access.environment(caller, input.environmentId);
    if (!environment) throw notFound();
    if (
      (await this.repos.integrations.countMappings(id)) >=
      INTEGRATION_LIMITS.maxMappingsPerConnection
    ) {
      throw fail(
        HttpStatus.CONFLICT,
        INTEGRATION_ERROR_CODES.INTEGRATION_LIMIT_REACHED,
        `An integration can have at most ${String(INTEGRATION_LIMITS.maxMappingsPerConnection)} mappings`,
      );
    }
    let customSlug: string | null = null;
    if (input.target === 'CUSTOM') {
      const client = await this.client(caller.project.scope, connection);
      let custom;
      try {
        custom = (await client.customEnvironments(project.id)).find(
          (e) => e.id === input.customEnvironmentId,
        );
      } catch (error) {
        return this.providerError(caller, id, error);
      }
      if (!custom) {
        throw fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          INTEGRATION_ERROR_CODES.PROVIDER_NOT_FOUND,
          'Vercel has no such custom environment',
        );
      }
      customSlug = custom.slug;
    }
    let mappingId: string;
    try {
      mappingId = await withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        const created = await repos.integrations.createMapping(caller.project.scope, {
          connectionId: id,
          environmentId: environment.scope.environmentId,
          target: input.target,
          gitBranch: input.gitBranch ?? null,
          customEnvironmentId: input.customEnvironmentId ?? null,
          customEnvironmentSlug: customSlug,
          createdById: caller.principal.userId,
        });
        await this.audit(repos, caller, id, 'integration.mapping_created', {
          mappingId: created,
          environmentId: environment.scope.environmentId,
          target: input.target,
          gitBranch: input.gitBranch ?? null,
          customEnvironmentId: input.customEnvironmentId ?? null,
          protected: environment.isProtected,
        });
        return created;
      });
    } catch (error) {
      if (getConstraintViolation(error)?.constraint === 'integration_mappings_target_key') {
        throw fail(
          HttpStatus.CONFLICT,
          INTEGRATION_ERROR_CODES.MAPPING_EXISTS,
          'This Vercel target is already mapped',
        );
      }
      throw error;
    }
    const created = await this.repos.integrations.getMapping(caller.project.scope, id, mappingId);
    if (!created) throw notFound();
    return this.presentMapping(created);
  }

  async deleteMapping(caller: ProjectCaller, id: string, mappingId: string): Promise<void> {
    await this.connection(caller, id);
    await withTransaction(this.database.client, async (tx) => {
      const repos = createRepositories(tx);
      if (await repos.integrations.deleteMapping(caller.project.scope, id, mappingId)) {
        await this.audit(repos, caller, id, 'integration.mapping_deleted', { mappingId });
      } else {
        throw notFound();
      }
    });
  }
}
