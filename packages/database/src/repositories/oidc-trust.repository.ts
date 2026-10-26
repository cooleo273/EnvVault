import type { DbClient } from '../client.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ProjectScope } from '../scope.js';
import type { UserRef } from './machine-identity.repository.js';

const userRef = { select: { id: true, email: true, displayName: true } } as const;

const bindingSelect = {
  credentialId: true,
  serviceIdentityId: true,
  repositoryId: true,
  repositoryOwnerId: true,
  repositoryName: true,
  workflowPath: true,
  jobWorkflowRef: true,
  refs: true,
  githubEnvironments: true,
  eventNames: true,
  subject: true,
  environmentIds: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: userRef,
  serviceIdentity: { select: { id: true, name: true } },
  credential: {
    select: {
      name: true,
      oidcIssuer: true,
      oidcAudience: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      createdBy: userRef,
    },
  },
} as const;

type BindingRow = Prisma.OidcTrustPolicyGetPayload<{ select: typeof bindingSelect }>;

export interface OidcBindingRecord {
  id: string;
  name: string;
  identity: { id: string; name: string };
  issuer: string;
  audience: string;
  scopes: string[];
  repositoryId: string;
  repositoryOwnerId: string;
  repositoryName: string;
  workflowPath: string | null;
  jobWorkflowRef: string | null;
  refs: string[];
  githubEnvironments: string[];
  eventNames: string[];
  subject: string | null;
  environmentIds: string[];
  disabledAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdBy: UserRef | null;
  updatedAt: Date;
  updatedBy: UserRef | null;
}

/** What the exchange needs to decide: the binding, its credential and its identity. */
export interface OidcBindingForExchange {
  id: string;
  workspaceId: string;
  name: string;
  audience: string;
  scopes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  disabledAt: Date | null;
  conditions: {
    repositoryId: string;
    repositoryOwnerId: string;
    workflowPath: string | null;
    jobWorkflowRef: string | null;
    refs: string[];
    githubEnvironments: string[];
    eventNames: string[];
    subject: string | null;
  };
  environmentIds: string[];
  identity: {
    id: string;
    name: string;
    projectId: string;
    status: 'ACTIVE' | 'DISABLED';
    expiresAt: Date | null;
    deletedAt: Date | null;
  };
}

export interface NewOidcBinding {
  workspaceId: string;
  projectId: string;
  serviceIdentityId: string;
  name: string;
  issuer: string;
  audience: string;
  scopes: string[];
  expiresAt: Date;
  createdById: string;
  repositoryId: string;
  repositoryOwnerId: string;
  repositoryName: string;
  workflowPath: string | null;
  jobWorkflowRef: string | null;
  refs: string[];
  githubEnvironments: string[];
  eventNames: string[];
  subject: string | null;
  environmentIds: string[];
}

export type OidcPolicyPatch = Partial<
  Pick<
    NewOidcBinding,
    | 'repositoryName'
    | 'workflowPath'
    | 'jobWorkflowRef'
    | 'refs'
    | 'githubEnvironments'
    | 'eventNames'
    | 'subject'
    | 'environmentIds'
  >
>;

function toRecord(row: BindingRow): OidcBindingRecord {
  const {
    credential,
    serviceIdentity,
    credentialId,
    serviceIdentityId: _identityId,
    ...rest
  } = row;
  return {
    ...rest,
    id: credentialId,
    name: credential.name,
    identity: serviceIdentity,
    issuer: credential.oidcIssuer ?? '',
    audience: credential.oidcAudience ?? '',
    scopes: credential.scopes,
    // The database requires an expiry on OIDC credentials.
    expiresAt: credential.expiresAt ?? new Date(0),
    revokedAt: credential.revokedAt,
    lastUsedAt: credential.lastUsedAt,
    createdBy: credential.createdBy,
  };
}

/**
 * GitHub Actions trust bindings: an OIDC_FEDERATION service credential plus
 * its claim conditions. Management lookups take a project scope, so a binding
 * of another project or workspace is simply not found. The exchange lookup
 * takes the verified issuer and repository id.
 */
export class OidcTrustRepository {
  constructor(private readonly db: DbClient) {}

  async create(input: NewOidcBinding): Promise<string> {
    const credential = await this.db.serviceCredential.create({
      data: {
        workspaceId: input.workspaceId,
        serviceIdentityId: input.serviceIdentityId,
        type: 'OIDC_FEDERATION',
        name: input.name,
        oidcIssuer: input.issuer,
        oidcAudience: input.audience,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
        createdById: input.createdById,
      },
      select: { id: true },
    });
    await this.db.oidcTrustPolicy.create({
      data: {
        credentialId: credential.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        serviceIdentityId: input.serviceIdentityId,
        repositoryId: input.repositoryId,
        repositoryOwnerId: input.repositoryOwnerId,
        repositoryName: input.repositoryName,
        workflowPath: input.workflowPath,
        jobWorkflowRef: input.jobWorkflowRef,
        refs: input.refs,
        githubEnvironments: input.githubEnvironments,
        eventNames: input.eventNames,
        subject: input.subject,
        environmentIds: input.environmentIds,
        updatedById: input.createdById,
      },
    });
    return credential.id;
  }

  async list(
    scope: ProjectScope,
    options: { identityId?: string | undefined; includeRevoked: boolean },
  ): Promise<OidcBindingRecord[]> {
    const rows = await this.db.oidcTrustPolicy.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ...(options.identityId ? { serviceIdentityId: options.identityId } : {}),
        ...(options.includeRevoked ? {} : { credential: { revokedAt: null } }),
      },
      select: bindingSelect,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map(toRecord);
  }

  async get(scope: ProjectScope, id: string): Promise<OidcBindingRecord | null> {
    const row = await this.db.oidcTrustPolicy.findFirst({
      where: { credentialId: id, workspaceId: scope.workspaceId, projectId: scope.projectId },
      select: bindingSelect,
    });
    return row ? toRecord(row) : null;
  }

  async countLive(identityId: string, now: Date): Promise<number> {
    return this.db.serviceCredential.count({
      where: {
        serviceIdentityId: identityId,
        type: 'OIDC_FEDERATION',
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
  }

  async update(
    scope: ProjectScope,
    id: string,
    patch: OidcPolicyPatch & { name?: string },
    by: string,
  ): Promise<boolean> {
    const { name, ...policy } = patch;
    const result = await this.db.oidcTrustPolicy.updateMany({
      where: {
        credentialId: id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        credential: { revokedAt: null },
      },
      data: { ...policy, updatedById: by },
    });
    if (result.count === 1 && name !== undefined) {
      await this.db.serviceCredential.update({ where: { id }, data: { name } });
    }
    return result.count === 1;
  }

  /** Ends the binding's live access tokens, so changed conditions apply at once. */
  async revokeTokens(id: string, now: Date): Promise<void> {
    await this.db.machineAccessToken.updateMany({
      where: { credentialId: id, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
  }

  /** Disables (with `by`) or enables (`by` null); true when the state changed. */
  async setDisabled(
    scope: ProjectScope,
    id: string,
    by: string | null,
    now: Date,
  ): Promise<boolean> {
    const result = await this.db.oidcTrustPolicy.updateMany({
      where: {
        credentialId: id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        credential: { revokedAt: null },
        disabledAt: by ? null : { not: null },
      },
      data: by
        ? { disabledAt: now, disabledById: by, updatedById: by }
        : { disabledAt: null, disabledById: null },
    });
    return result.count === 1;
  }

  /**
   * Live bindings that could accept a verified token: same issuer and
   * repository id, not revoked. Conditions are evaluated by the caller.
   */
  async forExchange(filter: {
    issuer: string;
    repositoryId: string;
    workspaceId?: string | undefined;
    projectId?: string | undefined;
    bindingId?: string | undefined;
  }): Promise<OidcBindingForExchange[]> {
    const rows = await this.db.oidcTrustPolicy.findMany({
      where: {
        repositoryId: filter.repositoryId,
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
        ...(filter.bindingId ? { credentialId: filter.bindingId } : {}),
        credential: { type: 'OIDC_FEDERATION', oidcIssuer: filter.issuer, revokedAt: null },
      },
      select: {
        credentialId: true,
        workspaceId: true,
        repositoryId: true,
        repositoryOwnerId: true,
        workflowPath: true,
        jobWorkflowRef: true,
        refs: true,
        githubEnvironments: true,
        eventNames: true,
        subject: true,
        environmentIds: true,
        disabledAt: true,
        credential: {
          select: {
            name: true,
            oidcAudience: true,
            scopes: true,
            expiresAt: true,
            revokedAt: true,
          },
        },
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
      take: 50,
    });
    return rows.flatMap((row) =>
      row.credential.oidcAudience && row.credential.expiresAt
        ? [
            {
              id: row.credentialId,
              workspaceId: row.workspaceId,
              name: row.credential.name,
              audience: row.credential.oidcAudience,
              scopes: row.credential.scopes,
              expiresAt: row.credential.expiresAt,
              revokedAt: row.credential.revokedAt,
              disabledAt: row.disabledAt,
              conditions: {
                repositoryId: row.repositoryId,
                repositoryOwnerId: row.repositoryOwnerId,
                workflowPath: row.workflowPath,
                jobWorkflowRef: row.jobWorkflowRef,
                refs: row.refs,
                githubEnvironments: row.githubEnvironments,
                eventNames: row.eventNames,
                subject: row.subject,
              },
              environmentIds: row.environmentIds,
              identity: row.serviceIdentity,
            },
          ]
        : [],
    );
  }

  /** Recent exchange attempts recorded for one binding (newest first). */
  async attempts(scope: ProjectScope, id: string, limit: number) {
    return this.db.auditEvent.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        action: { in: ['machine.authenticated', 'machine.authentication_failed'] },
        metadata: { path: ['credentialId'], equals: id },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { id: true, action: true, outcome: true, occurredAt: true, metadata: true },
    });
  }
}
