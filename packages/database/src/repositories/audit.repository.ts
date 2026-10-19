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
  requestId?: string | null;
  /** Non-sensitive context only. Never secret values, tokens or passwords. */
  metadata?: Prisma.InputJsonObject;
}

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
        requestId: event.requestId ?? null,
        metadata: event.metadata ?? {},
      },
    });
  }
}
