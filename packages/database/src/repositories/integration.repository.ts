import type { DbClient } from '../client.js';
import type { IntegrationTarget, Prisma, SyncJobStatus } from '../generated/prisma/client.js';
import type { ProjectScope } from '../scope.js';
import type { UserRef } from './machine-identity.repository.js';

const userRef = { select: { id: true, email: true, displayName: true } } as const;
const bytes = (b: Buffer) => new Uint8Array(b);

const connectionSelect = {
  id: true,
  provider: true,
  name: true,
  status: true,
  config: true,
  externalAccountId: true,
  credentialCiphertext: true,
  lastSyncedAt: true,
  lastCheckedAt: true,
  lastErrorCode: true,
  disconnectedAt: true,
  createdAt: true,
  createdBy: userRef,
} as const;

type ConnectionRow = Prisma.IntegrationConnectionGetPayload<{ select: typeof connectionSelect }>;

export interface IntegrationConnectionRecord {
  id: string;
  provider: 'VERCEL';
  name: string;
  status: 'ACTIVE' | 'DISABLED' | 'ERROR';
  config: Record<string, unknown>;
  externalAccountId: string | null;
  hasCredential: boolean;
  lastSyncedAt: Date | null;
  lastCheckedAt: Date | null;
  lastErrorCode: string | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  createdBy: UserRef | null;
}

/** Envelope columns of a provider credential (same layout as secret_versions). */
export interface StoredCredential {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptedDataKey: Buffer;
  envelopeVersion: number;
  kmsKeyVersion: number;
  encryptionKeyId: string;
  kmsProvider: string;
  kmsKeyRef: string;
}

export interface MappingRecord {
  id: string;
  integrationConnectionId: string;
  environment: { id: string; name: string; isProtected: boolean; deletedAt: Date | null };
  target: IntegrationTarget;
  gitBranch: string | null;
  customEnvironmentId: string | null;
  customEnvironmentSlug: string | null;
  managedVariables: number;
  lastSyncedAt: Date | null;
  createdAt: Date;
}

export interface ManagedVariableRecord {
  key: string;
  providerVariableId: string;
  providerUpdatedAt: bigint;
  secretVersionId: string | null;
}

const jobSelect = {
  id: true,
  mappingId: true,
  environmentId: true,
  status: true,
  trigger: true,
  startedAt: true,
  finishedAt: true,
  errorCode: true,
  errorMessage: true,
  summary: true,
  createdAt: true,
  requestedBy: userRef,
} as const;

export type SyncJobRecord = Prisma.IntegrationSyncJobGetPayload<{ select: typeof jobSelect }>;

function toConnection(row: ConnectionRow): IntegrationConnectionRecord {
  const { credentialCiphertext, config, ...rest } = row;
  return {
    ...rest,
    provider: row.provider as 'VERCEL',
    config: (config ?? {}) as Record<string, unknown>,
    hasCredential: credentialCiphertext !== null,
  };
}

/**
 * Deployment integrations: provider connections (with their envelope
 * encrypted credential), environment mappings, the provider variables EnvVault
 * manages, and sync jobs. Everything is found through a project scope, so a
 * connection of another project or workspace is simply not found.
 */
export class IntegrationRepository {
  constructor(private readonly db: DbClient) {}

  /* ------------------------------------------------------------ connections */

  async countConnections(scope: ProjectScope): Promise<number> {
    return this.db.integrationConnection.count({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId, disconnectedAt: null },
    });
  }

  async createConnection(
    scope: ProjectScope,
    input: {
      id: string;
      name: string;
      externalAccountId: string;
      config: Record<string, unknown>;
      credential: StoredCredential;
      createdById: string;
      checkedAt: Date;
    },
  ): Promise<void> {
    await this.db.integrationConnection.create({
      data: {
        id: input.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        provider: 'VERCEL',
        name: input.name,
        externalAccountId: input.externalAccountId,
        config: input.config as Prisma.InputJsonValue,
        createdById: input.createdById,
        lastCheckedAt: input.checkedAt,
        ...this.credentialColumns(input.credential),
      },
    });
  }

  private credentialColumns(credential: StoredCredential) {
    return {
      credentialCiphertext: bytes(credential.ciphertext),
      credentialIv: bytes(credential.iv),
      credentialAuthTag: bytes(credential.authTag),
      credentialEncryptedDataKey: bytes(credential.encryptedDataKey),
      credentialAlgorithm: 'AES_256_GCM' as const,
      credentialEnvelopeVersion: credential.envelopeVersion,
      credentialKmsKeyVersion: credential.kmsKeyVersion,
      encryptionKeyId: credential.encryptionKeyId,
    };
  }

  async listConnections(scope: ProjectScope): Promise<IntegrationConnectionRecord[]> {
    const rows = await this.db.integrationConnection.findMany({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
      select: connectionSelect,
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return rows.map(toConnection);
  }

  async getConnection(
    scope: ProjectScope,
    id: string,
  ): Promise<IntegrationConnectionRecord | null> {
    const row = await this.db.integrationConnection.findFirst({
      where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId },
      select: connectionSelect,
    });
    return row ? toConnection(row) : null;
  }

  /** The encrypted credential with the key row it was wrapped under, for decryption. */
  async credential(scope: ProjectScope, id: string): Promise<StoredCredential | null> {
    const row = await this.db.integrationConnection.findFirst({
      where: {
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        disconnectedAt: null,
      },
      select: {
        credentialCiphertext: true,
        credentialIv: true,
        credentialAuthTag: true,
        credentialEncryptedDataKey: true,
        credentialEnvelopeVersion: true,
        credentialKmsKeyVersion: true,
        encryptionKey: { select: { id: true, kmsProvider: true, kmsKeyRef: true } },
      },
    });
    if (
      !row?.credentialCiphertext ||
      !row.credentialIv ||
      !row.credentialAuthTag ||
      !row.credentialEncryptedDataKey ||
      row.credentialEnvelopeVersion === null ||
      row.credentialKmsKeyVersion === null ||
      !row.encryptionKey
    ) {
      return null;
    }
    return {
      ciphertext: Buffer.from(row.credentialCiphertext),
      iv: Buffer.from(row.credentialIv),
      authTag: Buffer.from(row.credentialAuthTag),
      encryptedDataKey: Buffer.from(row.credentialEncryptedDataKey),
      envelopeVersion: row.credentialEnvelopeVersion,
      kmsKeyVersion: row.credentialKmsKeyVersion,
      encryptionKeyId: row.encryptionKey.id,
      kmsProvider: row.encryptionKey.kmsProvider,
      kmsKeyRef: row.encryptionKey.kmsKeyRef,
    };
  }

  async replaceCredential(
    scope: ProjectScope,
    id: string,
    credential: StoredCredential,
    now: Date,
  ) {
    const result = await this.db.integrationConnection.updateMany({
      where: {
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        disconnectedAt: null,
      },
      data: {
        ...this.credentialColumns(credential),
        status: 'ACTIVE',
        lastCheckedAt: now,
        lastErrorCode: null,
      },
    });
    return result.count === 1;
  }

  async updateConnection(
    scope: ProjectScope,
    id: string,
    patch: Partial<{
      status: 'ACTIVE' | 'DISABLED' | 'ERROR';
      config: Record<string, unknown>;
      lastCheckedAt: Date;
      lastErrorCode: string | null;
      lastSyncedAt: Date;
    }>,
  ): Promise<boolean> {
    const { config, ...rest } = patch;
    const result = await this.db.integrationConnection.updateMany({
      where: {
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        disconnectedAt: null,
      },
      data: { ...rest, ...(config ? { config: config as Prisma.InputJsonValue } : {}) },
    });
    return result.count === 1;
  }

  /** Erases the credential and mappings; the row and its sync history stay. */
  async disconnect(scope: ProjectScope, id: string, now: Date): Promise<boolean> {
    const result = await this.db.integrationConnection.updateMany({
      where: {
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        disconnectedAt: null,
      },
      data: {
        status: 'DISABLED',
        disconnectedAt: now,
        credentialCiphertext: null,
        credentialIv: null,
        credentialAuthTag: null,
        credentialEncryptedDataKey: null,
        credentialAlgorithm: null,
        credentialEnvelopeVersion: null,
        credentialKmsKeyVersion: null,
        encryptionKeyId: null,
      },
    });
    if (result.count === 1) {
      await this.db.integrationEnvironmentMapping.deleteMany({
        where: { integrationConnectionId: id, workspaceId: scope.workspaceId },
      });
    }
    return result.count === 1;
  }

  /* --------------------------------------------------------------- mappings */

  private readonly mappingSelect = {
    id: true,
    integrationConnectionId: true,
    target: true,
    gitBranch: true,
    customEnvironmentId: true,
    customEnvironmentSlug: true,
    lastSyncedAt: true,
    createdAt: true,
    environment: { select: { id: true, name: true, isProtected: true, deletedAt: true } },
    _count: { select: { managedVariables: true } },
  } as const;

  private toMapping(
    row: Prisma.IntegrationEnvironmentMappingGetPayload<{
      select: IntegrationRepository['mappingSelect'];
    }>,
  ): MappingRecord {
    const { _count, ...rest } = row;
    return { ...rest, managedVariables: _count.managedVariables };
  }

  async countMappings(connectionId: string): Promise<number> {
    return this.db.integrationEnvironmentMapping.count({
      where: { integrationConnectionId: connectionId },
    });
  }

  async createMapping(
    scope: ProjectScope,
    input: {
      connectionId: string;
      environmentId: string;
      target: IntegrationTarget;
      gitBranch: string | null;
      customEnvironmentId: string | null;
      customEnvironmentSlug: string | null;
      createdById: string;
    },
  ): Promise<string> {
    const row = await this.db.integrationEnvironmentMapping.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        integrationConnectionId: input.connectionId,
        environmentId: input.environmentId,
        target: input.target,
        gitBranch: input.gitBranch,
        customEnvironmentId: input.customEnvironmentId,
        customEnvironmentSlug: input.customEnvironmentSlug,
        createdById: input.createdById,
      },
      select: { id: true },
    });
    return row.id;
  }

  async listMappings(scope: ProjectScope, connectionId: string): Promise<MappingRecord[]> {
    const rows = await this.db.integrationEnvironmentMapping.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        integrationConnectionId: connectionId,
      },
      select: this.mappingSelect,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toMapping(r));
  }

  async getMapping(
    scope: ProjectScope,
    connectionId: string,
    mappingId: string,
  ): Promise<MappingRecord | null> {
    const row = await this.db.integrationEnvironmentMapping.findFirst({
      where: {
        id: mappingId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        integrationConnectionId: connectionId,
      },
      select: this.mappingSelect,
    });
    return row ? this.toMapping(row) : null;
  }

  async deleteMapping(scope: ProjectScope, connectionId: string, mappingId: string) {
    const result = await this.db.integrationEnvironmentMapping.deleteMany({
      where: {
        id: mappingId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        integrationConnectionId: connectionId,
      },
    });
    return result.count === 1;
  }

  async markMappingSynced(mappingId: string, now: Date): Promise<void> {
    await this.db.integrationEnvironmentMapping.update({
      where: { id: mappingId },
      data: { lastSyncedAt: now },
    });
  }

  /* ------------------------------------------------------ managed variables */

  async managedVariables(mappingId: string): Promise<ManagedVariableRecord[]> {
    return this.db.integrationManagedVariable.findMany({
      where: { mappingId },
      select: {
        key: true,
        providerVariableId: true,
        providerUpdatedAt: true,
        secretVersionId: true,
      },
    });
  }

  async recordManaged(
    workspaceId: string,
    mappingId: string,
    input: ManagedVariableRecord & { jobId: string },
  ): Promise<void> {
    const data = {
      providerVariableId: input.providerVariableId,
      providerUpdatedAt: input.providerUpdatedAt,
      secretVersionId: input.secretVersionId,
      lastSyncJobId: input.jobId,
    };
    await this.db.integrationManagedVariable.upsert({
      where: { mappingId_key: { mappingId, key: input.key } },
      create: { workspaceId, mappingId, key: input.key, ...data },
      update: data,
    });
  }

  async forgetManaged(mappingId: string, key: string): Promise<void> {
    await this.db.integrationManagedVariable.deleteMany({ where: { mappingId, key } });
  }

  /* ------------------------------------------------------------------- jobs */

  /** Jobs left running by a crashed process; they would otherwise block the mapping forever. */
  async failStaleJobs(mappingId: string, before: Date, now: Date): Promise<void> {
    await this.db.integrationSyncJob.updateMany({
      where: { mappingId, status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lt: before } },
      data: {
        status: 'FAILED',
        startedAt: now,
        finishedAt: now,
        errorCode: 'STALE',
        errorMessage: 'The synchronisation did not finish and was abandoned',
      },
    });
  }

  /** Throws a unique violation (`integration_sync_jobs_active_key`) while another runs. */
  async startJob(input: {
    workspaceId: string;
    projectId: string;
    connectionId: string;
    environmentId: string;
    mappingId: string;
    requestedById: string;
    planHash: string;
    now: Date;
  }): Promise<string> {
    const row = await this.db.integrationSyncJob.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        integrationConnectionId: input.connectionId,
        environmentId: input.environmentId,
        mappingId: input.mappingId,
        requestedById: input.requestedById,
        planHash: input.planHash,
        status: 'RUNNING',
        trigger: 'MANUAL',
        attempt: 1,
        startedAt: input.now,
      },
      select: { id: true },
    });
    return row.id;
  }

  async finishJob(
    id: string,
    input: {
      status: SyncJobStatus;
      summary: Record<string, unknown>;
      errorCode: string | null;
      errorMessage: string | null;
      now: Date;
    },
  ): Promise<void> {
    await this.db.integrationSyncJob.update({
      where: { id },
      data: {
        status: input.status,
        summary: input.summary as Prisma.InputJsonValue,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        finishedAt: input.now,
      },
    });
  }

  async listJobs(
    scope: ProjectScope,
    connectionId: string,
    limit: number,
  ): Promise<SyncJobRecord[]> {
    return this.db.integrationSyncJob.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        integrationConnectionId: connectionId,
      },
      select: jobSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  async getJob(scope: ProjectScope, id: string): Promise<SyncJobRecord | null> {
    return this.db.integrationSyncJob.findFirst({
      where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId },
      select: jobSelect,
    });
  }
}
