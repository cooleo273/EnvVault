import { z } from 'zod';

/**
 * Deployment integrations (Phase 5B): a project's connection to a provider
 * (Vercel), where each EnvVault environment is copied there, and manual,
 * previewed synchronisation. See docs/integrations/vercel.md.
 */

export const INTEGRATION_LIMITS = {
  maxConnectionsPerProject: 10,
  maxMappingsPerConnection: 20,
  /** Variables one synchronisation may write. */
  maxSyncVariables: 500,
  maxProviderProjects: 100,
} as const;

export const INTEGRATION_ERROR_CODES = {
  /** The provider refused the stored token (invalid, expired or revoked). */
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
  /** The token works but lacks access to the team or project. */
  PROVIDER_FORBIDDEN: 'PROVIDER_FORBIDDEN',
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  /** The provider is down or did not answer in time. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  INTEGRATION_DISABLED: 'INTEGRATION_DISABLED',
  /** No provider project is linked yet. */
  INTEGRATION_NOT_LINKED: 'INTEGRATION_NOT_LINKED',
  INTEGRATION_LIMIT_REACHED: 'INTEGRATION_LIMIT_REACHED',
  CONNECTION_NAME_TAKEN: 'CONNECTION_NAME_TAKEN',
  MAPPING_EXISTS: 'MAPPING_EXISTS',
  SYNC_IN_PROGRESS: 'SYNC_IN_PROGRESS',
  /** Something changed since the preview; preview again before confirming. */
  SYNC_PLAN_CHANGED: 'SYNC_PLAN_CHANGED',
  /** Protected environments and the Production target need explicit confirmation. */
  SYNC_CONFIRMATION_REQUIRED: 'SYNC_CONFIRMATION_REQUIRED',
} as const;

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const name = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(100)
  .refine((v) => !CONTROL.test(v), 'Remove control characters');
const providerToken = z
  .string()
  .trim()
  .min(16, 'Paste the whole access token')
  .max(512)
  .regex(/^[\x21-\x7e]+$/, 'Paste the token without spaces');
const providerId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, 'Use the id shown by the provider');
const gitBranch = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^[A-Za-z0-9._/@+-]+$/, 'Use a branch name')
  .refine((v) => !v.includes('..'), 'Use a branch name');

export const integrationProviderSchema = z.enum(['vercel']);
export const integrationStatusSchema = z.enum(['ACTIVE', 'DISABLED', 'ERROR', 'DISCONNECTED']);
export const integrationTargetSchema = z.enum(['DEVELOPMENT', 'PREVIEW', 'PRODUCTION', 'CUSTOM']);
export type IntegrationTarget = z.infer<typeof integrationTargetSchema>;

const userRef = z.object({ id: z.uuid(), email: z.string(), displayName: z.string().nullable() });

export const integrationConnectionSchema = z.object({
  id: z.uuid(),
  provider: integrationProviderSchema,
  name: z.string(),
  status: integrationStatusSchema,
  /** Vercel team (or personal account) the token acts for. */
  account: z.object({ id: z.string(), name: z.string(), type: z.enum(['team', 'user']) }),
  linkedProject: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** A credential is stored (never returned). */
  hasCredential: z.boolean(),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastErrorCode: z.string().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  createdBy: userRef.nullable(),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

export const integrationListSchema = z.object({ items: z.array(integrationConnectionSchema) });
export type IntegrationList = z.infer<typeof integrationListSchema>;

/** The token goes to the provider check and into envelope encryption; it is never returned. */
export const createVercelConnectionInputSchema = z
  .object({ name, token: providerToken, teamId: providerId.optional() })
  .strict();
export type CreateVercelConnectionInput = z.input<typeof createVercelConnectionInputSchema>;

export const replaceCredentialInputSchema = z.object({ token: providerToken }).strict();
export type ReplaceCredentialInput = z.input<typeof replaceCredentialInputSchema>;

export const providerProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  framework: z.string().nullable(),
});
export const providerProjectListSchema = z.object({ items: z.array(providerProjectSchema) });
export type ProviderProjectList = z.infer<typeof providerProjectListSchema>;
export const providerProjectQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
});

export const linkProviderProjectInputSchema = z.object({ projectId: providerId }).strict();
export type LinkProviderProjectInput = z.input<typeof linkProviderProjectInputSchema>;

export const customEnvironmentSchema = z.object({
  id: z.string(),
  slug: z.string(),
  type: z.enum(['development', 'preview', 'production']),
});
export const customEnvironmentListSchema = z.object({ items: z.array(customEnvironmentSchema) });
export type CustomEnvironmentList = z.infer<typeof customEnvironmentListSchema>;

export const createMappingInputSchema = z
  .object({
    environmentId: z.uuid(),
    target: integrationTargetSchema,
    gitBranch: gitBranch.optional(),
    customEnvironmentId: providerId.optional(),
  })
  .strict()
  .refine((v) => v.target === 'PREVIEW' || v.gitBranch === undefined, {
    message: 'A branch applies to Preview only',
    path: ['gitBranch'],
  })
  .refine((v) => (v.target === 'CUSTOM') === (v.customEnvironmentId !== undefined), {
    message: 'Choose a custom environment for the Custom target only',
    path: ['customEnvironmentId'],
  });
export type CreateMappingInput = z.input<typeof createMappingInputSchema>;

export const integrationMappingSchema = z.object({
  id: z.uuid(),
  environment: z.object({ id: z.uuid(), name: z.string(), isProtected: z.boolean() }),
  target: integrationTargetSchema,
  gitBranch: z.string().nullable(),
  customEnvironment: z.object({ id: z.string(), slug: z.string().nullable() }).nullable(),
  managedVariables: z.number().int(),
  lastSyncedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type IntegrationMapping = z.infer<typeof integrationMappingSchema>;
export const integrationMappingListSchema = z.object({ items: z.array(integrationMappingSchema) });

export const syncActionSchema = z.enum(['create', 'update', 'unchanged', 'conflict', 'remove']);
export type SyncAction = z.infer<typeof syncActionSchema>;

export const syncConflictSchema = z.enum([
  /** A provider variable with this key exists that EnvVault does not manage. */
  'unmanaged',
  /** EnvVault's variable was changed in the provider since the last sync. */
  'changed_externally',
  /** The provider variable also targets other environments; never changed automatically. */
  'shared_target',
]);

/** One planned change. Keys and states only, never values. */
export const syncPlanItemSchema = z.object({
  key: z.string(),
  action: syncActionSchema,
  conflict: syncConflictSchema.nullable(),
  /** Writing an unmanaged or externally changed variable needs `overwrite`. */
  needsOverwrite: z.boolean(),
  /** Removing needs `removeManaged`. */
  needsRemoval: z.boolean(),
});
export type SyncPlanItem = z.infer<typeof syncPlanItemSchema>;

export const syncPlanSchema = z.object({
  mappingId: z.uuid(),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(syncPlanItemSchema),
  counts: z.record(syncActionSchema, z.number().int()),
  /** Unrelated provider variables EnvVault will not touch. */
  unrelated: z.number().int(),
  requiresConfirmation: z.object({ protectedEnvironment: z.boolean(), production: z.boolean() }),
});
export type SyncPlan = z.infer<typeof syncPlanSchema>;

export const syncInputSchema = z
  .object({
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Write unmanaged or externally changed variables with the same key. */
    overwrite: z.boolean().default(false),
    /** Remove provider variables EnvVault manages whose key left the environment. */
    removeManaged: z.boolean().default(false),
    confirmProtected: z.boolean().default(false),
    confirmProduction: z.boolean().default(false),
  })
  .strict();
export type SyncInput = z.input<typeof syncInputSchema>;

export const syncItemResultSchema = z.object({
  key: z.string(),
  action: syncActionSchema,
  outcome: z.enum(['written', 'removed', 'unchanged', 'skipped', 'failed', 'not_attempted']),
  errorCode: z.string().nullable(),
});

export const syncJobSchema = z.object({
  id: z.uuid(),
  mappingId: z.uuid().nullable(),
  environmentId: z.uuid(),
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']),
  trigger: z.enum(['MANUAL', 'SCHEDULED', 'SECRET_CHANGED']),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Seconds to wait before retrying after a provider rate limit. */
  retryAfterSeconds: z.number().int().nullable(),
  counts: z.record(z.string(), z.number().int()),
  items: z.array(syncItemResultSchema),
  requestedBy: userRef.nullable(),
  /** Vercel applies changed variables to new deployments only. */
  redeployRequired: z.boolean(),
});
export type SyncJob = z.infer<typeof syncJobSchema>;
export const syncJobListSchema = z.object({ items: z.array(syncJobSchema) });
export type SyncJobList = z.infer<typeof syncJobListSchema>;
