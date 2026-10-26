import { z } from 'zod';
import { patternProblem } from '../domain/safe-pattern.js';
import { SECRET_KEY_PATTERN } from '../domain/secrets.js';
import { secretTypeSchema } from './secrets.js';

/** Bounds for environment intelligence features. */
export const INTELLIGENCE_LIMITS = {
  /** Variables per environment considered by comparison, readiness and snapshots. */
  variables: 2000,
  validationRules: 200,
  snapshotDescription: 500,
  pageSize: 200,
} as const;

export const INTELLIGENCE_ERROR_CODES = {
  /** The requested base environment cannot be used (see message). */
  INHERITANCE_INVALID: 'INHERITANCE_INVALID',
  /** The environment has more variables than the feature handles at once. */
  ENVIRONMENT_TOO_LARGE: 'ENVIRONMENT_TOO_LARGE',
  /** The environment changed since the restore preview. */
  SNAPSHOT_STALE: 'SNAPSHOT_STALE',
  /** The restore cannot be applied as is (for example a name is in use). */
  SNAPSHOT_RESTORE_BLOCKED: 'SNAPSHOT_RESTORE_BLOCKED',
} as const;

const userRefSchema = z
  .object({ displayName: z.string().nullable(), email: z.string() })
  .nullable();

const environmentRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  isProtected: z.boolean(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
});
export type EnvironmentRef = z.infer<typeof environmentRefSchema>;

/** Variable metadata used by comparisons, snapshots and drift. Never a value. */
export const variableMetaSchema = z.object({
  secretId: z.uuid(),
  key: z.string(),
  type: secretTypeSchema,
  category: z.string().nullable(),
  tags: z.array(z.string()),
  description: z.string().nullable(),
  isRequired: z.boolean(),
  inheritable: z.boolean(),
  hasValue: z.boolean(),
  /** Version number of the value, null without a value. */
  version: z.number().int().nullable(),
});
export type VariableMeta = z.infer<typeof variableMetaSchema>;

export const META_FIELDS = [
  'type',
  'isRequired',
  'category',
  'tags',
  'description',
  'inheritable',
  'hasValue',
] as const;
export type MetaField = (typeof META_FIELDS)[number];

/**
 * Value equality, only when explicitly requested and authorized:
 * `not_checked` (default), `equal`, `different`, or `not_comparable` when a
 * side has no value.
 */
export const VALUE_COMPARISONS = ['not_checked', 'equal', 'different', 'not_comparable'] as const;
export type ValueComparison = (typeof VALUE_COMPARISONS)[number];

/* -------------------------------------------------------------- Comparison */

export const COMPARISON_STATUSES = ['both', 'only_source', 'only_target'] as const;

export const compareEnvironmentsInputSchema = z
  .object({
    sourceEnvironmentId: z.uuid(),
    targetEnvironmentId: z.uuid(),
    /** Compares values on the server (needs secret:read in both environments). */
    compareValues: z.boolean().default(false),
    q: z.string().trim().max(100).optional(),
    filter: z.enum(['all', 'differences', ...COMPARISON_STATUSES, 'metadata']).default('all'),
    page: z.number().int().min(1).max(10_000).default(1),
    pageSize: z.number().int().min(1).max(INTELLIGENCE_LIMITS.pageSize).default(100),
  })
  .refine((v) => v.sourceEnvironmentId !== v.targetEnvironmentId, {
    message: 'Pick two different environments',
    path: ['targetEnvironmentId'],
  });
export type CompareEnvironmentsInput = z.input<typeof compareEnvironmentsInputSchema>;

export const comparisonRowSchema = z.object({
  key: z.string(),
  status: z.enum(COMPARISON_STATUSES),
  source: variableMetaSchema.nullable(),
  target: variableMetaSchema.nullable(),
  /** Metadata fields that differ (only for `both`). */
  differences: z.array(z.enum(META_FIELDS)),
  value: z.enum(VALUE_COMPARISONS),
});
export type ComparisonRow = z.infer<typeof comparisonRowSchema>;

export const environmentComparisonSchema = z.object({
  source: environmentRefSchema,
  target: environmentRefSchema,
  valuesCompared: z.boolean(),
  summary: z.object({
    both: z.number().int(),
    onlySource: z.number().int(),
    onlyTarget: z.number().int(),
    typeMismatch: z.number().int(),
    requiredMismatch: z.number().int(),
    metadataMismatch: z.number().int(),
    valuesEqual: z.number().int(),
    valuesDifferent: z.number().int(),
  }),
  items: z.array(comparisonRowSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type EnvironmentComparison = z.infer<typeof environmentComparisonSchema>;

/* ------------------------------------------------------------- Inheritance */

export const updateInheritanceInputSchema = z.object({
  /** null removes the base environment. */
  baseEnvironmentId: z.uuid().nullable(),
});
export type UpdateInheritanceInput = z.infer<typeof updateInheritanceInputSchema>;

export const BASE_STATES = ['ok', 'archived', 'deleted', 'protected', 'no_access'] as const;

export const effectiveVariableSchema = z.object({
  key: z.string(),
  /** `local`: defined here. `inherited`: from the base environment. */
  source: z.enum(['local', 'inherited']),
  /** A local variable that replaces an inheritable one of the base. */
  overridesInherited: z.boolean(),
  meta: variableMetaSchema,
  environmentId: z.uuid(),
});
export type EffectiveVariable = z.infer<typeof effectiveVariableSchema>;

export const effectiveConfigurationSchema = z.object({
  environmentId: z.uuid(),
  base: environmentRefSchema.extend({ state: z.enum(BASE_STATES) }).nullable(),
  items: z.array(effectiveVariableSchema),
  summary: z.object({
    local: z.number().int(),
    inherited: z.number().int(),
    overridden: z.number().int(),
  }),
});
export type EffectiveConfiguration = z.infer<typeof effectiveConfigurationSchema>;

/* -------------------------------------------------------- Validation rules */

export const VALUE_FORMATS = ['ANY', 'URL', 'JSON', 'NUMBER'] as const;
export type ValueFormat = (typeof VALUE_FORMATS)[number];

/** The key of the naming rule that applies to every variable name. */
export const NAMING_RULE_KEY = '*';

export const validationRuleInputSchema = z
  .object({
    key: z
      .string()
      .trim()
      .max(256)
      .refine((k) => k === NAMING_RULE_KEY || SECRET_KEY_PATTERN.test(k), {
        message: 'Use a variable name, or * for the naming rule',
      }),
    required: z.boolean().default(false),
    allowEmpty: z.boolean().default(true),
    format: z.enum(VALUE_FORMATS).default('ANY'),
    minNumber: z.number().nullable().default(null),
    maxNumber: z.number().nullable().default(null),
    minLength: z.number().int().min(0).max(65_536).nullable().default(null),
    maxLength: z.number().int().min(0).max(65_536).nullable().default(null),
    pattern: z.string().max(200).nullable().default(null),
    allowedValues: z.array(z.string().max(256)).max(50).default([]),
    description: z.string().trim().max(500).nullable().default(null),
  })
  .superRefine((rule, ctx) => {
    if (rule.pattern !== null) {
      const problem = patternProblem(rule.pattern);
      if (problem) ctx.addIssue({ code: 'custom', path: ['pattern'], message: problem });
    }
    if (rule.key === NAMING_RULE_KEY && (rule.pattern === null || rule.required)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: 'The naming rule needs a pattern and cannot be required',
      });
    }
    if (rule.minLength !== null && rule.maxLength !== null && rule.minLength > rule.maxLength) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLength'],
        message: 'Must be at least the minimum',
      });
    }
    if (rule.minNumber !== null && rule.maxNumber !== null && rule.minNumber > rule.maxNumber) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxNumber'],
        message: 'Must be at least the minimum',
      });
    }
  });
export type ValidationRuleInput = z.input<typeof validationRuleInputSchema>;

export const replaceValidationRulesInputSchema = z.object({
  rules: z
    .array(validationRuleInputSchema)
    .max(INTELLIGENCE_LIMITS.validationRules)
    .refine((rules) => new Set(rules.map((r) => r.key)).size === rules.length, {
      message: 'Each variable can have one rule',
    }),
});
export type ReplaceValidationRulesInput = z.input<typeof replaceValidationRulesInputSchema>;

export const validationRuleSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  required: z.boolean(),
  allowEmpty: z.boolean(),
  format: z.enum(VALUE_FORMATS),
  minNumber: z.number().nullable(),
  maxNumber: z.number().nullable(),
  minLength: z.number().int().nullable(),
  maxLength: z.number().int().nullable(),
  pattern: z.string().nullable(),
  allowedValues: z.array(z.string()),
  description: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  updatedBy: userRefSchema,
});
export type ValidationRule = z.infer<typeof validationRuleSchema>;

/* --------------------------------------------------------------- Readiness */

export const READINESS_STATUSES = ['READY', 'WARNING', 'BLOCKED', 'UNKNOWN'] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const readinessInputSchema = z.object({
  /** Decrypts values on the server to check value rules (needs secret:read). */
  inspectValues: z.boolean().default(false),
});
export type ReadinessInput = z.input<typeof readinessInputSchema>;

export const readinessIssueSchema = z.object({
  severity: z.enum(['blocking', 'warning', 'unknown']),
  code: z.string(),
  key: z.string().nullable(),
  message: z.string(),
  remediation: z.string(),
});
export type ReadinessIssue = z.infer<typeof readinessIssueSchema>;

export const readinessReportSchema = z.object({
  environmentId: z.uuid(),
  status: z.enum(READINESS_STATUSES),
  evaluatedAt: z.iso.datetime(),
  /** True when values were decrypted and checked on the server. */
  valuesInspected: z.boolean(),
  coverage: z.object({ required: z.number().int(), present: z.number().int() }),
  counts: z.object({
    blocking: z.number().int(),
    warning: z.number().int(),
    unknown: z.number().int(),
  }),
  checks: z.array(
    z.object({
      name: z.string(),
      outcome: z.enum(['passed', 'failed', 'warning', 'skipped']),
      detail: z.string(),
    }),
  ),
  issues: z.array(readinessIssueSchema),
});
export type ReadinessReport = z.infer<typeof readinessReportSchema>;

/* --------------------------------------------------------------- Snapshots */

export const createSnapshotInputSchema = z.object({
  description: z.string().trim().max(INTELLIGENCE_LIMITS.snapshotDescription).optional(),
});
export type CreateSnapshotInput = z.input<typeof createSnapshotInputSchema>;

export const snapshotSummarySchema = z.object({
  id: z.uuid(),
  environmentId: z.uuid(),
  description: z.string().nullable(),
  status: z.enum(['COMPLETE']),
  schemaVersion: z.number().int(),
  entryCount: z.number().int(),
  baseEnvironmentId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  createdBy: userRefSchema,
});
export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;

export const snapshotDetailSchema = snapshotSummarySchema.extend({
  entries: z.array(variableMetaSchema),
});
export type SnapshotDetail = z.infer<typeof snapshotDetailSchema>;

export const listSnapshotsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const snapshotPageSchema = z.object({
  items: z.array(snapshotSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type SnapshotPage = z.infer<typeof snapshotPageSchema>;

export const DIFF_CHANGES = ['added', 'removed', 'modified', 'unchanged'] as const;

export const snapshotDiffInputSchema = z.object({
  /** Another snapshot of the same environment; omit to compare with the current state. */
  againstSnapshotId: z.uuid().optional(),
  compareValues: z.boolean().default(false),
});
export type SnapshotDiffInput = z.input<typeof snapshotDiffInputSchema>;

export const diffRowSchema = z.object({
  key: z.string(),
  change: z.enum(DIFF_CHANGES),
  /** Metadata fields (or the name) that changed. */
  fields: z.array(z.enum([...META_FIELDS, 'key'])),
  /** A different version is referenced. It does not prove the value differs. */
  versionChanged: z.boolean(),
  value: z.enum(VALUE_COMPARISONS),
  from: variableMetaSchema.nullable(),
  to: variableMetaSchema.nullable(),
});
export type DiffRow = z.infer<typeof diffRowSchema>;

export const snapshotDiffSchema = z.object({
  fromSnapshotId: z.uuid(),
  /** null means the environment's current state. */
  toSnapshotId: z.uuid().nullable(),
  valuesCompared: z.boolean(),
  summary: z.object({
    added: z.number().int(),
    removed: z.number().int(),
    modified: z.number().int(),
    unchanged: z.number().int(),
    versionChanged: z.number().int(),
  }),
  items: z.array(diffRowSchema),
});
export type SnapshotDiff = z.infer<typeof snapshotDiffSchema>;

export const RESTORE_ACTIONS = ['unchanged', 'update', 'undelete', 'delete'] as const;

export const restorePreviewSchema = z.object({
  snapshotId: z.uuid(),
  actions: z.array(
    z.object({
      secretId: z.uuid(),
      key: z.string(),
      action: z.enum(RESTORE_ACTIONS),
      /** Metadata fields (or the name) that will change. */
      fields: z.array(z.enum([...META_FIELDS, 'key'])),
      /** A new version is created from the snapshot's version. */
      restoresValue: z.boolean(),
    }),
  ),
  /** Blocking: the restore is refused while any exist. */
  conflicts: z.array(z.object({ key: z.string(), reason: z.string() })),
  /** Not blocking: what the restore cannot do exactly. */
  warnings: z.array(z.object({ key: z.string(), reason: z.string() })),
  /** Live variables and revisions the preview was built from; send them back to restore. */
  expectedState: z.array(z.object({ id: z.uuid(), revision: z.number().int() })),
  counts: z.object({
    update: z.number().int(),
    undelete: z.number().int(),
    delete: z.number().int(),
    unchanged: z.number().int(),
    valueRestores: z.number().int(),
  }),
  requiresStepUp: z.boolean(),
});
export type RestorePreview = z.infer<typeof restorePreviewSchema>;

export const restoreSnapshotInputSchema = z.object({
  expectedState: z
    .array(z.object({ id: z.uuid(), revision: z.number().int().min(1) }))
    .max(INTELLIGENCE_LIMITS.variables),
  /** Delete live variables created after the snapshot (exact restore). */
  removeAdded: z.boolean(),
  changeReason: z.string().trim().max(500).optional(),
});
export type RestoreSnapshotInput = z.input<typeof restoreSnapshotInputSchema>;

export const restorePreviewInputSchema = z.object({ removeAdded: z.boolean().default(true) });
export type RestorePreviewInput = z.input<typeof restorePreviewInputSchema>;

export const restoreResultSchema = z.object({
  snapshotId: z.uuid(),
  updated: z.number().int(),
  undeleted: z.number().int(),
  deleted: z.number().int(),
  valueRestores: z.number().int(),
});
export type RestoreResult = z.infer<typeof restoreResultSchema>;
