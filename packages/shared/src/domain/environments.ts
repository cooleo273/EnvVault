import { z } from 'zod';

/** Environment classification. Mirrors the `EnvironmentKind` database enum. */
export const ENVIRONMENT_KINDS = [
  'DEVELOPMENT',
  'TESTING',
  'STAGING',
  'PRODUCTION',
  'OTHER',
] as const;

export const environmentKindSchema = z.enum(ENVIRONMENT_KINDS);
export type EnvironmentKind = z.infer<typeof environmentKindSchema>;

export const ENVIRONMENT_KIND_LABELS: Record<EnvironmentKind, string> = {
  DEVELOPMENT: 'Development',
  TESTING: 'Testing',
  STAGING: 'Staging',
  PRODUCTION: 'Production',
  OTHER: 'Other',
};
