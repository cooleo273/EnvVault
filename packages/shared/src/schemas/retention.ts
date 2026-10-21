import { z } from 'zod';

export const RETENTION_LIMITS = {
  maxDays: 3650,
  /** Audit events are kept at least this long whatever the policy says. */
  minAuditDays: 90,
  maxKeepVersions: 1000,
  /** Rows counted by a preview; larger numbers show as "at least". */
  previewCap: 10_000,
} as const;

export const RETENTION_ERROR_CODES = {
  RETENTION_RUN_ACTIVE: 'RETENTION_RUN_ACTIVE',
  RETENTION_POLICY_EMPTY: 'RETENTION_POLICY_EMPTY',
} as const;

const days = (min: number) => z.number().int().min(min).max(RETENTION_LIMITS.maxDays).nullable();

export const retentionPolicyInputSchema = z
  .object({
    /** Deleted variables are purged this many days after deletion. */
    deletedSecretDays: days(1),
    /** Each variable keeps at least this many newest versions. */
    versionKeepCount: z.number().int().min(1).max(RETENTION_LIMITS.maxKeepVersions).nullable(),
    /** Older versions beyond the kept ones go after this many days. */
    versionMinAgeDays: z.number().int().min(0).max(RETENTION_LIMITS.maxDays).nullable(),
    snapshotDays: days(1),
    auditDays: days(RETENTION_LIMITS.minAuditDays),
    /** Protected environments are left alone unless this is true. */
    includeProtected: z.boolean(),
  })
  .strict()
  .refine((p) => p.versionMinAgeDays === null || p.versionKeepCount !== null, {
    path: ['versionKeepCount'],
    message: 'Set how many versions to keep before an age limit',
  });
export type RetentionPolicyInput = z.infer<typeof retentionPolicyInputSchema>;

const userRefSchema = z
  .object({ displayName: z.string().nullable(), email: z.string() })
  .nullable();

export const retentionPolicySchema = z.object({
  deletedSecretDays: z.number().int().nullable(),
  versionKeepCount: z.number().int().nullable(),
  versionMinAgeDays: z.number().int().nullable(),
  snapshotDays: z.number().int().nullable(),
  auditDays: z.number().int().nullable(),
  includeProtected: z.boolean(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: userRefSchema,
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

export const retentionCountsSchema = z.object({
  deletedSecrets: z.number().int(),
  versions: z.number().int(),
  snapshots: z.number().int(),
  auditEvents: z.number().int(),
});
export type RetentionCounts = z.infer<typeof retentionCountsSchema>;

export const retentionPreviewSchema = z.object({
  counts: retentionCountsSchema,
  /** True when a count reached the preview cap. */
  capped: z.boolean(),
  evaluatedAt: z.iso.datetime(),
});
export type RetentionPreview = z.infer<typeof retentionPreviewSchema>;

export const startRetentionRunInputSchema = z
  .object({
    /** The workspace slug, typed to confirm a permanent deletion. */
    confirm: z.string().min(1).max(100),
  })
  .strict();
export type StartRetentionRunInput = z.infer<typeof startRetentionRunInputSchema>;

export const MAINTENANCE_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const maintenanceJobSchema = z.object({
  id: z.uuid(),
  kind: z.literal('retention'),
  status: z.enum(MAINTENANCE_JOB_STATUSES),
  counts: retentionCountsSchema,
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  requestedBy: userRefSchema,
});
export type MaintenanceJob = z.infer<typeof maintenanceJobSchema>;
