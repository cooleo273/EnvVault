import { AuditSealRepository } from './audit-seal.repository.js';
import { CliAuthRepository } from './cli-auth.repository.js';
import { MachineIdentityRepository } from './machine-identity.repository.js';
import { OidcTrustRepository } from './oidc-trust.repository.js';
import { IdempotencyRepository } from './idempotency.repository.js';
import { MaintenanceJobRepository, RetentionRepository } from './retention.repository.js';
import { KeyMaintenanceRepository } from './key-maintenance.repository.js';
import type { DbClient } from '../client.js';
import { AuditRepository } from './audit.repository.js';
import { AuthStateRepository } from './auth-state.repository.js';
import { InvitationRepository } from './invitation.repository.js';
import { MembershipRepository } from './membership.repository.js';
import { AccessPolicyRepository } from './access-policy.repository.js';
import { AccessRepository } from './access.repository.js';
import { ActivityRepository } from './activity.repository.js';
import { EnvironmentRepository } from './environment.repository.js';
import { ProjectMemberRepository } from './project-member.repository.js';
import { ProjectRepository } from './project.repository.js';
import { TemplateRepository } from './template.repository.js';
import { RoleRepository } from './role.repository.js';
import { SnapshotRepository, ValidationRuleRepository } from './intelligence.repository.js';
import { SecretBulkRepository } from './secret-bulk.repository.js';
import { EncryptionKeyRepository, SecretRepository } from './secret.repository.js';
import { UserRepository } from './user.repository.js';
import { WorkspaceRepository } from './workspace.repository.js';

export {
  AuditRepository,
  type AuditEventInput,
  type ServiceAuditEventInput,
  type SystemAuditEventInput,
} from './audit.repository.js';
export {
  MachineIdentityRepository,
  type CredentialForExchange,
  type MachineEnvironmentGrants,
  type MachineGrantRecord,
  type MachineIdentityRecord,
  type MachineTokenRecord,
  type NewServiceCredential,
  type ServiceCredentialRecord,
} from './machine-identity.repository.js';
export {
  OidcTrustRepository,
  type NewOidcBinding,
  type OidcBindingForExchange,
  type OidcBindingRecord,
  type OidcPolicyPatch,
} from './oidc-trust.repository.js';
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
export {
  RoleRepository,
  type ScopedRoleRecord,
  type WorkspaceRoleRecord,
} from './role.repository.js';
export {
  ProjectRepository,
  type CreateProjectData,
  type NewEnvironmentData,
  type ProjectListQuery,
  type ProjectRecord,
  type ProjectViewer,
} from './project.repository.js';
export {
  EnvironmentRepository,
  type EnvironmentRecord,
  type EnvironmentWithGrants,
} from './environment.repository.js';
export {
  AccessRepository,
  type EnvironmentAccessContext,
  type ProjectAccessContext,
} from './access.repository.js';
export { AccessPolicyRepository, type EnvironmentGrantRecord } from './access-policy.repository.js';
export {
  ActivityRepository,
  decodeActivityCursor,
  encodeActivityCursor,
  type ActivityRecord,
} from './activity.repository.js';
export {
  ProjectMemberRepository,
  type InheritedAccessRecord,
  type ProjectMemberRecord,
} from './project-member.repository.js';
export {
  EncryptionKeyRepository,
  SecretRepository,
  type NewSecretData,
  type NewSecretVersion,
  type SecretListQuery,
  type SecretMetadataPatch,
  type SecretRecord,
  type SecretSort,
  type SecretVersionRecord,
  type StoredSecretVersion,
} from './secret.repository.js';
export {
  SecretBulkRepository,
  type BulkPatch,
  type SecretFilters,
  type SecretState,
  type ValueOverwrite,
  type VariableRow,
} from './secret-bulk.repository.js';
export {
  SnapshotRepository,
  ValidationRuleRepository,
  type SnapshotEntryData,
  type SnapshotRecord,
  type ValidationRuleData,
  type ValidationRuleRecord,
} from './intelligence.repository.js';
export { TemplateRepository, type TemplateRecord } from './template.repository.js';
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
export {
  KeyMaintenanceRepository,
  type EnvelopeQuery,
  type KeyReferenceCount,
  type StoredEnvelopeRow,
} from './key-maintenance.repository.js';

export {
  AuditSealRepository,
  type ChainHead,
  type NewSeal,
  type SealableEvent,
  type StoredSeal,
} from './audit-seal.repository.js';

export {
  MaintenanceJobRepository,
  RetentionRepository,
  type MaintenanceJobRecord,
  type MaintenanceJobStatus,
  type RetentionCounts,
  type RetentionCutoffs,
  type RetentionPolicyData,
  type RetentionPolicyRecord,
} from './retention.repository.js';

export {
  IdempotencyRepository,
  type BeginResult,
  type IdempotencyRequest,
  type StoredIdempotency,
} from './idempotency.repository.js';

export {
  CliAuthRepository,
  type CliSessionRecord,
  type DeviceGrantRecord,
  type DeviceGrantStatus,
  type NewCliSession,
} from './cli-auth.repository.js';

export function createRepositories(db: DbClient) {
  return {
    access: new AccessRepository(db),
    accessPolicies: new AccessPolicyRepository(db),
    activity: new ActivityRepository(db),
    audit: new AuditRepository(db),
    auditSeals: new AuditSealRepository(db),
    authState: new AuthStateRepository(db),
    cliAuth: new CliAuthRepository(db),
    invitations: new InvitationRepository(db),
    machineIdentities: new MachineIdentityRepository(db),
    oidcTrust: new OidcTrustRepository(db),
    memberships: new MembershipRepository(db),
    projects: new ProjectRepository(db),
    projectMembers: new ProjectMemberRepository(db),
    templates: new TemplateRepository(db),
    roles: new RoleRepository(db),
    environments: new EnvironmentRepository(db),
    idempotency: new IdempotencyRepository(db),
    encryptionKeys: new EncryptionKeyRepository(db),
    keyMaintenance: new KeyMaintenanceRepository(db),
    maintenanceJobs: new MaintenanceJobRepository(db),
    retention: new RetentionRepository(db),
    secrets: new SecretRepository(db),
    secretBulk: new SecretBulkRepository(db),
    snapshots: new SnapshotRepository(db),
    validationRules: new ValidationRuleRepository(db),
    users: new UserRepository(db),
    workspaces: new WorkspaceRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
