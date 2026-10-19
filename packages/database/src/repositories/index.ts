import type { DbClient } from '../client.js';
import { AuditRepository } from './audit.repository.js';
import { AuthStateRepository } from './auth-state.repository.js';
import { InvitationRepository } from './invitation.repository.js';
import { MembershipRepository } from './membership.repository.js';
import { EnvironmentRepository, ProjectRepository } from './project.repository.js';
import { RoleRepository } from './role.repository.js';
import { UserRepository } from './user.repository.js';
import { WorkspaceRepository } from './workspace.repository.js';

export { AuditRepository, type AuditEventInput } from './audit.repository.js';
export { AuthStateRepository, MAX_STEP_UP_TTL_SECONDS } from './auth-state.repository.js';
export {
  effectiveInvitationStatus,
  InvitationRepository,
  type InvitationRecord,
  type ReceivedInvitationRecord,
} from './invitation.repository.js';
export {
  MembershipRepository,
  type ActiveMembership,
  type MemberRecord,
} from './membership.repository.js';
export { RoleRepository, type WorkspaceRoleRecord } from './role.repository.js';
export { EnvironmentRepository, ProjectRepository } from './project.repository.js';
export { UserRepository, type UserProfile, type VerifiedIdentity } from './user.repository.js';
export {
  slugify,
  WorkspaceRepository,
  type CreateWorkspaceData,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from './workspace.repository.js';

/**
 * Binds every repository to one client. Inside a transaction, create the set
 * from the transaction client so all reads and writes share it:
 *
 *   await withTransaction(prisma, async (tx) => {
 *     const repos = createRepositories(tx);
 *     ...
 *   });
 */
export function createRepositories(db: DbClient) {
  return {
    audit: new AuditRepository(db),
    authState: new AuthStateRepository(db),
    invitations: new InvitationRepository(db),
    memberships: new MembershipRepository(db),
    projects: new ProjectRepository(db),
    roles: new RoleRepository(db),
    environments: new EnvironmentRepository(db),
    users: new UserRepository(db),
    workspaces: new WorkspaceRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
