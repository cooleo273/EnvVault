import type { DbClient } from '../client.js';

/**
 * Operator queries for key rotation. Unlike the tenant repositories these
 * span every workspace: they run from the operator tooling, never from a
 * request. They read and write envelope columns only; values stay encrypted.
 */
export interface KeyReferenceCount {
  kmsProvider: string;
  kmsKeyRef: string;
  /** Null for rows written before key versions were recorded. */
  kmsKeyVersion: string | null;
  versions: number;
}

/** One stored envelope plus the ids its encryption context is built from. */
export interface StoredEnvelopeRow {
  id: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  secretId: string;
  envelopeVersion: number;
  algorithm: string;
  kmsProvider: string;
  kmsKeyRef: string;
  kmsKeyVersion: string | null;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptedDataKey: Buffer;
}

export interface EnvelopeQuery {
  kmsProvider: string;
  kmsKeyRef: string;
  /** Only rows whose key version differs from this one (rows still on older versions). */
  excludeKeyVersion?: string;
  /** Only rows on exactly this key version. */
  keyVersion?: string;
}

const envelopeSelect = {
  id: true,
  workspaceId: true,
  secretId: true,
  envelopeVersion: true,
  algorithm: true,
  kmsKeyVersion: true,
  ciphertext: true,
  iv: true,
  authTag: true,
  encryptedDataKey: true,
  encryptionKey: { select: { kmsProvider: true, kmsKeyRef: true } },
  secret: { select: { projectId: true, environmentId: true } },
} as const;

function where(query: EnvelopeQuery, afterId?: string) {
  return {
    encryptionKey: { kmsProvider: query.kmsProvider, kmsKeyRef: query.kmsKeyRef },
    ...(query.keyVersion !== undefined ? { kmsKeyVersion: query.keyVersion } : {}),
    ...(query.excludeKeyVersion !== undefined
      ? {
          OR: [{ kmsKeyVersion: { not: query.excludeKeyVersion } }, { kmsKeyVersion: null }],
        }
      : {}),
    ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
  };
}

export class KeyMaintenanceRepository {
  constructor(private readonly db: DbClient) {}

  /** How many secret versions reference each provider key version. */
  async referenceCounts(): Promise<KeyReferenceCount[]> {
    const rows = await this.db.$queryRaw<
      {
        kms_provider: string;
        kms_key_ref: string;
        kms_key_version: string | null;
        versions: bigint;
      }[]
    >`
      SELECT ek."kms_provider", ek."kms_key_ref", sv."kms_key_version", count(*) AS "versions"
      FROM "secret_versions" sv
      JOIN "encryption_keys" ek
        ON ek."workspace_id" = sv."workspace_id" AND ek."id" = sv."encryption_key_id"
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3`;
    return rows.map((r) => ({
      kmsProvider: r.kms_provider,
      kmsKeyRef: r.kms_key_ref,
      kmsKeyVersion: r.kms_key_version,
      versions: Number(r.versions),
    }));
  }

  /**
   * Proposed values in change requests are envelopes too, but carry no key
   * version, so they cannot be rewrapped or counted per version yet.
   */
  changeRequestEnvelopes(): Promise<number> {
    return this.db.changeRequestItem.count({ where: { ciphertext: { not: null } } });
  }

  count(query: EnvelopeQuery): Promise<number> {
    return this.db.secretVersion.count({ where: where(query) });
  }

  /** One page in id order; pass the last id back as `afterId` for the next page. */
  async page(query: EnvelopeQuery, limit: number, afterId?: string): Promise<StoredEnvelopeRow[]> {
    const rows = await this.db.secretVersion.findMany({
      where: where(query, afterId),
      orderBy: { id: 'asc' },
      take: limit,
      select: envelopeSelect,
    });
    return rows.map(({ encryptionKey, secret, ...row }) => ({
      ...row,
      kmsProvider: encryptionKey.kmsProvider,
      kmsKeyRef: encryptionKey.kmsKeyRef,
      projectId: secret.projectId,
      environmentId: secret.environmentId,
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      authTag: Buffer.from(row.authTag),
      encryptedDataKey: Buffer.from(row.encryptedDataKey),
    }));
  }

  /**
   * Replaces the wrapped data key of one version, only if it still holds the
   * wrapped key and key version that were read (compare and set). Returns
   * false when someone else changed it first. The immutability trigger keeps
   * every other column, including the ciphertext, unchanged.
   */
  async replaceWrappedKey(
    id: string,
    expected: { kmsKeyVersion: string | null; encryptedDataKey: Buffer },
    next: { kmsKeyVersion: string; encryptedDataKey: Buffer },
    now = new Date(),
  ): Promise<boolean> {
    const result = await this.db.secretVersion.updateMany({
      where: {
        id,
        kmsKeyVersion: expected.kmsKeyVersion,
        encryptedDataKey: { equals: new Uint8Array(expected.encryptedDataKey) },
      },
      data: {
        kmsKeyVersion: next.kmsKeyVersion,
        encryptedDataKey: new Uint8Array(next.encryptedDataKey),
        rewrappedAt: now,
      },
    });
    return result.count === 1;
  }
}
