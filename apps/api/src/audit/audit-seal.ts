import type { IntegrityKeys } from '@envvault/crypto';
import type { SealableEvent } from '@envvault/database';

export const PLATFORM_CHAIN = 'platform';
export const GENESIS_MAC = Buffer.alloc(32);
const DOMAIN = Buffer.from('envvault/audit-seal/v1\n', 'utf8');

export function chainOf(event: Pick<SealableEvent, 'workspaceId'>): string {
  return event.workspaceId?.toLowerCase() ?? PLATFORM_CHAIN;
}

/** JSON with object keys sorted at every level, so equal content always encodes equally. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The bytes one seal authenticates: its chain, position and predecessor's
 * MAC (so removing, reordering or editing any sealed event breaks every MAC
 * after it), plus every column of the event.
 */
export function sealInput(
  chainId: string,
  seq: bigint,
  previous: Buffer,
  event: SealableEvent,
): Buffer {
  const position = Buffer.alloc(8);
  position.writeBigUInt64BE(seq);
  const record = canonicalJson({
    id: event.id.toLowerCase(),
    workspaceId: event.workspaceId,
    occurredAt: event.occurredAt.toISOString(),
    actorType: event.actorType,
    actorUserId: event.actorUserId,
    actorServiceIdentityId: event.actorServiceIdentityId,
    action: event.action,
    outcome: event.outcome,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    projectId: event.projectId,
    environmentId: event.environmentId,
    requestId: event.requestId,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    metadata: event.metadata,
  });
  return Buffer.concat([
    DOMAIN,
    Buffer.from(`${chainId}\n`, 'utf8'),
    position,
    previous,
    Buffer.from(record, 'utf8'),
  ]);
}

export function sealMac(
  keys: IntegrityKeys,
  chainId: string,
  seq: bigint,
  previous: Buffer,
  event: SealableEvent,
  keyId = keys.activeKeyId,
): Buffer {
  return keys.mac('audit-seal', sealInput(chainId, seq, previous, event), keyId);
}
