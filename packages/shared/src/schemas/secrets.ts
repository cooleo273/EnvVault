import { z } from 'zod';
import {
  normaliseCategory,
  normaliseTag,
  SECRET_CATEGORY_MAX_LENGTH,
  SECRET_CATEGORY_PATTERN,
  SECRET_DESCRIPTION_MAX_LENGTH,
  SECRET_KEY_MAX_LENGTH,
  SECRET_KEY_PATTERN,
  SECRET_MAX_TAGS,
  SECRET_TAG_MAX_LENGTH,
  SECRET_TAG_PATTERN,
  SECRET_TYPES,
  secretValueProblem,
} from '../domain/secrets.js';
import { paginatedSchema } from './projects.js';

/** Error codes (`error.code`) of the secrets API. */
export const SECRET_ERROR_CODES = {
  /** A live variable with this name already exists in the environment. */
  SECRET_KEY_TAKEN: 'SECRET_KEY_TAKEN',
  /** Someone changed the variable since it was read (stale `expectedRevision`). */
  SECRET_CONFLICT: 'SECRET_CONFLICT',
  SECRET_NOT_DELETED: 'SECRET_NOT_DELETED',
  /** The variable exists but has never been given a value. */
  SECRET_VALUE_NOT_SET: 'SECRET_VALUE_NOT_SET',
  /** Switching to a stricter type needs a value of that type. */
  SECRET_VALUE_REQUIRED: 'SECRET_VALUE_REQUIRED',
  /** Keys are not configured or the referenced key version is missing. */
  ENCRYPTION_UNAVAILABLE: 'ENCRYPTION_UNAVAILABLE',
  /** The stored value failed authentication (tampering or a wrong key). */
  SECRET_INTEGRITY_ERROR: 'SECRET_INTEGRITY_ERROR',
} as const;

export const secretTypeSchema = z.enum(SECRET_TYPES);

export const secretKeySchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(SECRET_KEY_MAX_LENGTH, `Use at most ${String(SECRET_KEY_MAX_LENGTH)} characters`)
  .regex(
    SECRET_KEY_PATTERN,
    'Use letters, digits and underscores, starting with a letter or underscore',
  );

const descriptionSchema = z
  .string()
  .trim()
  .max(
    SECRET_DESCRIPTION_MAX_LENGTH,
    `Use at most ${String(SECRET_DESCRIPTION_MAX_LENGTH)} characters`,
  );

export const secretCategorySchema = z
  .string()
  .transform(normaliseCategory)
  .pipe(
    z
      .string()
      .min(1, 'Enter a category')
      .max(
        SECRET_CATEGORY_MAX_LENGTH,
        `Use at most ${String(SECRET_CATEGORY_MAX_LENGTH)} characters`,
      )
      .regex(SECRET_CATEGORY_PATTERN, 'Use letters, digits, spaces and & / . _ -'),
  );

export const secretTagSchema = z
  .string()
  .transform(normaliseTag)
  .pipe(
    z
      .string()
      .min(1, 'Tags cannot be empty')
      .max(SECRET_TAG_MAX_LENGTH, `Use at most ${String(SECRET_TAG_MAX_LENGTH)} characters per tag`)
      .regex(SECRET_TAG_PATTERN, 'Use lowercase letters, digits, dots, dashes and underscores'),
  );

const tagsSchema = z
  .array(secretTagSchema)
  .max(SECRET_MAX_TAGS, `Use at most ${String(SECRET_MAX_TAGS)} tags`)
  .transform((tags) => [...new Set(tags)]);

/** Raw value: any string (the type check runs against the variable's type). */
const valueSchema = z.string();

/** Adds the type check for a value when both are known from the input. */
function checkValue(
  input: { type?: (typeof SECRET_TYPES)[number] | undefined; value?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (input.value === undefined || input.type === undefined) return;
  const problem = secretValueProblem(input.type, input.value);
  if (problem) ctx.addIssue({ code: 'custom', path: ['value'], message: problem });
}

/**
 * New variable. Omitting `value` creates a variable without a value (shown as
 * "not set"); an empty string is a real, empty value.
 */
export const createSecretInputSchema = z
  .object({
    key: secretKeySchema,
    value: valueSchema.optional(),
    type: secretTypeSchema.default('SECRET'),
    description: descriptionSchema.optional(),
    category: secretCategorySchema.optional(),
    tags: tagsSchema.default([]),
    isRequired: z.boolean().default(false),
  })
  .superRefine(checkValue);
export type CreateSecretInput = z.input<typeof createSecretInputSchema>;

/**
 * Partial update. `expectedRevision` is the revision the editor read; the
 * update is refused with 409 SECRET_CONFLICT if the variable changed since.
 * `value` creates a new version; everything else is metadata only.
 */
export const updateSecretInputSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    key: secretKeySchema.optional(),
    value: valueSchema.optional(),
    type: secretTypeSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    category: secretCategorySchema.nullable().optional(),
    tags: tagsSchema.optional(),
    isRequired: z.boolean().optional(),
    /** Stored with the new version when `value` is given; never a secret itself. */
    changeReason: z.string().trim().max(500, 'Use at most 500 characters').optional(),
  })
  .superRefine(checkValue)
  .refine(
    ({ expectedRevision: _revision, changeReason: _reason, ...rest }) =>
      Object.values(rest).some((v) => v !== undefined),
    { message: 'Nothing to update' },
  );
export type UpdateSecretInput = z.input<typeof updateSecretInputSchema>;

/** Optional guard for delete: refuse if the variable changed since it was read. */
export const deleteSecretQuerySchema = z.object({
  expectedRevision: z.coerce.number().int().min(1).optional(),
});

export const SECRET_SORTS = ['name', 'type', 'category', 'created', 'updated'] as const;

/** Comma separated list parameter, e.g. `?type=SECRET,JSON`. */
const csvSchema = z
  .string()
  .max(2000)
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

export const listSecretsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  /** Matches names and descriptions, case insensitive. */
  q: z.string().trim().max(100).optional(),
  /** Comma separated types. */
  type: csvSchema.pipe(z.array(secretTypeSchema).max(SECRET_TYPES.length)).optional(),
  /** Comma separated categories; `none` matches variables without one. */
  category: csvSchema.pipe(z.array(z.string().max(SECRET_CATEGORY_MAX_LENGTH)).max(20)).optional(),
  tag: secretTagSchema.optional(),
  status: z.enum(['active', 'deleted']).default('active'),
  sort: z.enum(SECRET_SORTS).default('name'),
  order: z.enum(['asc', 'desc']).optional(),
});
/** Client side form of the list query; arrays are sent comma separated. */
export interface ListSecretsQuery {
  page?: number | undefined;
  pageSize?: number | undefined;
  q?: string | undefined;
  type?: (typeof SECRET_TYPES)[number][] | undefined;
  category?: string[] | undefined;
  tag?: string | undefined;
  status?: 'active' | 'deleted' | undefined;
  sort?: (typeof SECRET_SORTS)[number] | undefined;
  order?: 'asc' | 'desc' | undefined;
}

const userRefSchema = z
  .object({ displayName: z.string().nullable(), email: z.string() })
  .nullable();

/** Metadata of one variable. Never contains the value or any ciphertext. */
export const secretSummarySchema = z.object({
  id: z.uuid(),
  environmentId: z.uuid(),
  key: z.string(),
  description: z.string().nullable(),
  type: secretTypeSchema,
  category: z.string().nullable(),
  tags: z.array(z.string()),
  isRequired: z.boolean(),
  status: z.enum(['ACTIVE', 'DELETED']),
  /** False until a value has been stored. */
  hasValue: z.boolean(),
  /** Number of the current value version, null without a value. */
  currentVersion: z.number().int().nullable(),
  /** Pass back as `expectedRevision` when updating. */
  revision: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  createdBy: userRefSchema,
  updatedBy: userRefSchema,
  deletedBy: userRefSchema,
});
export type SecretSummary = z.infer<typeof secretSummarySchema>;

export const secretListSchema = paginatedSchema(secretSummarySchema).extend({
  /** Categories and tags in use in this environment (for filters). */
  facets: z.object({ categories: z.array(z.string()), tags: z.array(z.string()) }),
});
export type SecretList = z.infer<typeof secretListSchema>;

/** Result of an authorized, audited reveal. Sent with `Cache-Control: no-store`. */
export const revealedSecretSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  type: secretTypeSchema,
  version: z.number().int(),
  value: z.string(),
});
export type RevealedSecret = z.infer<typeof revealedSecretSchema>;

export const createdSecretSchema = z.object({ id: z.uuid(), revision: z.number().int() });
export type CreatedSecret = z.infer<typeof createdSecretSchema>;
