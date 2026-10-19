import { z } from 'zod';
import { workspaceSummarySchema } from './workspaces.js';

export const currentUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  emailVerified: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

/** `GET /api/v1/users/me`. */
export const meResponseSchema = z.object({
  user: currentUserSchema,
  /** Live, non-archived workspaces with an ACTIVE membership. */
  workspaces: z.array(workspaceSummarySchema),
  /**
   * The workspace to open: the last one the user selected if they still have
   * access, otherwise their first accessible workspace, otherwise null
   * (onboarding).
   */
  activeWorkspaceId: z.uuid().nullable(),
  /** Pending, unexpired invitations addressed to the user's verified email. */
  pendingInvitationCount: z.number().int().nonnegative(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const setActiveWorkspaceInputSchema = z.object({ workspaceId: z.uuid() });
export type SetActiveWorkspaceInput = z.infer<typeof setActiveWorkspaceInputSchema>;
