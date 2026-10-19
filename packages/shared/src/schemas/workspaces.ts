import { z } from 'zod';

/** Error codes (`error.code`) specific to workspace, member and invitation APIs. */
export const WORKSPACE_ERROR_CODES = {
  SLUG_TAKEN: 'SLUG_TAKEN',
  /** The workspace is archived: only reading, restoring and deleting are allowed. */
  WORKSPACE_ARCHIVED: 'WORKSPACE_ARCHIVED',
  WORKSPACE_NOT_ARCHIVED: 'WORKSPACE_NOT_ARCHIVED',
  /** The change would leave the workspace without an owner. */
  LAST_OWNER: 'LAST_OWNER',
  /** Only owners may grant, change or remove the owner role. */
  OWNER_REQUIRED: 'OWNER_REQUIRED',
  /** Use ownership transfer or leave the workspace instead. */
  CANNOT_CHANGE_OWN_ROLE: 'CANNOT_CHANGE_OWN_ROLE',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  INVITATION_PENDING: 'INVITATION_PENDING',
  /** Unknown, used, revoked, declined or expired invitation (indistinguishable on purpose). */
  INVITATION_INVALID: 'INVITATION_INVALID',
  /** The invitation was issued to a different email address. */
  INVITATION_EMAIL_MISMATCH: 'INVITATION_EMAIL_MISMATCH',
} as const;

/* -------------------------------------------------------------- Roles */

/** Built-in workspace roles, from most to least privileged. */
export const WORKSPACE_ROLE_KEYS = ['owner', 'admin', 'member', 'viewer'] as const;
export type WorkspaceRoleKey = (typeof WORKSPACE_ROLE_KEYS)[number];
export const workspaceRoleKeySchema = z.enum(WORKSPACE_ROLE_KEYS);

export const roleRefSchema = z.object({ key: z.string(), name: z.string() });
export type RoleRef = z.infer<typeof roleRefSchema>;

export const workspaceRoleSchema = roleRefSchema.extend({ description: z.string().nullable() });
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/* --------------------------------------------------------- Workspaces */

export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const WORKSPACE_TYPES = ['PERSONAL', 'TEAM'] as const;
export const workspaceTypeSchema = z.enum(WORKSPACE_TYPES);
export type WorkspaceType = z.infer<typeof workspaceTypeSchema>;

const workspaceName = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(100, 'Use at most 100 characters');
const workspaceDescription = z.string().trim().max(500, 'Use at most 500 characters');

export const createWorkspaceInputSchema = z.object({
  name: workspaceName,
  /** Optional: generated from the name when omitted. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(WORKSPACE_SLUG_PATTERN, 'Use lowercase letters, numbers and single dashes')
    .optional(),
  description: workspaceDescription.optional(),
  type: workspaceTypeSchema.default('TEAM'),
});
export type CreateWorkspaceInput = z.input<typeof createWorkspaceInputSchema>;

export const updateWorkspaceInputSchema = z
  .object({
    name: workspaceName.optional(),
    /** Empty string or null clears the description. */
    description: workspaceDescription.nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateWorkspaceInput = z.input<typeof updateWorkspaceInputSchema>;

export const workspaceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  type: workspaceTypeSchema,
  archivedAt: z.iso.datetime().nullable(),
  role: roleRefSchema,
  createdAt: z.iso.datetime(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspaceDetailSchema = workspaceSummarySchema.extend({
  updatedAt: z.iso.datetime(),
  projectCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  /** The caller's effective permissions in this workspace. */
  permissions: z.array(z.string()),
});
export type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;

export const transferOwnershipInputSchema = z.object({ membershipId: z.uuid() });
export type TransferOwnershipInput = z.infer<typeof transferOwnershipInputSchema>;

/* ------------------------------------------------------------ Members */

export const workspaceMemberSchema = z.object({
  /** Membership id (not the user id). */
  id: z.uuid(),
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    displayName: z.string().nullable(),
  }),
  role: roleRefSchema,
  joinedAt: z.iso.datetime(),
  isCurrentUser: z.boolean(),
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const updateMemberRoleInputSchema = z.object({ roleKey: workspaceRoleKeySchema });
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleInputSchema>;

/* -------------------------------------------------------- Invitations */

export const INVITATION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'REVOKED',
  'EXPIRED',
] as const;
export const invitationStatusSchema = z.enum(INVITATION_STATUSES);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

/** 32 random bytes, base64url without padding. */
export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const invitationTokenInputSchema = z.object({
  token: z.string().regex(INVITATION_TOKEN_PATTERN, 'Invalid invitation link'),
});
export type InvitationTokenInput = z.infer<typeof invitationTokenInputSchema>;

export const createInvitationInputSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email('Enter a valid email address')),
  /** The owner role is granted by transferring ownership, never by invitation. */
  roleKey: z.enum(['admin', 'member', 'viewer']),
});
export type CreateInvitationInput = z.infer<typeof createInvitationInputSchema>;

/** Administrator view of an invitation (never includes the token). */
export const workspaceInvitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: roleRefSchema,
  /** PENDING invitations past `expiresAt` are reported as EXPIRED. */
  status: invitationStatusSchema,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  invitedBy: z.object({ displayName: z.string().nullable(), email: z.string() }).nullable(),
});
export type WorkspaceInvitation = z.infer<typeof workspaceInvitationSchema>;

export const invitationDeliverySchema = z.object({
  /**
   * `not_configured`: no email provider is set up, nothing was sent. The
   * one-time `acceptUrl` is returned so the inviter can share it directly.
   */
  status: z.enum(['sent', 'not_configured', 'failed']),
});

export const issuedInvitationSchema = z.object({
  invitation: workspaceInvitationSchema,
  delivery: invitationDeliverySchema,
  /** Shown once, only when the invitation could not be emailed. Never stored. */
  acceptUrl: z.url().nullable(),
});
export type IssuedInvitation = z.infer<typeof issuedInvitationSchema>;

/** Invitee view: what they are invited to (no other workspace data). */
export const receivedInvitationSchema = z.object({
  id: z.uuid(),
  workspace: z.object({ name: z.string(), slug: z.string() }),
  role: roleRefSchema,
  invitedBy: z.object({ displayName: z.string().nullable() }).nullable(),
  expiresAt: z.iso.datetime(),
});
export type ReceivedInvitation = z.infer<typeof receivedInvitationSchema>;

export const acceptedInvitationSchema = z.object({ workspaceId: z.uuid() });
export type AcceptedInvitation = z.infer<typeof acceptedInvitationSchema>;
