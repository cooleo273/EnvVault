import { createHash } from 'node:crypto';
import type { ManagedVariableRecord } from '@envvault/database';
import type { SyncAction, SyncPlanItem } from '@envvault/shared';
import type { VercelTarget, VercelVariable } from './vercel-client.js';

/** Where a mapping writes in Vercel. */
export interface MappingSlot {
  target: 'DEVELOPMENT' | 'PREVIEW' | 'PRODUCTION' | 'CUSTOM';
  gitBranch: string | null;
  customEnvironmentId: string | null;
}

export interface SourceVariable {
  secretId: string;
  key: string;
  versionId: string | null;
  type: string;
}

export interface PlannedItem extends SyncPlanItem {
  secretId: string | null;
  versionId: string | null;
  /** The provider variable to update or remove (null for creates). */
  providerVariableId: string | null;
  providerUpdatedAt: number | null;
  sensitive: boolean;
}

export interface Plan {
  items: PlannedItem[];
  unrelated: number;
  hash: string;
}

const vercelTarget = (slot: MappingSlot): VercelTarget | null =>
  slot.target === 'CUSTOM' ? null : (slot.target.toLowerCase() as VercelTarget);

/** The provider variable applies to this mapping's slot (possibly among others). */
export function inSlot(v: VercelVariable, slot: MappingSlot): boolean {
  if (slot.target === 'CUSTOM') {
    return (
      slot.customEnvironmentId !== null && v.customEnvironmentIds.includes(slot.customEnvironmentId)
    );
  }
  const target = vercelTarget(slot);
  if (!target || !v.target.includes(target)) return false;
  return slot.target === 'PREVIEW'
    ? (v.gitBranch ?? null) === slot.gitBranch
    : v.gitBranch === null;
}

/** The provider variable applies to this slot only, so changing it affects nothing else. */
export function onlyInSlot(v: VercelVariable, slot: MappingSlot): boolean {
  if (!inSlot(v, slot)) return false;
  if (slot.target === 'CUSTOM') return v.target.length === 0 && v.customEnvironmentIds.length === 1;
  return v.target.length === 1 && v.customEnvironmentIds.length === 0;
}

function item(key: string, action: SyncAction, extra: Partial<PlannedItem> = {}): PlannedItem {
  return {
    key,
    action,
    conflict: null,
    needsOverwrite: false,
    needsRemoval: false,
    secretId: null,
    versionId: null,
    providerVariableId: null,
    providerUpdatedAt: null,
    sensitive: false,
    ...extra,
  };
}

/**
 * Compares EnvVault's variables with the provider's and with what EnvVault
 * wrote last time. No values are involved: "changed" means a new EnvVault
 * version since the last push, and "changed externally" means the provider's
 * `updatedAt` moved since EnvVault's last write. Provider variables EnvVault
 * neither manages nor shares a key with are only counted.
 */
export function planSync(
  slot: MappingSlot,
  source: SourceVariable[],
  provider: VercelVariable[],
  managed: ManagedVariableRecord[],
): Plan {
  const byId = new Map(provider.map((v) => [v.id, v]));
  const slotVars = provider.filter((v) => inSlot(v, slot));
  const slotByKey = new Map(slotVars.map((v) => [v.key, v]));
  const managedByKey = new Map(managed.map((m) => [m.key, m]));
  const sourceKeys = new Set(source.map((s) => s.key));
  const items: PlannedItem[] = [];
  // Sensitive values cannot be read back in the Vercel dashboard; Development does not support them.
  const sensitiveAllowed = slot.target !== 'DEVELOPMENT';

  for (const s of [...source].sort((a, b) => a.key.localeCompare(b.key))) {
    const base = {
      secretId: s.secretId,
      versionId: s.versionId,
      sensitive: sensitiveAllowed && s.type === 'SECRET',
    };
    const m = managedByKey.get(s.key);
    const current = m ? byId.get(m.providerVariableId) : undefined;
    if (m && current) {
      const ref = { providerVariableId: current.id, providerUpdatedAt: current.updatedAt };
      if (BigInt(current.updatedAt) !== m.providerUpdatedAt) {
        items.push(
          item(s.key, 'conflict', {
            ...base,
            ...ref,
            conflict: 'changed_externally',
            needsOverwrite: true,
          }),
        );
      } else if (!onlyInSlot(current, slot)) {
        items.push(item(s.key, 'conflict', { ...base, ...ref, conflict: 'shared_target' }));
      } else if (m.secretVersionId !== s.versionId) {
        items.push(item(s.key, 'update', { ...base, ...ref }));
      } else {
        items.push(item(s.key, 'unchanged', { ...base, ...ref }));
      }
      continue;
    }
    // Not managed, or EnvVault's variable was deleted in the provider.
    const existing = slotByKey.get(s.key);
    if (existing) {
      const ref = { providerVariableId: existing.id, providerUpdatedAt: existing.updatedAt };
      items.push(
        onlyInSlot(existing, slot)
          ? item(s.key, 'conflict', {
              ...base,
              ...ref,
              conflict: 'unmanaged',
              needsOverwrite: true,
            })
          : item(s.key, 'conflict', { ...base, ...ref, conflict: 'shared_target' }),
      );
    } else {
      items.push(item(s.key, 'create', base));
    }
  }

  for (const m of [...managed].sort((a, b) => a.key.localeCompare(b.key))) {
    if (sourceKeys.has(m.key)) continue;
    const current = byId.get(m.providerVariableId);
    if (!current) {
      // Already gone from the provider: removing only forgets the record.
      items.push(item(m.key, 'remove', { needsRemoval: true }));
    } else if (BigInt(current.updatedAt) !== m.providerUpdatedAt) {
      items.push(
        item(m.key, 'conflict', {
          conflict: 'changed_externally',
          needsOverwrite: true,
          needsRemoval: true,
          providerVariableId: current.id,
          providerUpdatedAt: current.updatedAt,
        }),
      );
    } else {
      items.push(
        item(m.key, 'remove', {
          needsRemoval: true,
          providerVariableId: current.id,
          providerUpdatedAt: current.updatedAt,
        }),
      );
    }
  }

  const involved = new Set([...sourceKeys, ...managedByKey.keys()]);
  const unrelated = slotVars.filter((v) => !involved.has(v.key)).length;
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        slot,
        items.map((i) => [
          i.key,
          i.action,
          i.conflict,
          i.versionId,
          i.providerVariableId,
          i.providerUpdatedAt,
        ]),
      ]),
    )
    .digest('hex');
  return { items, unrelated, hash };
}

export interface SyncDecision {
  item: PlannedItem;
  operation: 'create' | 'update' | 'delete' | 'forget' | 'none';
}

/** What a confirmed run does with each planned item under the chosen options. */
export function decide(
  items: PlannedItem[],
  options: { overwrite: boolean; removeManaged: boolean },
): SyncDecision[] {
  return items.map((i): SyncDecision => {
    switch (i.action) {
      case 'create':
        return { item: i, operation: 'create' };
      case 'update':
        return { item: i, operation: 'update' };
      case 'remove':
        if (!options.removeManaged) return { item: i, operation: 'none' };
        return { item: i, operation: i.providerVariableId ? 'delete' : 'forget' };
      case 'conflict':
        if (i.conflict === 'shared_target' || !options.overwrite)
          return { item: i, operation: 'none' };
        if (i.needsRemoval)
          return { item: i, operation: options.removeManaged ? 'delete' : 'none' };
        return { item: i, operation: 'update' };
      default:
        return { item: i, operation: 'none' };
    }
  });
}
