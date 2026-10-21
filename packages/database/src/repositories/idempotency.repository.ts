import type { DbClient } from '../client.js';
import { getConstraintViolation } from '../errors.js';
import type { Prisma } from '../generated/prisma/client.js';

export interface IdempotencyRequest {
  userId: string;
  key: string;
  method: string;
  route: string;
  fingerprint: Buffer;
  keyId: string;
  expiresAt: Date;
}

export interface StoredIdempotency {
  id: string;
  method: string;
  route: string;
  fingerprint: Buffer;
  keyId: string;
  status: 'pending' | 'completed';
  responseStatus: number | null;
  responseBody: Prisma.JsonValue;
  expiresAt: Date;
}

export type BeginResult =
  { started: true; id: string } | { started: false; existing: StoredIdempotency };

const UNIQUE = 'idempotency_records_user_key_key';

export class IdempotencyRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Reserves the key for this request, or returns the record that already
   * holds it. An expired record is replaced. The unique index decides races.
   */
  async begin(request: IdempotencyRequest, now = new Date()): Promise<BeginResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const created = await this.db.idempotencyRecord.create({
          data: {
            userId: request.userId,
            idempotencyKey: request.key,
            method: request.method,
            route: request.route,
            fingerprint: new Uint8Array(request.fingerprint),
            keyId: request.keyId,
            expiresAt: request.expiresAt,
          },
          select: { id: true },
        });
        return { started: true, id: created.id };
      } catch (error) {
        if (getConstraintViolation(error)?.constraint !== UNIQUE) throw error;
      }
      const existing = await this.db.idempotencyRecord.findUnique({
        where: { userId_idempotencyKey: { userId: request.userId, idempotencyKey: request.key } },
      });
      if (!existing) continue;
      if (existing.expiresAt <= now) {
        await this.db.idempotencyRecord.deleteMany({
          where: { id: existing.id, expiresAt: { lte: now } },
        });
        continue;
      }
      return {
        started: false,
        existing: {
          id: existing.id,
          method: existing.method,
          route: existing.route,
          fingerprint: Buffer.from(existing.fingerprint),
          keyId: existing.keyId,
          status: existing.status === 'completed' ? 'completed' : 'pending',
          responseStatus: existing.responseStatus,
          responseBody: existing.responseBody,
          expiresAt: existing.expiresAt,
        },
      };
    }
    throw new Error('Idempotency key could not be reserved');
  }

  async complete(id: string, status: number, body: Prisma.InputJsonValue | null): Promise<void> {
    await this.db.idempotencyRecord.update({
      where: { id },
      data: {
        status: 'completed',
        responseStatus: status,
        ...(body === null ? {} : { responseBody: body }),
      },
    });
  }

  /** Frees the key after a failed request, so the client can retry it. */
  async discard(id: string): Promise<void> {
    await this.db.idempotencyRecord.deleteMany({ where: { id, status: 'pending' } });
  }

  async purgeExpired(now: Date, limit: number): Promise<number> {
    const rows = await this.db.idempotencyRecord.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true },
      take: limit,
    });
    if (rows.length === 0) return 0;
    const result = await this.db.idempotencyRecord.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    return result.count;
  }
}
