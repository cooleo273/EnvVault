import type { DbClient } from '../client.js';

/** The audit event columns a seal covers. */
export interface SealableEvent {
  id: string;
  workspaceId: string | null;
  occurredAt: Date;
  actorType: string;
  actorUserId: string | null;
  actorServiceIdentityId: string | null;
  action: string;
  outcome: string;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  environmentId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
}

export interface ChainHead {
  chainId: string;
  seq: bigint;
  keyId: string;
  mac: Buffer;
  /** True when the head comes from a retention checkpoint (no seal row left). */
  checkpoint: boolean;
}

export interface NewSeal {
  chainId: string;
  seq: bigint;
  eventId: string;
  keyId: string;
  mac: Buffer;
}

export interface StoredSeal extends NewSeal {
  event: SealableEvent;
}

const eventSelect = {
  id: true,
  workspaceId: true,
  occurredAt: true,
  actorType: true,
  actorUserId: true,
  actorServiceIdentityId: true,
  action: true,
  outcome: true,
  resourceType: true,
  resourceId: true,
  projectId: true,
  environmentId: true,
  requestId: true,
  ipAddress: true,
  userAgent: true,
  metadata: true,
} as const;

/** Storage for the audit MAC chains. Computing MACs happens in the API, which holds the key. */
export class AuditSealRepository {
  constructor(private readonly db: DbClient) {}

  /** Serialises sealers (and purges) across processes for the rest of the transaction. */
  async lock(): Promise<void> {
    await this.db.$queryRaw`
      SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended('envvault:audit-seal', 0))) AS "lock"`;
  }

  /** Latest seal per chain, or the checkpoint a purge left when no seal remains. */
  async heads(): Promise<Map<string, ChainHead>> {
    const seals = await this.db.$queryRaw<
      { chain_id: string; seq: bigint | string; key_id: string; mac: Uint8Array }[]
    >`
      SELECT DISTINCT ON ("chain_id") "chain_id", "seq", "key_id", "mac"
      FROM "audit_seals" ORDER BY "chain_id", "seq" DESC`;
    const checkpoints = await this.db.$queryRaw<
      { chain_id: string; seq: bigint | string; key_id: string; mac: Uint8Array }[]
    >`
      SELECT DISTINCT ON ("chain_id") "chain_id", "seq", "key_id", "mac"
      FROM "audit_seal_checkpoints" ORDER BY "chain_id", "seq" DESC`;
    const heads = new Map<string, ChainHead>();
    for (const row of checkpoints) {
      heads.set(row.chain_id, {
        chainId: row.chain_id,
        seq: BigInt(row.seq),
        keyId: row.key_id,
        mac: Buffer.from(row.mac),
        checkpoint: true,
      });
    }
    for (const row of seals) {
      const existing = heads.get(row.chain_id);
      if (existing && existing.seq >= BigInt(row.seq)) continue;
      heads.set(row.chain_id, {
        chainId: row.chain_id,
        seq: BigInt(row.seq),
        keyId: row.key_id,
        mac: Buffer.from(row.mac),
        checkpoint: false,
      });
    }
    return heads;
  }

  /** When the most recently sealed event occurred (null before the first seal). */
  async latestSealedOccurredAt(): Promise<Date | null> {
    const rows = await this.db.$queryRaw<{ occurred_at: Date | null }[]>`
      SELECT max(e."occurred_at") AS "occurred_at"
      FROM (SELECT DISTINCT ON ("chain_id") "event_id" FROM "audit_seals" ORDER BY "chain_id", "seq" DESC) AS h
      JOIN "audit_events" e ON e."id" = h."event_id"`;
    return rows[0]?.occurred_at ?? null;
  }

  /** Events not yet sealed in [since, before), oldest first. */
  unsealed(since: Date, before: Date, limit: number): Promise<SealableEvent[]> {
    return this.db.auditEvent.findMany({
      where: { occurredAt: { gte: since, lt: before }, seal: { is: null } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: eventSelect,
    });
  }

  countUnsealed(before: Date): Promise<number> {
    return this.db.auditEvent.count({ where: { occurredAt: { lt: before }, seal: { is: null } } });
  }

  async insert(seals: readonly NewSeal[]): Promise<void> {
    if (seals.length === 0) return;
    await this.db.auditSeal.createMany({
      data: seals.map((s) => ({ ...s, mac: new Uint8Array(s.mac) })),
    });
  }

  async chainIds(): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ chain_id: string }[]>`
      SELECT "chain_id" FROM "audit_seals" UNION SELECT "chain_id" FROM "audit_seal_checkpoints"
      ORDER BY 1`;
    return rows.map((r) => r.chain_id);
  }

  /** Seals of one chain after `afterSeq`, in order, with the events they cover. */
  async page(chainId: string, afterSeq: bigint, limit: number): Promise<StoredSeal[]> {
    const rows = await this.db.auditSeal.findMany({
      where: { chainId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take: limit,
      select: {
        chainId: true,
        seq: true,
        eventId: true,
        keyId: true,
        mac: true,
        event: { select: eventSelect },
      },
    });
    return rows.map((r) => ({ ...r, mac: Buffer.from(r.mac) }));
  }

  /** The checkpoint a chain restarts from, if a purge removed its beginning. */
  async checkpointBefore(chainId: string, seq: bigint): Promise<ChainHead | null> {
    const row = await this.db.auditSealCheckpoint.findFirst({
      where: { chainId, seq: { lt: seq } },
      orderBy: { seq: 'desc' },
    });
    return row
      ? { chainId, seq: row.seq, keyId: row.keyId, mac: Buffer.from(row.mac), checkpoint: true }
      : null;
  }
}
