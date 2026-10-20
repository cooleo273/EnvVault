import type { DbClient } from '../client.js';
import type { AuditOutcome, Prisma } from '../generated/prisma/client.js';
import type { ProjectScope } from '../scope.js';

export interface ActivityRecord {
  id: string;
  action: string;
  outcome: AuditOutcome;
  occurredAt: Date;
  actor: { displayName: string | null; email: string } | null;
  resourceType: string;
  resourceId: string | null;
  environmentId: string | null;
  metadata: Prisma.JsonValue;
}

/** Opaque keyset cursor: `<occurredAt ISO>|<id>`, base64url-encoded. */
export function encodeActivityCursor(record: { occurredAt: Date; id: string }): string {
  return Buffer.from(`${record.occurredAt.toISOString()}|${record.id}`).toString('base64url');
}

export function decodeActivityCursor(cursor: string): { occurredAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const occurredAt = new Date(iso ?? '');
  if (!id || Number.isNaN(occurredAt.getTime())) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { occurredAt, id };
}

/**
 * Project activity: the project's slice of the append-only audit log, newest
 * first, with keyset pagination (stable under concurrent inserts, no OFFSET).
 */
export class ActivityRepository {
  constructor(private readonly db: DbClient) {}

  async listForProject(
    scope: ProjectScope,
    options: {
      cursor?: { occurredAt: Date; id: string } | undefined;
      limit: number;
      environmentId?: string | undefined;
    },
  ): Promise<{ items: ActivityRecord[]; next: { occurredAt: Date; id: string } | null }> {
    const rows = await this.db.auditEvent.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ...(options.environmentId ? { environmentId: options.environmentId } : {}),
        ...(options.cursor
          ? {
              OR: [
                { occurredAt: { lt: options.cursor.occurredAt } },
                { occurredAt: options.cursor.occurredAt, id: { lt: options.cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      select: {
        id: true,
        action: true,
        outcome: true,
        occurredAt: true,
        actorUserId: true,
        resourceType: true,
        resourceId: true,
        environmentId: true,
        metadata: true,
      },
    });
    const page = rows.slice(0, options.limit);
    const actorIds = [...new Set(page.flatMap((r) => (r.actorUserId ? [r.actorUserId] : [])))];
    const actors = actorIds.length
      ? await this.db.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, displayName: true, email: true },
        })
      : [];
    const byId = new Map(actors.map((a) => [a.id, { displayName: a.displayName, email: a.email }]));
    const last = page.at(-1);
    return {
      items: page.map(({ actorUserId, ...row }) => ({
        ...row,
        actor: actorUserId ? (byId.get(actorUserId) ?? null) : null,
      })),
      next:
        rows.length > options.limit && last ? { occurredAt: last.occurredAt, id: last.id } : null,
    };
  }
}
