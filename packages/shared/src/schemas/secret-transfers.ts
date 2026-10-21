import { z } from 'zod';
import {
  secretCategorySchema,
  secretKeySchema,
  secretTagSchema,
  secretTypeSchema,
} from './secrets.js';

/**
 * Hard ceilings for bulk operations. The API applies its own configured
 * limits (SECRET_IMPORT_MAX_BYTES and friends), which may only be lower.
 */
export const SECRET_TRANSFER_CEILINGS = {
  importBytes: 1024 * 1024,
  importEntries: 2000,
  bulkItems: 1000,
  exportItems: 2000,
  versionsPerPage: 100,
  changeReasonLength: 500,
} as const;

/** Defaults the API uses when nothing is configured. */
export const SECRET_TRANSFER_DEFAULTS = {
  importBytes: 256 * 1024,
  importEntries: 500,
  bulkItems: 500,
  exportItems: 1000,
} as const;

export const SECRET_TRANSFER_ERROR_CODES = {
  /** At least one selected import entry is invalid, duplicated or out of date. */
  SECRET_IMPORT_REJECTED: 'SECRET_IMPORT_REJECTED',
  SECRET_IMPORT_TOO_LARGE: 'SECRET_IMPORT_TOO_LARGE',
  SECRET_BULK_TOO_LARGE: 'SECRET_BULK_TOO_LARGE',
  /** The selected version is already the current one. */
  SECRET_ROLLBACK_NOOP: 'SECRET_ROLLBACK_NOOP',
  /** The historical value does not satisfy the variable's current type. */
  SECRET_ROLLBACK_TYPE_MISMATCH: 'SECRET_ROLLBACK_TYPE_MISMATCH',
} as const;

export const changeReasonSchema = z
  .string()
  .trim()
  .max(
    SECRET_TRANSFER_CEILINGS.changeReasonLength,
    `Use at most ${String(SECRET_TRANSFER_CEILINGS.changeReasonLength)} characters`,
  );

const importContentSchema = z
  .string()
  .max(SECRET_TRANSFER_CEILINGS.importBytes, 'The file is too large');

/* ------------------------------------------------------------------ Import */

export const IMPORT_ENTRY_STATUSES = [
  /** No live variable with this name. */
  'new',
  /** Exists with the same value (only when the caller may read values). */
  'unchanged',
  /** Exists with a different value (only when the caller may read values). */
  'changed',
  /** Exists; values were not compared because the caller may not read them. */
  'exists',
  /** Invalid name or a value that does not fit the type. */
  'invalid',
  /** The name appears again later in the file; only the last occurrence counts. */
  'duplicate',
] as const;
export type ImportEntryStatus = (typeof IMPORT_ENTRY_STATUSES)[number];

export const importPreviewInputSchema = z.object({
  content: importContentSchema,
  /** Type given to new variables; values with line breaks become MULTILINE. */
  defaultType: secretTypeSchema.default('SECRET'),
});
export type ImportPreviewInput = z.input<typeof importPreviewInputSchema>;

/** One parsed assignment. Never contains the value, only its size. */
export const importEntrySchema = z.object({
  line: z.number().int().min(1),
  key: z.string(),
  status: z.enum(IMPORT_ENTRY_STATUSES),
  problem: z.string().nullable(),
  valueBytes: z.number().int().nonnegative(),
  multiline: z.boolean(),
  /** Type the variable would have after the import. */
  type: secretTypeSchema,
  existing: z
    .object({
      id: z.uuid(),
      type: secretTypeSchema,
      revision: z.number().int(),
      hasValue: z.boolean(),
    })
    .nullable(),
});
export type ImportEntry = z.infer<typeof importEntrySchema>;

export const importPreviewSchema = z.object({
  entries: z.array(importEntrySchema),
  /** Lines that are not comments, blank or assignments; they are ignored. */
  ignoredLines: z.array(z.object({ line: z.number().int(), reason: z.string() })),
  /** False when existing values were not compared (no secret:read here). */
  compared: z.boolean(),
  summary: z.record(z.enum(IMPORT_ENTRY_STATUSES), z.number().int()),
  limits: z.object({ maxBytes: z.number().int(), maxEntries: z.number().int() }),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const importCommitInputSchema = z.object({
  /** The same content that was previewed; it is parsed again on the server. */
  content: importContentSchema,
  defaultType: secretTypeSchema.default('SECRET'),
  /** Applied to variables the import creates. */
  category: secretCategorySchema.optional(),
  tags: z.array(secretTagSchema).max(20).default([]),
  changeReason: changeReasonSchema.optional(),
  /** Selected entries. Anything not listed is skipped. */
  items: z
    .array(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('create'), key: secretKeySchema }),
        z.object({
          action: z.literal('overwrite'),
          key: secretKeySchema,
          expectedRevision: z.number().int().min(1),
        }),
      ]),
    )
    .min(1, 'Select at least one variable')
    .max(SECRET_TRANSFER_CEILINGS.importEntries)
    .refine((items) => new Set(items.map((i) => i.key)).size === items.length, {
      message: 'Each variable can be selected once',
    }),
});
export type ImportCommitInput = z.input<typeof importCommitInputSchema>;

export const importResultSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  secretIds: z.array(z.uuid()),
});
export type ImportResult = z.infer<typeof importResultSchema>;

/* ------------------------------------------------------------------ Export */

export const EXPORT_FORMATS = ['dotenv', 'json', 'yaml'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const exportInputSchema = z.object({
  format: z.enum(EXPORT_FORMATS),
  /** Omit to export every live variable that has a value. */
  secretIds: z
    .array(z.uuid())
    .min(1)
    .max(SECRET_TRANSFER_CEILINGS.exportItems)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate ids' })
    .optional(),
});
export type ExportInput = z.input<typeof exportInputSchema>;

/** Plaintext file content. Sent with `Cache-Control: no-store`; never stored. */
export const exportResultSchema = z.object({
  filename: z.string(),
  mediaType: z.string(),
  format: z.enum(EXPORT_FORMATS),
  count: z.number().int(),
  /** Variables left out (for example without a value). Names only. */
  skipped: z.array(z.object({ key: z.string(), reason: z.string() })),
  /** Values the format cannot represent exactly. Names only. */
  warnings: z.array(z.object({ key: z.string(), message: z.string() })),
  content: z.string(),
});
export type ExportResult = z.infer<typeof exportResultSchema>;

/* ----------------------------------------------------------------- History */

export const SECRET_VERSION_ORIGINS = ['CREATE', 'UPDATE', 'IMPORT', 'ROLLBACK'] as const;

export const secretVersionsQuerySchema = z.object({
  /** Versions with a lower number than this (keyset pagination, newest first). */
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(SECRET_TRANSFER_CEILINGS.versionsPerPage).default(20),
});
export type SecretVersionsQuery = z.input<typeof secretVersionsQuerySchema>;

const userRefSchema = z
  .object({ displayName: z.string().nullable(), email: z.string() })
  .nullable();

/** Version metadata only: never a value. */
export const secretVersionDetailSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  isCurrent: z.boolean(),
  origin: z.enum(SECRET_VERSION_ORIGINS),
  changeReason: z.string().nullable(),
  /** For rollbacks: the version whose value was restored. */
  restoredFromVersion: z.number().int().nullable(),
  /** Key encryption key version that wraps this version's data key. */
  keyVersion: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  createdBy: userRefSchema,
});
export type SecretVersionDetail = z.infer<typeof secretVersionDetailSchema>;

export const secretVersionPageSchema = z.object({
  items: z.array(secretVersionDetailSchema),
  total: z.number().int(),
  nextBefore: z.number().int().nullable(),
});
export type SecretVersionPage = z.infer<typeof secretVersionPageSchema>;

export const revealedVersionSchema = z.object({
  secretId: z.uuid(),
  versionId: z.uuid(),
  version: z.number().int(),
  value: z.string(),
});
export type RevealedVersion = z.infer<typeof revealedVersionSchema>;

export const compareVersionsInputSchema = z
  .object({ fromVersionId: z.uuid(), toVersionId: z.uuid() })
  .refine((v) => v.fromVersionId !== v.toVersionId, { message: 'Pick two different versions' });
export type CompareVersionsInput = z.infer<typeof compareVersionsInputSchema>;

/** Whether two versions hold the same value, computed on the server. No values. */
export const versionComparisonSchema = z.object({
  from: secretVersionDetailSchema,
  to: secretVersionDetailSchema,
  sameValue: z.boolean(),
  fromBytes: z.number().int(),
  toBytes: z.number().int(),
});
export type VersionComparison = z.infer<typeof versionComparisonSchema>;

export const rollbackInputSchema = z.object({
  versionId: z.uuid(),
  expectedRevision: z.number().int().min(1),
  changeReason: changeReasonSchema.optional(),
});
export type RollbackInput = z.infer<typeof rollbackInputSchema>;

/* -------------------------------------------------------------------- Bulk */

const revisionedItems = z
  .array(z.object({ id: z.uuid(), expectedRevision: z.number().int().min(1) }))
  .min(1)
  .max(SECRET_TRANSFER_CEILINGS.bulkItems)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, {
    message: 'Duplicate ids',
  });

export const bulkPatchSchema = z
  .object({
    category: secretCategorySchema.nullable().optional(),
    addTags: z.array(secretTagSchema).max(20).optional(),
    removeTags: z.array(secretTagSchema).max(20).optional(),
    isRequired: z.boolean().optional(),
  })
  .refine(
    (p) => Object.values(p).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0)),
    {
      message: 'Nothing to change',
    },
  );

export const bulkActionInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('delete'), items: revisionedItems }),
  z.object({ action: z.literal('restore'), items: revisionedItems }),
  z.object({ action: z.literal('update'), items: revisionedItems, patch: bulkPatchSchema }),
]);
export type BulkActionInput = z.input<typeof bulkActionInputSchema>;

export const bulkResultSchema = z.object({
  action: z.enum(['delete', 'restore', 'update']),
  count: z.number().int(),
  secretIds: z.array(z.uuid()),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;

/** Every variable matching the list filters, as ids, so a selection can span pages. */
export const secretSelectionSchema = z.object({
  items: z.array(z.object({ id: z.uuid(), key: z.string(), revision: z.number().int() })),
  total: z.number().int(),
  /** True when more variables match than a bulk operation may touch. */
  truncated: z.boolean(),
});
export type SecretSelection = z.infer<typeof secretSelectionSchema>;

export const EXPORT_MEDIA_TYPES: Record<ExportFormat, string> = {
  dotenv: 'text/plain; charset=utf-8',
  json: 'application/json',
  yaml: 'application/yaml',
};
