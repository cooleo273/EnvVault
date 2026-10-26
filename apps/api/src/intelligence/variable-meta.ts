import { timingSafeEqual } from 'node:crypto';
import type { SnapshotEntryData, VariableRow } from '@envvault/database';
import type { MetaField, VariableMeta } from '@envvault/shared';

export function metaFromRow(row: VariableRow): VariableMeta {
  return {
    secretId: row.id,
    key: row.key,
    type: row.type,
    category: row.category,
    tags: row.tags,
    description: row.description,
    isRequired: row.isRequired,
    inheritable: row.inheritable,
    hasValue: row.currentVersionId !== null,
    version: row.currentVersionNumber,
  };
}

export function metaFromEntry(entry: SnapshotEntryData): VariableMeta {
  return {
    secretId: entry.secretId,
    key: entry.key,
    type: entry.type,
    category: entry.category,
    tags: entry.tags,
    description: entry.description,
    isRequired: entry.isRequired,
    inheritable: entry.inheritable,
    hasValue: entry.secretVersionId !== null,
    version: entry.versionNumber,
  };
}

/** Metadata fields that differ between two variables (the value is not considered). */
export function metaDifferences(a: VariableMeta, b: VariableMeta): MetaField[] {
  const fields: MetaField[] = [];
  if (a.type !== b.type) fields.push('type');
  if (a.isRequired !== b.isRequired) fields.push('isRequired');
  if (a.category !== b.category) fields.push('category');
  if ([...a.tags].sort().join(',') !== [...b.tags].sort().join(',')) fields.push('tags');
  if (a.description !== b.description) fields.push('description');
  if (a.inheritable !== b.inheritable) fields.push('inheritable');
  if (a.hasValue !== b.hasValue) fields.push('hasValue');
  return fields;
}

/**
 * Constant time equality of two decrypted values, on the server only. No
 * hash or fingerprint of a value is computed or stored for comparisons.
 */
export function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  try {
    return left.length === right.length && timingSafeEqual(left, right);
  } finally {
    left.fill(0);
    right.fill(0);
  }
}
