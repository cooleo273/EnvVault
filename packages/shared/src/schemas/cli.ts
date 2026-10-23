import { z } from 'zod';
import { SECRET_KEY_PATTERN } from '../domain/secrets.js';

/**
 * Version of the API contract the CLI and SDK speak. Raised only for
 * incompatible changes; clients refuse an API whose version they do not know.
 */
export const API_PROTOCOL_VERSION = 1;

export const API_FEATURES = ['cli-device-authorization', 'runtime-configuration'] as const;

export const metaResponseSchema = z.object({
  service: z.literal('envvault-api'),
  version: z.string(),
  protocolVersion: z.number().int(),
  features: z.array(z.string()),
});
export type MetaResponse = z.infer<typeof metaResponseSchema>;

/* ---------------------------------------------------- device authorization */

/**
 * Browser approved CLI sign in, shaped after the OAuth device authorization
 * grant (RFC 8628). Neon Auth has no CLI flow, so EnvVault brokers it: the
 * person approves in the web app while signed in through Neon Auth, and the
 * CLI receives EnvVault session credentials.
 */
export const CLI_LIMITS = {
  /** Seconds a device request stays open. */
  deviceTtlSeconds: 600,
  /** Minimum seconds between polls. */
  pollIntervalSeconds: 5,
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlDays: 30,
  /** A session ends this long after it was created, refreshed or not. */
  sessionMaxDays: 90,
  /** Values per runtime response. */
  runtimeMaxValues: 2000,
} as const;

/** Letters that cannot be confused with each other or with digits, and spell few words. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

export const CLI_ERROR_CODES = {
  AUTHORIZATION_PENDING: 'AUTHORIZATION_PENDING',
  SLOW_DOWN: 'SLOW_DOWN',
  ACCESS_DENIED: 'ACCESS_DENIED',
  EXPIRED_TOKEN: 'EXPIRED_TOKEN',
  INVALID_GRANT: 'INVALID_GRANT',
  CLI_TOKEN_NOT_ALLOWED: 'CLI_TOKEN_NOT_ALLOWED',
  RUNTIME_TOO_LARGE: 'RUNTIME_TOO_LARGE',
} as const;

const shortText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // Shown to the person approving; control and bidirectional format characters could disguise it.
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), {
      message: 'Must not contain control or formatting characters',
    });

export const cliDeviceStartInputSchema = z
  .object({
    clientVersion: shortText(32),
    hostname: shortText(255),
    platform: shortText(32),
  })
  .strict();
export type CliDeviceStartInput = z.infer<typeof cliDeviceStartInputSchema>;

export const cliDeviceStartSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string().regex(USER_CODE_PATTERN),
  verificationUri: z.url(),
  verificationUriComplete: z.url(),
  expiresIn: z.number().int(),
  interval: z.number().int(),
});
export type CliDeviceStart = z.infer<typeof cliDeviceStartSchema>;

export const cliDeviceTokenInputSchema = z
  .object({ deviceCode: z.string().min(1).max(200) })
  .strict();

export const cliRefreshInputSchema = z
  .object({ refreshToken: z.string().min(1).max(200) })
  .strict();

export const cliTokenSchema = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
  refreshExpiresAt: z.iso.datetime(),
  sessionId: z.uuid(),
});
export type CliToken = z.infer<typeof cliTokenSchema>;

export const cliUserCodeInputSchema = z
  .object({
    userCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(USER_CODE_PATTERN, 'Enter the code shown in your terminal'),
  })
  .strict();

/** What the person approving sees. Hostname and platform are reported by the CLI, not verified. */
export const cliDeviceRequestSchema = z.object({
  userCode: z.string(),
  clientVersion: z.string(),
  hostname: z.string(),
  platform: z.string(),
  requestedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type CliDeviceRequest = z.infer<typeof cliDeviceRequestSchema>;

export const cliSessionSchema = z.object({
  id: z.uuid(),
  hostname: z.string(),
  platform: z.string(),
  clientVersion: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
});
export type CliSession = z.infer<typeof cliSessionSchema>;

export const cliSessionListSchema = z.object({ items: z.array(cliSessionSchema) });

/* ---------------------------------------------------- runtime configuration */

export const runtimeConfigurationInputSchema = z
  .object({
    /** Also load inheritable variables of the base environment. */
    includeInherited: z.boolean().default(true),
  })
  .strict();
export type RuntimeConfigurationInput = z.input<typeof runtimeConfigurationInputSchema>;

export const runtimeValueSchema = z.object({
  key: z.string().regex(SECRET_KEY_PATTERN),
  value: z.string(),
  source: z.enum(['local', 'inherited']),
});

export const runtimeConfigurationSchema = z.object({
  environmentId: z.uuid(),
  values: z.array(runtimeValueSchema),
  /** Required variables that have no value (names only). */
  missingRequired: z.array(z.string()),
  /** Inherited variables left out because the caller may not load the base environment. */
  withheldInherited: z.number().int(),
  issuedAt: z.iso.datetime(),
});
export type RuntimeConfiguration = z.infer<typeof runtimeConfigurationSchema>;
