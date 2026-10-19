import type {
  InvitationRecord,
  MemberRecord,
  WorkspaceSummary as WorkspaceSummaryRecord,
} from '@envvault/database';
import { effectiveInvitationStatus } from '@envvault/database';
import type { WorkspaceInvitation, WorkspaceMember, WorkspaceSummary } from '@envvault/shared';

/** Repository records → API contracts (dates as ISO strings, no internal ids). */
export function toWorkspaceSummary(workspace: WorkspaceSummaryRecord): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    description: workspace.description,
    type: workspace.type,
    archivedAt: workspace.archivedAt?.toISOString() ?? null,
    role: { key: workspace.role.key, name: workspace.role.name },
    createdAt: workspace.createdAt.toISOString(),
  };
}

export function toWorkspaceMember(member: MemberRecord, currentUserId: string): WorkspaceMember {
  return {
    id: member.id,
    user: { id: member.userId, email: member.email, displayName: member.displayName },
    role: { key: member.role.key, name: member.role.name },
    joinedAt: member.joinedAt.toISOString(),
    isCurrentUser: member.userId === currentUserId,
  };
}

export function toWorkspaceInvitation(
  invitation: InvitationRecord,
  now = new Date(),
): WorkspaceInvitation {
  return {
    id: invitation.id,
    email: invitation.email,
    role: { key: invitation.role.key, name: invitation.role.name },
    status: effectiveInvitationStatus(invitation, now),
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    invitedBy: invitation.invitedBy,
  };
}
