import { z } from 'zod';

/**
 * Public (browser-exposed) configuration. Everything here ends up in the client
 * bundle, so this schema must never contain secrets. Server-only configuration
 * will get its own schema once the web app needs any.
 */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z
    .url({ protocol: /^https?$/ })
    .default('http://localhost:4000')
    .transform((value) => new URL(value).origin),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function parsePublicEnv(source: Record<string, string | undefined>): PublicEnv {
  const result = publicEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid web environment configuration:\n  - ${issues.join('\n  - ')}`);
  }
  return result.data;
}
