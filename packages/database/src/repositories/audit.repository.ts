import type { DbClient } from '../client.js';
import type { AuditOutcome, Prisma } from '../generated/prisma/client.js';

export interface AuditEventInput {
  workspaceId?: string | null;
  actorUserId: string;
  /** Dotted action name, e.g. `workspace.deleted`. */
  action: string;
  outcome: AuditOutcome;
  resourceType: string;
  resourceId?: string | null;
  /** Scope of the event inside the workspace (project activity, environment history). */
  projectId?: string | null;
  environmentId?: string | null;
  requestId?: string | null;
  /** Non-sensitive context only. Never secret values, tokens or passwords. */
  metadata?: Prisma.InputJsonObject;
}

/** An event raised by operator tooling or a background job, not by a user request. */
export type SystemAuditEventInput = Omit<AuditEventInput, 'actorUserId'>;

/** An event caused by a machine identity (token exchange, runtime load, refusal). */
export type ServiceAuditEventInput = Omit<AuditEventInput, 'actorUserId'> & {
  actorServiceIdentityId: string;
};

/** Append-only writer for `audit_events` (updates/deletes are blocked in SQL). */
export class AuditRepository {
  constructor(private readonly db: DbClient) {}

  async append(event: AuditEventInput): Promise<void> {
    await this.db.auditEvent.create({
      data: {
        workspaceId: event.workspaceId ?? null,
        actorType: 'USER',
        actorUserId: event.actorUserId,
        action: event.action,
        outcome: event.outcome,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        projectId: event.projectId ?? null,
        environmentId: event.environmentId ?? null,
        requestId: event.requestId ?? null,
        metadata: event.metadata ?? {},
      },
    });
  }

  async appendService(event: ServiceAuditEventInput): Promise<void> {
    await this.db.auditEvent.create({
      data: {
        workspaceId: event.workspaceId ?? null,
        actorType: 'SERVICE_IDENTITY',
        actorServiceIdentityId: event.actorServiceIdentityId,
        action: event.action,
        outcome: event.outcome,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        projectId: event.projectId ?? null,
        environmentId: event.environmentId ?? null,
        requestId: event.requestId ?? null,
        metadata: event.metadata ?? {},
      },
    });
  }

  async appendSystem(event: SystemAuditEventInput): Promise<void> {
    await this.db.auditEvent.create({
      data: {
        workspaceId: event.workspaceId ?? null,
        actorType: 'SYSTEM',
        action: event.action,
        outcome: event.outcome,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        projectId: event.projectId ?? null,
        environmentId: event.environmentId ?? null,
        requestId: event.requestId ?? null,
        metadata: event.metadata ?? {},
      },
    });
  }
}
