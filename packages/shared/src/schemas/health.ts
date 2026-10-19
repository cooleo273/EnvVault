import { z } from 'zod';

export const healthStatusSchema = z.enum(['ok', 'degraded', 'error']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

/** Liveness response for `GET /api/v1/health`. */
export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  service: z.string().min(1),
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const dependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative().optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

/** Readiness response for `GET /api/v1/health/ready`. */
export const readinessResponseSchema = z.object({
  status: healthStatusSchema,
  checks: z.record(z.string(), dependencyCheckSchema),
  timestamp: z.iso.datetime(),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
