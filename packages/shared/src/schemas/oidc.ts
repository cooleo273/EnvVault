import { z } from 'zod';
import { MACHINE_LIMITS, MACHINE_SCOPES, machineScopeSchema } from './machine.js';

/**
 * GitHub Actions OIDC trust bindings: which workflows may authenticate as a
 * machine identity, and the exchange of a GitHub OIDC token for a machine
 * access token. See docs/integrations/github-oidc.md.
 */

export const OIDC_LIMITS = {
  /** Live (unrevoked) bindings per machine identity. */
  maxBindingsPerIdentity: 20,
  defaultBindingLifetimeDays: 365,
  maxBindingLifetimeDays: 365,
  maxListEntries: 20,
  /** Longest identity token accepted (raw JWT length). */
  maxTokenLength: 8192,
  /** Longest `exp - iat` accepted. GitHub issues tokens valid for minutes. */
  maxTokenLifetimeSeconds: 3600,
  clockToleranceSeconds: 30,
} as const;

export const OIDC_ERROR_CODES = {
  /** Malformed, badly signed, wrong audience or otherwise unverifiable token. */
  OIDC_TOKEN_INVALID: 'OIDC_TOKEN_INVALID',
  OIDC_TOKEN_EXPIRED: 'OIDC_TOKEN_EXPIRED',
  /** The token's issuer is not on this API's allowlist. */
  OIDC_ISSUER_NOT_TRUSTED: 'OIDC_ISSUER_NOT_TRUSTED',
  /** The same token was already exchanged (when replay is tracked). */
  OIDC_TOKEN_REPLAYED: 'OIDC_TOKEN_REPLAYED',
  /** The issuer's keys could not be fetched; nothing is decided without them. */
  OIDC_PROVIDER_UNAVAILABLE: 'OIDC_PROVIDER_UNAVAILABLE',
  /** Verified, but no enabled binding accepts this workflow. */
  OIDC_NO_MATCHING_BINDING: 'OIDC_NO_MATCHING_BINDING',
  /** More than one binding accepts it; name one with `bindingId`. */
  OIDC_BINDING_AMBIGUOUS: 'OIDC_BINDING_AMBIGUOUS',
  /** A protected environment needs a stricter binding. */
  OIDC_PROTECTED_POLICY_REQUIRED: 'OIDC_PROTECTED_POLICY_REQUIRED',
  OIDC_BINDING_LIMIT_REACHED: 'OIDC_BINDING_LIMIT_REACHED',
  OIDC_BINDING_DISABLED: 'OIDC_BINDING_DISABLED',
} as const;

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !CONTROL.test(v), 'Remove control characters');

const githubIdSchema = z
  .string()
  .trim()
  .regex(
    /^[1-9][0-9]{0,19}$/,
    'Use the numeric id GitHub shows (for example in the repository API)',
  );
const refSchema = z
  .string()
  .trim()
  .regex(
    /^refs\/[A-Za-z0-9._/-]+\*?$/,
    'Use a full ref such as refs/heads/main or refs/tags/v*; a single * may end it',
  )
  .max(512);
const eventSchema = z
  .string()
  .trim()
  .regex(/^[a-z_]{1,64}$/, 'Use a GitHub event name such as push or workflow_dispatch')
  .refine((v) => v !== 'pull_request_target', {
    message:
      'pull_request_target runs fork code with the repository’s permissions and is never accepted',
  });
const workflowPathSchema = z
  .string()
  .trim()
  .regex(
    /^\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml$/,
    'Use the workflow file path, for example .github/workflows/deploy.yml',
  );
const jobWorkflowRefSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml@[A-Za-z0-9._/-]+$/,
    'Use owner/repo/.github/workflows/file.yml@ref, ideally pinned to a commit SHA',
  )
  .max(1024);
const audienceSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'Use printable characters without spaces');
const issuerSchema = z.url({ protocol: /^https?$/ }).max(2048);
const unique = (values: unknown[]) => new Set(values).size === values.length;
const list = <T extends z.ZodType>(item: T) =>
  z.array(item).max(OIDC_LIMITS.maxListEntries).refine(unique, 'Each value once');

const scopesSchema = z
  .array(machineScopeSchema)
  .min(1, 'Choose at least one scope')
  .max(MACHINE_SCOPES.length)
  .refine(unique, 'Each scope once');

const conditionFields = {
  workflowPath: workflowPathSchema.nullable().optional(),
  jobWorkflowRef: jobWorkflowRefSchema.nullable().optional(),
  refs: list(refSchema).optional(),
  githubEnvironments: list(text(255)).optional(),
  eventNames: list(eventSchema).optional(),
  subject: text(512).nullable().optional(),
  environmentIds: z
    .array(z.uuid())
    .min(1, 'Choose at least one environment')
    .max(MACHINE_LIMITS.maxTokenEnvironments)
    .refine(unique, 'Each environment once'),
};

export const createOidcTrustBindingInputSchema = z
  .object({
    identityId: z.uuid(),
    name: text(100),
    /** Default: GitHub's issuer. Must be on the API's allowlist. */
    issuer: issuerSchema.optional(),
    audience: audienceSchema,
    repositoryId: githubIdSchema,
    repositoryOwnerId: githubIdSchema,
    repositoryName: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use owner/name')
      .max(200),
    scopes: scopesSchema.default([...MACHINE_SCOPES]),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(OIDC_LIMITS.maxBindingLifetimeDays)
      .default(OIDC_LIMITS.defaultBindingLifetimeDays),
    ...conditionFields,
  })
  .strict();
export type CreateOidcTrustBindingInput = z.input<typeof createOidcTrustBindingInputSchema>;

/** Issuer, audience, repository ids and scopes are fixed; create a new binding to change them. */
export const updateOidcTrustBindingInputSchema = z
  .object({
    name: text(100).optional(),
    repositoryName: createOidcTrustBindingInputSchema.shape.repositoryName.optional(),
    ...conditionFields,
    environmentIds: conditionFields.environmentIds.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');
export type UpdateOidcTrustBindingInput = z.input<typeof updateOidcTrustBindingInputSchema>;

export const oidcTrustBindingStatusSchema = z.enum(['ACTIVE', 'DISABLED', 'EXPIRED', 'REVOKED']);
export type OidcTrustBindingStatus = z.infer<typeof oidcTrustBindingStatusSchema>;

const userRefSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
});

export const oidcTrustBindingSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: z.literal('github'),
  identity: z.object({ id: z.uuid(), name: z.string() }),
  issuer: z.string(),
  audience: z.string(),
  scopes: z.array(machineScopeSchema),
  repository: z.object({ id: z.string(), ownerId: z.string(), name: z.string() }),
  workflowPath: z.string().nullable(),
  jobWorkflowRef: z.string().nullable(),
  refs: z.array(z.string()),
  githubEnvironments: z.array(z.string()),
  eventNames: z.array(z.string()),
  subject: z.string().nullable(),
  environments: z.array(
    z.object({ id: z.uuid(), name: z.string(), slug: z.string(), isProtected: z.boolean() }),
  ),
  status: oidcTrustBindingStatusSchema,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  createdBy: userRefSchema.nullable(),
  updatedAt: z.iso.datetime(),
  updatedBy: userRefSchema.nullable(),
  disabledAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type OidcTrustBinding = z.infer<typeof oidcTrustBindingSchema>;

export const oidcTrustBindingListSchema = z.object({
  items: z.array(oidcTrustBindingSchema),
  /** Issuers this API accepts (its administrative allowlist). */
  issuers: z.array(z.string()),
});
export type OidcTrustBindingList = z.infer<typeof oidcTrustBindingListSchema>;

export const oidcTrustBindingQuerySchema = z.object({
  identityId: z.uuid().optional(),
  includeRevoked: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type OidcTrustBindingQuery = z.input<typeof oidcTrustBindingQuerySchema>;

/**
 * Body of `POST /machine/oidc/token`; the GitHub OIDC token itself goes in the
 * Authorization header, never in the body.
 */
export const oidcTokenInputSchema = z
  .object({
    /** Which binding to use when several accept the workflow. */
    bindingId: z.uuid().optional(),
    /** Limit the search to one workspace or project (recommended). */
    workspaceId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    scopes: scopesSchema.optional(),
    environmentIds: z
      .array(z.uuid())
      .min(1)
      .max(MACHINE_LIMITS.maxTokenEnvironments)
      .refine(unique, 'Each environment once')
      .optional(),
  })
  .strict();
export type OidcTokenInput = z.input<typeof oidcTokenInputSchema>;

/** Verified GitHub claims as the API reads them (also used by tests). */
export const githubClaimsSchema = z.object({
  sub: z.string().min(1).max(1024),
  repository: z.string().min(3).max(200),
  repository_id: githubIdSchema,
  repository_owner: z.string().min(1).max(100),
  repository_owner_id: githubIdSchema,
  workflow_ref: z.string().min(1).max(1024),
  job_workflow_ref: z.string().min(1).max(1024),
  ref: z.string().min(1).max(512),
  event_name: z.string().regex(/^[a-z_]{1,64}$/),
  environment: z.string().max(255).optional(),
  run_id: z.string().max(32).optional(),
  run_attempt: z.string().max(16).optional(),
  sha: z.string().max(64).optional(),
});

/** One recorded exchange attempt for a binding (from the audit log; never a token). */
export const oidcBindingAttemptSchema = z.object({
  id: z.uuid(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']),
  occurredAt: z.iso.datetime(),
  /** Why it was refused (`ref`, `audience`, `binding_disabled`...), null on success. */
  reason: z.string().nullable(),
  repository: z.string().nullable(),
  ref: z.string().nullable(),
  eventName: z.string().nullable(),
  workflowRef: z.string().nullable(),
  githubEnvironment: z.string().nullable(),
  runId: z.string().nullable(),
  runAttempt: z.string().nullable(),
});
export type OidcBindingAttempt = z.infer<typeof oidcBindingAttemptSchema>;

export const oidcBindingAttemptListSchema = z.object({ items: z.array(oidcBindingAttemptSchema) });
export type OidcBindingAttemptList = z.infer<typeof oidcBindingAttemptListSchema>;
