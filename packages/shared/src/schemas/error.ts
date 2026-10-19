import { z } from 'zod';

export const validationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/**
 * Uniform error envelope returned by the API for every non-2xx response.
 * It never contains stack traces, internal messages or request payloads.
 */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    statusCode: z.number().int().min(400).max(599),
    code: z.string().min(1),
    message: z.string(),
    requestId: z.string().optional(),
    issues: z.array(validationIssueSchema).optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
