import type { DbClient } from '../client.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { EnvironmentScope, ProjectScope } from '../scope.js';

const userRef = { select: { id: true, email: true, displayName: true } } as const;

const grantSelect = {
  id: true,
  effect: true,
  expiresAt: true,
  createdAt: true,
  createdBy: userRef,
  environment: { select: { id: true, name: true, slug: true, isProtected: true, deletedAt: true } },
  role: {
    select: {
      key: true,
      name: true,
      permissions: { select: { permission: { select: { key: true } } } },
    },
  },
} as const;

const identitySelect = {
  id: true,
  workspaceId: true,
  projectId: true,
  name: true,
  description: true,
  status: true,
  expiresAt: true,
  credentialMaxLifetimeDays: true,
  createdAt: true,
  createdBy: userRef,
  lastAuthenticatedAt: true,
  lastUsedAt: true,
  disabledAt: true,
  disabledReason: true,
  deletedAt: true,
  accessPolicies: { select: grantSelect, orderBy: { createdAt: 'asc' } },
} as const;

type IdentityRow = Prisma.ServiceIdentityGetPayload<{ select: typeof identitySelect }>;

export interface UserRef {
  id: string;
  email: string;
  displayName: string | null;
}

export interface MachineGrantRecord {
  id: string;
  effect: 'ALLOW' | 'DENY';
  expiresAt: Date | null;
  createdAt: Date;
  createdBy: UserRef | null;
  environment: { id: string; name: string; slug: string; isProtected: boolean };
  role: { key: string; name: string; permissions: string[] };
}

export interface MachineIdentityRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'DISABLED';
  expiresAt: Date | null;
  credentialMaxLifetimeDays: number;
  createdAt: Date;
  createdBy: UserRef | null;
  lastAuthenticatedAt: Date | null;
  lastUsedAt: Date | null;
  disabledAt: Date | null;
  disabledReason: string | null;
  retiredAt: Date | null;
  activeCredentials: number;
  grants: MachineGrantRecord[];
}

export interface ServiceCredentialRecord {
  id: string;
  serviceIdentityId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: Date;
  createdBy: UserRef | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  rotatedFromId: string | null;
  replacedById: string | null;
}

export interface NewServiceCredential {
  workspaceId: string;
  serviceIdentityId: string;
  name: string;
  lookupId: string;
  digest: Buffer;
  digestKeyId: string;
  scopes: string[];
  expiresAt: Date;
  createdById: string;
  rotatedFromId?: string;
}

/** What the token exchange needs to decide: the credential and its identity. */
export interface CredentialForExchange {
  id: string;
  workspaceId: string;
  serviceIdentityId: string;
  name: string;
  secretHash: Buffer;
  digestKeyId: string;
  scopes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  identity: {
    id: string;
    name: string;
    projectId: string;
    status: 'ACTIVE' | 'DISABLED';
    expiresAt: Date | null;
    deletedAt: Date | null;
  };
}

/** What every machine request checks again: token, credential and identity. */
export interface MachineTokenRecord {
  id: string;
  workspaceId: string;
  serviceIdentityId: string;
  credentialId: string;
  scopes: string[];
  environmentIds: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  credential: { name: string; expiresAt: Date | null; revokedAt: Date | null };
  identity: {
    name: string;
    projectId: string;
    status: 'ACTIVE' | 'DISABLED';
    expiresAt: Date | null;
    deletedAt: Date | null;
    lastUsedAt: Date | null;
  };
}

export interface MachineEnvironmentGrants {
  environment: {
    id: string;
    name: string;
    slug: string;
    kind: string;
    isProtected: boolean;
    status: 'ACTIVE' | 'ARCHIVED';
    baseEnvironmentId: string | null;
  };
  grants: { effect: 'ALLOW' | 'DENY'; expiresAt: Date | null; permissions: string[] }[];
}

const bytes = (b: Buffer) => new Uint8Array(b);

function permissionsOf(role: { permissions: { permission: { key: string } }[] }): string[] {
  return role.permissions.map((p) => p.permission.key).sort();
}

function toGrant(row: IdentityRow['accessPolicies'][number]): MachineGrantRecord {
  return {
    id: row.id,
    effect: row.effect,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    environment: {
      id: row.environment.id,
      name: row.environment.name,
      slug: row.environment.slug,
      isProtected: row.environment.isProtected,
    },
    role: { key: row.role.key, name: row.role.name, permissions: permissionsOf(row.role) },
  };
}

/**
 * Machine identities, their credentials, access tokens and environment
 * grants. Lookups take a project scope, so an identity of another project
 * or workspace is simply not found. The exchange and token lookups take a
 * digest or hash: establishing who is calling is their job.
 */
export class MachineIdentityRepository {
  constructor(private readonly db: DbClient) {}

  private async toRecords(rows: IdentityRow[], now: Date): Promise<MachineIdentityRecord[]> {
    const counts = rows.length
      ? await this.db.serviceCredential.groupBy({
          by: ['serviceIdentityId'],
          where: {
            serviceIdentityId: { in: rows.map((r) => r.id) },
            revokedAt: null,
            expiresAt: { gt: now },
          },
          _count: { _all: true },
        })
      : [];
    const active = new Map(counts.map((c) => [c.serviceIdentityId, c._count._all]));
    return rows.map(({ accessPolicies, deletedAt, ...row }) => ({
      ...row,
      retiredAt: deletedAt,
      activeCredentials: active.get(row.id) ?? 0,
      grants: accessPolicies.filter((g) => g.environment.deletedAt === null).map(toGrant),
    }));
  }

  async list(
    scope: ProjectScope,
    options: { q?: string | undefined; includeRetired?: boolean | undefined },
    now = new Date(),
  ): Promise<MachineIdentityRecord[]> {
    const rows = await this.db.serviceIdentity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ...(options.includeRetired ? {} : { deletedAt: null }),
        ...(options.q
          ? {
              OR: [
                { name: { contains: options.q, mode: 'insensitive' } },
                { description: { contains: options.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: identitySelect,
      orderBy: [{ deletedAt: { sort: 'desc', nulls: 'first' } }, { name: 'asc' }],
      take: 500,
    });
    return this.toRecords(rows, now);
  }

  async get(
    scope: ProjectScope,
    id: string,
    now = new Date(),
  ): Promise<MachineIdentityRecord | null> {
    const row = await this.db.serviceIdentity.findFirst({
      where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId },
      select: identitySelect,
    });
    if (!row) return null;
    const [record] = await this.toRecords([row], now);
    return record ?? null;
  }

  async countLive(scope: ProjectScope): Promise<number> {
    return this.db.serviceIdentity.count({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId, deletedAt: null },
    });
  }

  async create(
    scope: ProjectScope,
    input: {
      name: string;
      description: string | null;
      expiresAt: Date | null;
      credentialMaxLifetimeDays: number;
      createdById: string;
    },
  ): Promise<string> {
    const row = await this.db.serviceIdentity.create({
      data: { workspaceId: scope.workspaceId, projectId: scope.projectId, ...input },
      select: { id: true },
    });
    return row.id;
  }

  async update(
    scope: ProjectScope,
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      expiresAt?: Date | null;
      credentialMaxLifetimeDays?: number;
    },
  ): Promise<boolean> {
    const result = await this.db.serviceIdentity.updateMany({
      where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId, deletedAt: null },
      data: patch,
    });
    return result.count === 1;
  }

  async disable(
    scope: ProjectScope,
    id: string,
    by: string,
    reason: string | null,
    now: Date,
  ): Promise<boolean> {
    const result = await this.db.serviceIdentity.updateMany({
      where: {
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        deletedAt: null,
        status: 'ACTIVE',
      },
      data: { status: 'DISABLED', disabledAt: now, disabledById: by, disabledReason: reason },
    });
    if (result.count === 1) await this.revokeTokensOfIdentity(id, now);
    return result.count === 1;
  }

  async enable(scope: ProjectScope, id: string): Promise<boolean> {
    const result = await this.db.serviceIdentity.updateMany({
      where: {
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        deletedAt: null,
        status: 'DISABLED',
      },
      data: { status: 'ACTIVE', disabledAt: null, disabledById: null, disabledReason: null },
    });
    return result.count === 1;
  }

  /**
   * Retires an identity for good: disabled, every credential revoked, every
   * token ended, every grant removed. The row stays for history and audit.
   */
  async retire(scope: ProjectScope, id: string, by: string, now: Date): Promise<boolean> {
    const result = await this.db.serviceIdentity.updateMany({
      where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId, deletedAt: null },
      data: {
        status: 'DISABLED',
        disabledAt: now,
        disabledById: by,
        disabledReason: 'retired',
        deletedAt: now,
        retiredById: by,
      },
    });
    if (result.count !== 1) return false;
    await this.db.serviceCredential.updateMany({
      where: { serviceIdentityId: id, workspaceId: scope.workspaceId, revokedAt: null },
      data: { revokedAt: now, revokedById: by, revocationReason: 'identity retired' },
    });
    await this.revokeTokensOfIdentity(id, now);
    await this.db.accessPolicy.deleteMany({
      where: { serviceIdentityId: id, workspaceId: scope.workspaceId, projectId: scope.projectId },
    });
    return true;
  }

  /* ---------------------------------------------------------- credentials */

  private toCredential(row: {
    id: string;
    serviceIdentityId: string;
    name: string;
    tokenPrefix: string | null;
    scopes: string[];
    createdAt: Date;
    createdBy: UserRef | null;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
    revocationReason: string | null;
    rotatedFromId: string | null;
    replacement: { id: string } | null;
  }): ServiceCredentialRecord {
    const { replacement, tokenPrefix, expiresAt, ...rest } = row;
    return {
      ...rest,
      tokenPrefix: tokenPrefix ?? '',
      expiresAt: expiresAt ?? row.createdAt,
      replacedById: replacement?.id ?? null,
    };
  }

  private readonly credentialSelect = {
    id: true,
    serviceIdentityId: true,
    name: true,
    tokenPrefix: true,
    scopes: true,
    createdAt: true,
    createdBy: userRef,
    expiresAt: true,
    lastUsedAt: true,
    revokedAt: true,
    revocationReason: true,
    rotatedFromId: true,
    replacement: { select: { id: true } },
  } as const;

  async listCredentials(
    scope: ProjectScope,
    identityId: string,
  ): Promise<ServiceCredentialRecord[]> {
    const rows = await this.db.serviceCredential.findMany({
      where: {
        workspaceId: scope.workspaceId,
        serviceIdentityId: identityId,
        type: 'API_TOKEN',
        serviceIdentity: { projectId: scope.projectId },
      },
      select: this.credentialSelect,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => this.toCredential(row));
  }

  async getCredential(
    scope: ProjectScope,
    identityId: string,
    credentialId: string,
  ): Promise<ServiceCredentialRecord | null> {
    const row = await this.db.serviceCredential.findFirst({
      where: {
        id: credentialId,
        workspaceId: scope.workspaceId,
        serviceIdentityId: identityId,
        type: 'API_TOKEN',
        serviceIdentity: { projectId: scope.projectId },
      },
      select: this.credentialSelect,
    });
    return row ? this.toCredential(row) : null;
  }

  async countActiveCredentials(identityId: string, now: Date): Promise<number> {
    return this.db.serviceCredential.count({
      where: { serviceIdentityId: identityId, revokedAt: null, expiresAt: { gt: now } },
    });
  }

  async createCredential(input: NewServiceCredential): Promise<string> {
    const row = await this.db.serviceCredential.create({
      data: {
        workspaceId: input.workspaceId,
        serviceIdentityId: input.serviceIdentityId,
        type: 'API_TOKEN',
        name: input.name,
        tokenPrefix: input.lookupId,
        secretHash: bytes(input.digest),
        hashAlgorithm: 'hmac-sha256',
        digestKeyId: input.digestKeyId,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
        createdById: input.createdById,
        ...(input.rotatedFromId ? { rotatedFromId: input.rotatedFromId } : {}),
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Shortens a replaced credential to the overlap window (never lengthens it). */
  async endCredentialAt(credentialId: string, expiresAt: Date): Promise<void> {
    await this.db.serviceCredential.updateMany({
      where: { id: credentialId, revokedAt: null, expiresAt: { gt: expiresAt } },
      data: { expiresAt },
    });
  }

  async revokeCredential(
    scope: ProjectScope,
    identityId: string,
    credentialId: string,
    by: string,
    reason: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.db.serviceCredential.updateMany({
      where: {
        id: credentialId,
        workspaceId: scope.workspaceId,
        serviceIdentityId: identityId,
        revokedAt: null,
        serviceIdentity: { projectId: scope.projectId },
      },
      data: { revokedAt: now, revokedById: by, revocationReason: reason },
    });
    if (result.count === 1) {
      await this.db.machineAccessToken.updateMany({
        where: { credentialId, revokedAt: null },
        data: { revokedAt: now },
      });
    }
    return result.count === 1;
  }

  async credentialForExchange(lookupId: string): Promise<CredentialForExchange | null> {
    const row = await this.db.serviceCredential.findUnique({
      where: { tokenPrefix: lookupId },
      select: {
        id: true,
        workspaceId: true,
        serviceIdentityId: true,
        type: true,
        name: true,
        secretHash: true,
        digestKeyId: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
        serviceIdentity: {
          select: {
            id: true,
            name: true,
            projectId: true,
            status: true,
            expiresAt: true,
            deletedAt: true,
          },
        },
      },
    });
    if (row?.type !== 'API_TOKEN' || !row.secretHash || !row.digestKeyId || !row.expiresAt) {
      return null;
    }
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      serviceIdentityId: row.serviceIdentityId,
      name: row.name,
      secretHash: Buffer.from(row.secretHash),
      digestKeyId: row.digestKeyId,
      scopes: row.scopes,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      identity: row.serviceIdentity,
    };
  }

  async recordAuthentication(credentialId: string, identityId: string, now: Date): Promise<void> {
    await this.db.serviceCredential.update({
      where: { id: credentialId },
      data: { lastUsedAt: now },
    });
    await this.db.serviceIdentity.update({
      where: { id: identityId },
      data: { lastAuthenticatedAt: now },
    });
  }

  /* --------------------------------------------------------- access tokens */

  async createAccessToken(input: {
    workspaceId: string;
    serviceIdentityId: string;
    credentialId: string;
    tokenHash: Buffer;
    scopes: string[];
    environmentIds: string[];
    requestedIp: string | null;
    expiresAt: Date;
  }): Promise<string> {
    const row = await this.db.machineAccessToken.create({
      data: { ...input, tokenHash: bytes(input.tokenHash) },
      select: { id: true },
    });
    return row.id;
  }

  async tokenByHash(tokenHash: Buffer): Promise<MachineTokenRecord | null> {
    const row = await this.db.machineAccessToken.findUnique({
      where: { tokenHash: bytes(tokenHash) },
      select: {
        id: true,
        workspaceId: true,
        serviceIdentityId: true,
        credentialId: true,
        scopes: true,
        environmentIds: true,
        expiresAt: true,
        revokedAt: true,
        credential: {
          select: {
            name: true,
            expiresAt: true,
            revokedAt: true,
            serviceIdentity: {
              select: {
                name: true,
                projectId: true,
                status: true,
                expiresAt: true,
                deletedAt: true,
                lastUsedAt: true,
              },
            },
          },
        },
      },
    });
    if (!row) return null;
    const { credential, ...rest } = row;
    const { serviceIdentity, ...credentialRest } = credential;
    return { ...rest, credential: credentialRest, identity: serviceIdentity };
  }

  async revokeToken(id: string, now: Date): Promise<void> {
    await this.db.machineAccessToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async revokeTokensOfIdentity(identityId: string, now: Date): Promise<void> {
    await this.db.machineAccessToken.updateMany({
      where: { serviceIdentityId: identityId, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
  }

  /** Last activity, written at most once a minute per identity. */
  async touch(identityId: string, lastUsedAt: Date | null, now: Date): Promise<void> {
    if (lastUsedAt && now.getTime() - lastUsedAt.getTime() < 60_000) return;
    await this.db.serviceIdentity.update({ where: { id: identityId }, data: { lastUsedAt: now } });
  }

  /* ---------------------------------------------------------------- grants */

  async createGrant(
    scope: EnvironmentScope,
    input: {
      serviceIdentityId: string;
      roleId: string;
      effect: 'ALLOW' | 'DENY';
      expiresAt: Date | null;
      createdById: string;
    },
  ): Promise<string> {
    const row = await this.db.accessPolicy.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        ...input,
      },
      select: { id: true },
    });
    return row.id;
  }

  async findGrant(scope: ProjectScope, identityId: string, grantId: string) {
    return this.db.accessPolicy.findFirst({
      where: {
        id: grantId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        serviceIdentityId: identityId,
      },
      select: {
        id: true,
        environmentId: true,
        effect: true,
        environment: { select: { isProtected: true } },
        role: { select: { key: true } },
      },
    });
  }

  async removeGrant(scope: ProjectScope, identityId: string, grantId: string): Promise<boolean> {
    const result = await this.db.accessPolicy.deleteMany({
      where: {
        id: grantId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        serviceIdentityId: identityId,
      },
    });
    return result.count === 1;
  }

  /**
   * The identity's project environments (live only) with its grants on each,
   * for evaluating machine permissions. Workspace and project come from the
   * verified token, never from the request.
   */
  async environmentsWithGrants(
    workspaceId: string,
    projectId: string,
    identityId: string,
  ): Promise<MachineEnvironmentGrants[]> {
    const rows = await this.db.environment.findMany({
      where: { workspaceId, projectId, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        kind: true,
        isProtected: true,
        status: true,
        baseEnvironmentId: true,
        accessPolicies: {
          where: { serviceIdentityId: identityId },
          select: {
            effect: true,
            expiresAt: true,
            role: {
              select: { permissions: { select: { permission: { select: { key: true } } } } },
            },
          },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: 500,
    });
    return rows.map(({ accessPolicies, ...environment }) => ({
      environment,
      grants: accessPolicies.map((p) => ({
        effect: p.effect,
        expiresAt: p.expiresAt,
        permissions: permissionsOf(p.role),
      })),
    }));
  }

  /** The identity's project while it is live (ids come from the verified token). */
  async liveProject(
    workspaceId: string,
    projectId: string,
  ): Promise<{ name: string; status: 'ACTIVE' | 'ARCHIVED' } | null> {
    return this.db.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { name: true, status: true },
    });
  }

  /* -------------------------------------------------------------- activity */

  async activity(
    scope: ProjectScope,
    identityId: string,
    options: { cursor?: { occurredAt: Date; id: string } | undefined; limit: number },
  ) {
    const rows = await this.db.auditEvent.findMany({
      where: {
        workspaceId: scope.workspaceId,
        AND: [
          {
            OR: [
              { actorServiceIdentityId: identityId },
              { resourceType: 'service_identity', resourceId: identityId },
            ],
          },
          options.cursor
            ? {
                OR: [
                  { occurredAt: { lt: options.cursor.occurredAt } },
                  { occurredAt: options.cursor.occurredAt, id: { lt: options.cursor.id } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      select: {
        id: true,
        action: true,
        outcome: true,
        occurredAt: true,
        actorType: true,
        actorUserId: true,
        environmentId: true,
        metadata: true,
      },
    });
    const page = rows.slice(0, options.limit);
    const userIds = [...new Set(page.flatMap((r) => (r.actorUserId ? [r.actorUserId] : [])))];
    const users = userIds.length
      ? await this.db.user.findMany({ where: { id: { in: userIds } }, select: userRef.select })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        ...r,
        user: r.actorUserId ? (byId.get(r.actorUserId) ?? null) : null,
      })),
      next:
        rows.length > options.limit && last ? { occurredAt: last.occurredAt, id: last.id } : null,
    };
  }
}
