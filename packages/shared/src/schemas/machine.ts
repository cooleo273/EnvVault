import { z } from 'zod';
import { environmentKindSchema } from '../domain/environments.js';

/**
 * Machine identities, service credentials and the machine token exchange
 * (Phase 4B). See docs/machine-identities.md and docs/service-credentials.md.
 */

/** Permissions a machine can ever hold, and therefore the only credential scopes. */
export const MACHINE_SCOPES = ['environment:read', 'secret:list', 'secret:runtime'] as const;
export type MachineScope = (typeof MACHINE_SCOPES)[number];
export const machineScopeSchema = z.enum(MACHINE_SCOPES);

export const MACHINE_LIMITS = {
  /** Service credential: `evv_sk_<lookup id>_<secret>`. */
  credentialPrefix: 'evv_sk_',
  /** Access token from the exchange: `evv_mt_<secret>`. */
  accessTokenPrefix: 'evv_mt_',
  accessTokenTtlSeconds: 900,
  defaultCredentialLifetimeDays: 30,
  maxCredentialLifetimeDays: 365,
  defaultIdentityCredentialLifetimeDays: 90,
  defaultOverlapHours: 24,
  maxOverlapHours: 168,
  /** Live (unrevoked, unexpired) credentials per identity. */
  maxActiveCredentials: 10,
  maxIdentitiesPerProject: 100,
  maxTokenEnvironments: 50,
} as const;

/** Public lookup part and secret part of a service credential. */
export const SERVICE_CREDENTIAL_PATTERN = /^evv_sk_([A-Za-z0-9]{16})_([A-Za-z0-9_-]{43})$/;
export const MACHINE_TOKEN_PATTERN = /^evv_mt_[A-Za-z0-9_-]{43}$/;

export const MACHINE_ERROR_CODES = {
  /** A machine access token on a route for people. */
  MACHINE_TOKEN_NOT_ALLOWED: 'MACHINE_TOKEN_NOT_ALLOWED',
  /** A person's token on a route for machines. */
  MACHINE_TOKEN_REQUIRED: 'MACHINE_TOKEN_REQUIRED',
  /** The long lived credential sent where an access token belongs. */
  SERVICE_CREDENTIAL_NOT_ACCEPTED: 'SERVICE_CREDENTIAL_NOT_ACCEPTED',
  INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
  CREDENTIAL_EXPIRED: 'CREDENTIAL_EXPIRED',
  CREDENTIAL_REVOKED: 'CREDENTIAL_REVOKED',
  IDENTITY_DISABLED: 'IDENTITY_DISABLED',
  IDENTITY_EXPIRED: 'IDENTITY_EXPIRED',
  /** The exchange asked for a scope or environment the credential does not have. */
  SCOPE_NOT_GRANTED: 'SCOPE_NOT_GRANTED',
  CREDENTIAL_ALREADY_ROTATED: 'CREDENTIAL_ALREADY_ROTATED',
  CREDENTIAL_LIMIT_REACHED: 'CREDENTIAL_LIMIT_REACHED',
  IDENTITY_LIMIT_REACHED: 'IDENTITY_LIMIT_REACHED',
  IDENTITY_NAME_TAKEN: 'IDENTITY_NAME_TAKEN',
  IDENTITY_RETIRED: 'IDENTITY_RETIRED',
  /** The role carries a permission machines may not hold. */
  ROLE_NOT_MACHINE_GRANTABLE: 'ROLE_NOT_MACHINE_GRANTABLE',
  /** Granting would give the machine more than the person granting holds. */
  GRANT_EXCEEDS_AUTHORITY: 'GRANT_EXCEEDS_AUTHORITY',
  GRANT_EXISTS: 'GRANT_EXISTS',
  /** Credential digests need the integrity key, which this API instance lacks. */
  CREDENTIALS_UNAVAILABLE: 'CREDENTIALS_UNAVAILABLE',
} as const;

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const nameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(100, 'Use at most 100 characters')
  .refine((v) => !CONTROL.test(v), 'Remove control characters');
const descriptionSchema = z
  .string()
  .trim()
  .max(1000, 'Use at most 1000 characters')
  .refine((v) => !CONTROL.test(v.replace(/\n/g, '')), 'Remove control characters');
const reasonSchema = z
  .string()
  .trim()
  .min(1, 'Enter a reason or leave it out')
  .max(500, 'Use at most 500 characters')
  .refine((v) => !CONTROL.test(v), 'Remove control characters');
const scopesSchema = z
  .array(machineScopeSchema)
  .min(1, 'Choose at least one scope')
  .max(MACHINE_SCOPES.length)
  .refine((v) => new Set(v).size === v.length, 'Each scope once');
const userRefSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
});

/* ------------------------------------------------------------- Identities */

export const machineIdentityStatusSchema = z.enum(['ACTIVE', 'DISABLED', 'EXPIRED', 'RETIRED']);
export type MachineIdentityStatus = z.infer<typeof machineIdentityStatusSchema>;

export const createMachineIdentityInputSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
    expiresAt: z.iso.datetime().optional(),
    credentialMaxLifetimeDays: z
      .number()
      .int()
      .min(1)
      .max(MACHINE_LIMITS.maxCredentialLifetimeDays)
      .default(MACHINE_LIMITS.defaultIdentityCredentialLifetimeDays),
  })
  .strict();
export type CreateMachineIdentityInput = z.input<typeof createMachineIdentityInputSchema>;

export const updateMachineIdentityInputSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
    credentialMaxLifetimeDays: z
      .number()
      .int()
      .min(1)
      .max(MACHINE_LIMITS.maxCredentialLifetimeDays)
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');
export type UpdateMachineIdentityInput = z.input<typeof updateMachineIdentityInputSchema>;

export const disableMachineIdentityInputSchema = z
  .object({ reason: reasonSchema.optional() })
  .strict();
export type DisableMachineIdentityInput = z.input<typeof disableMachineIdentityInputSchema>;

export const machineGrantSchema = z.object({
  id: z.uuid(),
  environment: z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    isProtected: z.boolean(),
  }),
  role: z.object({ key: z.string(), name: z.string(), permissions: z.array(z.string()) }),
  effect: z.enum(['ALLOW', 'DENY']),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  createdBy: userRefSchema.nullable(),
});
export type MachineGrant = z.infer<typeof machineGrantSchema>;

export const machineIdentitySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  projectId: z.uuid(),
  status: machineIdentityStatusSchema,
  expiresAt: z.iso.datetime().nullable(),
  credentialMaxLifetimeDays: z.number().int(),
  createdAt: z.iso.datetime(),
  createdBy: userRefSchema.nullable(),
  lastAuthenticatedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  disabledAt: z.iso.datetime().nullable(),
  disabledReason: z.string().nullable(),
  activeCredentials: z.number().int().nonnegative(),
  grants: z.array(machineGrantSchema),
});
export type MachineIdentitySummary = z.infer<typeof machineIdentitySummarySchema>;

export const machineIdentityListSchema = z.object({
  items: z.array(machineIdentitySummarySchema),
  /** Grantable environment roles (all their permissions are machine permissions). */
  roles: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      permissions: z.array(z.string()),
    }),
  ),
  /** False while the API has no integrity key file: new credentials would not survive a restart. */
  credentialsDurable: z.boolean(),
});
export type MachineIdentityList = z.infer<typeof machineIdentityListSchema>;

export const machineIdentityQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: machineIdentityStatusSchema.optional(),
  includeRetired: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type MachineIdentityQuery = z.input<typeof machineIdentityQuerySchema>;

export const createMachineGrantInputSchema = z
  .object({
    environmentId: z.uuid(),
    roleKey: z.string().trim().min(1).max(64),
    effect: z.enum(['ALLOW', 'DENY']).default('ALLOW'),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();
export type CreateMachineGrantInput = z.input<typeof createMachineGrantInputSchema>;

/* ------------------------------------------------------------ Credentials */

export const serviceCredentialStatusSchema = z.enum(['ACTIVE', 'EXPIRING', 'EXPIRED', 'REVOKED']);
export type ServiceCredentialStatus = z.infer<typeof serviceCredentialStatusSchema>;

export const serviceCredentialSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Non secret start of the token, for recognising it (`evv_sk_AbCd1234…`). */
  displayPrefix: z.string(),
  scopes: z.array(machineScopeSchema),
  status: serviceCredentialStatusSchema,
  createdAt: z.iso.datetime(),
  createdBy: userRefSchema.nullable(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revocationReason: z.string().nullable(),
  rotatedFromId: z.uuid().nullable(),
  replacedById: z.uuid().nullable(),
});
export type ServiceCredential = z.infer<typeof serviceCredentialSchema>;

export const serviceCredentialListSchema = z.object({ items: z.array(serviceCredentialSchema) });

export const createServiceCredentialInputSchema = z
  .object({
    name: nameSchema,
    scopes: scopesSchema,
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(MACHINE_LIMITS.maxCredentialLifetimeDays)
      .default(MACHINE_LIMITS.defaultCredentialLifetimeDays),
  })
  .strict();
export type CreateServiceCredentialInput = z.input<typeof createServiceCredentialInputSchema>;

/** Returned once. The token is never stored and cannot be shown again. */
export const issuedServiceCredentialSchema = z.object({
  credential: serviceCredentialSchema,
  token: z.string().regex(SERVICE_CREDENTIAL_PATTERN),
  /** Set by rotation: when the replaced credential stops working. */
  previousExpiresAt: z.iso.datetime().nullable(),
});
export type IssuedServiceCredential = z.infer<typeof issuedServiceCredentialSchema>;

export const rotateServiceCredentialInputSchema = z
  .object({
    overlapHours: z
      .number()
      .int()
      .min(0)
      .max(MACHINE_LIMITS.maxOverlapHours)
      .default(MACHINE_LIMITS.defaultOverlapHours),
    expiresInDays: z.number().int().min(1).max(MACHINE_LIMITS.maxCredentialLifetimeDays).optional(),
  })
  .strict();
export type RotateServiceCredentialInput = z.input<typeof rotateServiceCredentialInputSchema>;

export const revokeServiceCredentialInputSchema = z
  .object({ reason: reasonSchema.optional() })
  .strict();
export type RevokeServiceCredentialInput = z.input<typeof revokeServiceCredentialInputSchema>;

/* --------------------------------------------------------------- Activity */

export const machineActivityEventSchema = z.object({
  id: z.uuid(),
  action: z.string(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']),
  occurredAt: z.iso.datetime(),
  /** The identity itself, or the person who managed it. */
  actor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('machine'), name: z.string() }),
    z.object({ kind: z.literal('user'), email: z.string(), displayName: z.string().nullable() }),
    z.object({ kind: z.literal('system') }),
  ]),
  environmentId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type MachineActivityEvent = z.infer<typeof machineActivityEventSchema>;

export const machineActivityPageSchema = z.object({
  items: z.array(machineActivityEventSchema),
  nextCursor: z.string().nullable(),
});
export type MachineActivityPage = z.infer<typeof machineActivityPageSchema>;

/* ------------------------------------------------------ Machine protocol */

export const machineTokenInputSchema = z
  .object({
    /** Narrow the token to some of the credential's scopes (default: all of them). */
    scopes: scopesSchema.optional(),
    /** Narrow the token to some environments of the identity's project. */
    environmentIds: z
      .array(z.uuid())
      .min(1)
      .max(MACHINE_LIMITS.maxTokenEnvironments)
      .refine((v) => new Set(v).size === v.length, 'Each environment once')
      .optional(),
  })
  .strict();
export type MachineTokenInput = z.input<typeof machineTokenInputSchema>;

export const machineIdentityRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});
export type MachineIdentityRef = z.infer<typeof machineIdentityRefSchema>;

export const machineTokenSchema = z.object({
  accessToken: z.string().regex(MACHINE_TOKEN_PATTERN),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  scopes: z.array(machineScopeSchema),
  environmentIds: z.array(z.uuid()),
  identity: machineIdentityRefSchema,
  credential: z.object({ id: z.uuid(), name: z.string(), expiresAt: z.iso.datetime() }),
});
export type MachineToken = z.infer<typeof machineTokenSchema>;

export const machineEnvironmentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  kind: environmentKindSchema,
  isProtected: z.boolean(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  /** Effective machine permissions here: grants ∩ token scopes. */
  permissions: z.array(z.string()),
});
export type MachineEnvironment = z.infer<typeof machineEnvironmentSchema>;

export const machineSelfSchema = z.object({
  identity: machineIdentityRefSchema.extend({ projectName: z.string() }),
  credential: z.object({ id: z.uuid(), name: z.string(), expiresAt: z.iso.datetime() }),
  token: z.object({
    expiresAt: z.iso.datetime(),
    scopes: z.array(machineScopeSchema),
    environmentIds: z.array(z.uuid()),
  }),
  environments: z.array(machineEnvironmentSchema),
});
export type MachineSelf = z.infer<typeof machineSelfSchema>;

export const machineVariableSchema = z.object({
  key: z.string(),
  type: z.string(),
  isRequired: z.boolean(),
  hasValue: z.boolean(),
});
export const machineVariableListSchema = z.object({
  environmentId: z.uuid(),
  items: z.array(machineVariableSchema),
});
export type MachineVariableList = z.infer<typeof machineVariableListSchema>;
