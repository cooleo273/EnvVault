import { paginate, paginateBefore, paginateCursor } from './pagination.js';
import {
  type CreateMachineGrantInput,
  type CreateMachineIdentityInput,
  type CreateServiceCredentialInput,
  type DisableMachineIdentityInput,
  type IssuedServiceCredential,
  issuedServiceCredentialSchema,
  type MachineActivityPage,
  machineActivityPageSchema,
  type MachineEnvironment,
  machineEnvironmentSchema,
  type MachineIdentityList,
  machineIdentityListSchema,
  type MachineIdentityQuery,
  type MachineIdentitySummary,
  machineIdentitySummarySchema,
  type MachineSelf,
  machineSelfSchema,
  type MachineToken,
  type MachineTokenInput,
  machineTokenSchema,
  type MachineVariableList,
  machineVariableListSchema,
  type RevokeServiceCredentialInput,
  type RotateServiceCredentialInput,
  type ServiceCredential,
  serviceCredentialListSchema,
  serviceCredentialSchema,
  type UpdateMachineIdentityInput,
  type CompareEnvironmentsInput,
  API_PROTOCOL_VERSION,
  type CliDeviceRequest,
  cliDeviceRequestSchema,
  type CliDeviceStart,
  type CliDeviceStartInput,
  cliDeviceStartSchema,
  type CliSession,
  cliSessionListSchema,
  type CliToken,
  cliTokenSchema,
  type CreateSnapshotInput,
  type MetaResponse,
  metaResponseSchema,
  type RuntimeConfiguration,
  type RuntimeConfigurationInput,
  runtimeConfigurationSchema,
  type MaintenanceJob,
  maintenanceJobSchema,
  type RetentionPolicy,
  type RetentionPolicyInput,
  retentionPolicySchema,
  type RetentionPreview,
  retentionPreviewSchema,
  type EffectiveConfiguration,
  effectiveConfigurationSchema,
  type EnvironmentComparison,
  environmentComparisonSchema,
  type ReadinessInput,
  type ReadinessReport,
  readinessReportSchema,
  type ReplaceValidationRulesInput,
  type RestorePreview,
  type RestorePreviewInput,
  restorePreviewSchema,
  type RestoreResult,
  restoreResultSchema,
  type RestoreSnapshotInput,
  type SnapshotDetail,
  snapshotDetailSchema,
  type SnapshotDiff,
  type SnapshotDiffInput,
  snapshotDiffSchema,
  type SnapshotPage,
  snapshotPageSchema,
  type SnapshotSummary,
  snapshotSummarySchema,
  type ValidationRule,
  validationRuleSchema,
  type CreatedSecret,
  createdSecretSchema,
  type CreateSecretInput,
  type ListSecretsQuery,
  type RevealedSecret,
  revealedSecretSchema,
  type SecretList,
  secretListSchema,
  type SecretSummary,
  secretSummarySchema,
  type BulkActionInput,
  type BulkResult,
  bulkResultSchema,
  type CompareVersionsInput,
  type ExportInput,
  type ExportResult,
  exportResultSchema,
  type ImportCommitInput,
  type ImportPreview,
  type ImportPreviewInput,
  importPreviewSchema,
  type ImportResult,
  importResultSchema,
  type RevealedVersion,
  revealedVersionSchema,
  type RollbackInput,
  type SecretSelection,
  secretSelectionSchema,
  type SecretVersionPage,
  secretVersionPageSchema,
  type SecretVersionsQuery,
  type VersionComparison,
  versionComparisonSchema,
  type UpdateSecretInput,
  type ActivityPage,
  activityPageSchema,
  type ActivityQuery,
  type AddProjectMemberInput,
  type CreateEnvironmentGrantInput,
  type CreateEnvironmentInput,
  type CreateEnvironmentTemplateInput,
  type CreateProjectInput,
  type DuplicateEnvironmentInput,
  type DuplicateProjectInput,
  type EnvironmentAccess,
  environmentAccessSchema,
  type EnvironmentDetail,
  environmentDetailSchema,
  type EnvironmentSummary,
  environmentSummarySchema,
  type EnvironmentTemplate,
  environmentTemplateSchema,
  type ListEnvironmentsQuery,
  type ListProjectsQuery,
  type Paginated,
  paginatedSchema,
  type ProjectAccessList,
  projectAccessListSchema,
  type ProjectDetail,
  projectDetailSchema,
  type ProjectRoleKey,
  type ProjectSummary,
  projectSummarySchema,
  type ScopedRole,
  scopedRoleSchema,
  type UpdateEnvironmentInput,
  type UpdateEnvironmentProtectionInput,
  type UpdateProjectInput,
  type AcceptedInvitation,
  acceptedInvitationSchema,
  API_BASE_PATH,
  apiErrorResponseSchema,
  REQUEST_ID_HEADER,
  type CreateInvitationInput,
  type CreateWorkspaceInput,
  healthResponseSchema,
  type HealthResponse,
  type MeResponse,
  meResponseSchema,
  readinessResponseSchema,
  type ReadinessResponse,
  type ReceivedInvitation,
  receivedInvitationSchema,
  type IssuedInvitation,
  issuedInvitationSchema,
  type UpdateWorkspaceInput,
  type WorkspaceInvitation,
  workspaceInvitationSchema,
  type WorkspaceMember,
  workspaceMemberSchema,
  type WorkspaceRole,
  workspaceRoleSchema,
  type WorkspaceRoleKey,
  type StepUpStatus,
  stepUpStatusSchema,
  type WorkspaceDetail,
  workspaceDetailSchema,
  type WorkspaceSummary,
  workspaceSummarySchema,
} from '@envvault/shared';
import { z } from 'zod';
import {
  EnvVaultAbortError,
  EnvVaultApiError,
  EnvVaultIncompatibleApiError,
  EnvVaultNetworkError,
  EnvVaultResponseValidationError,
} from './errors.js';

export interface EnvVaultClientOptions {
  /** API origin, e.g. `https://api.envvault.example`. The versioned base path is appended automatically. */
  baseUrl: string;
  /**
   * Supplies a short-lived Neon Auth access token for authenticated calls.
   * Called for every request so expired tokens are never reused.
   */
  getAccessToken?: () => Promise<string | null>;
  /** Custom fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Retries after a network failure or a 502, 503 or 504, with backoff. Only
   * for requests that are safe to repeat: reads, and mutations sent with an
   * idempotency key. Default 0.
   */
  retries?: number;
  /** Sent as User-Agent where the runtime allows it (Node does). */
  userAgent?: string;
  /**
   * Retries after a 429 by waiting `Retry-After`, for requests that are safe
   * to repeat (as above). Default 0: rate limits surface as
   * EnvVaultApiError with `retryAfterSeconds`.
   */
  rateLimitRetries?: number;
  /** Longest `Retry-After` to wait for; longer ones are surfaced instead. Default 30000. */
  maxRetryAfterMs?: number;
  /** Cancels every request of this client (see also `withSignal`). */
  signal?: AbortSignal;
}

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  schema?: z.ZodType<T>;
  body?: unknown;
  authenticated?: boolean;
  /** Sent instead of the client's access token (the service credential at the exchange). */
  bearer?: string;
  acceptedErrorStatuses?: number[];
}

const noContentSchema = z.undefined();

export class EnvVaultClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getAccessToken: (() => Promise<string | null>) | undefined;
  private readonly options: EnvVaultClientOptions;
  private idempotencyKey: string | undefined;
  private signal: AbortSignal | undefined;

  constructor(options: EnvVaultClientOptions) {
    this.options = options;
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('baseUrl must use http or https');
    }
    this.baseUrl = url.origin;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.getAccessToken = options.getAccessToken;
    this.signal = options.signal;
  }

  private scoped(change: { idempotencyKey?: string; signal?: AbortSignal }): EnvVaultClient {
    const scoped = new EnvVaultClient(this.options);
    scoped.idempotencyKey = change.idempotencyKey ?? this.idempotencyKey;
    scoped.signal = change.signal ?? this.signal;
    return scoped;
  }

  /**
   * A client that sends `Idempotency-Key: key` with its mutations, so a
   * retried request (network error, double submit) is answered from the first
   * one instead of running twice. Use a fresh key per user action.
   */
  withIdempotencyKey(key: string): EnvVaultClient {
    return this.scoped({ idempotencyKey: key });
  }

  /**
   * A client whose requests stop when `signal` aborts (EnvVaultAbortError).
   * A mutation already received by the server may still complete; pair it
   * with an idempotency key to retry safely.
   */
  withSignal(signal: AbortSignal): EnvVaultClient {
    return this.scoped({ signal });
  }

  /** Liveness check: `GET /api/v1/health`. */
  health(): Promise<HealthResponse> {
    return this.request('/health', { schema: healthResponseSchema, authenticated: false });
  }

  /**
   * Readiness check: `GET /api/v1/health/ready`. A 503 still carries a valid
   * readiness body, which is returned instead of throwing.
   */
  readiness(): Promise<ReadinessResponse> {
    return this.request('/health/ready', {
      schema: readinessResponseSchema,
      authenticated: false,
      acceptedErrorStatuses: [503],
    });
  }

  /** The signed-in user's profile, workspaces and the workspace to open. */
  me(): Promise<MeResponse> {
    return this.request('/users/me', { schema: meResponseSchema });
  }

  /** Remembers the selected workspace (must be an active member). */
  async setActiveWorkspace(workspaceId: string): Promise<void> {
    await this.request('/users/me/active-workspace', {
      method: 'PUT',
      body: { workspaceId },
      schema: noContentSchema,
    });
  }

  listWorkspaces(options: { includeArchived?: boolean } = {}): Promise<WorkspaceSummary[]> {
    const query = options.includeArchived ? '?archived=include' : '';
    return this.request(`/workspaces${query}`, { schema: z.array(workspaceSummarySchema) });
  }

  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceSummary> {
    return this.request('/workspaces', {
      method: 'POST',
      body: input,
      schema: workspaceSummarySchema,
    });
  }

  getWorkspace(workspaceId: string): Promise<WorkspaceDetail> {
    return this.request(workspacePath(workspaceId), { schema: workspaceDetailSchema });
  }

  async updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput): Promise<void> {
    await this.request(workspacePath(workspaceId), {
      method: 'PATCH',
      body: input,
      schema: noContentSchema,
    });
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    await this.request(`${workspacePath(workspaceId)}/archive`, {
      method: 'POST',
      schema: noContentSchema,
    });
  }

  async restoreWorkspace(workspaceId: string): Promise<void> {
    await this.request(`${workspacePath(workspaceId)}/restore`, {
      method: 'POST',
      schema: noContentSchema,
    });
  }

  /** Sensitive: requires a recent step-up (see `stepUp`). */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.request(workspacePath(workspaceId), { method: 'DELETE', schema: noContentSchema });
  }

  /** Sensitive: requires a recent step-up. The caller becomes an admin. */
  async transferOwnership(workspaceId: string, membershipId: string): Promise<void> {
    await this.request(`${workspacePath(workspaceId)}/transfer-ownership`, {
      method: 'POST',
      body: { membershipId },
      schema: noContentSchema,
    });
  }

  async leaveWorkspace(workspaceId: string): Promise<void> {
    await this.request(`${workspacePath(workspaceId)}/leave`, {
      method: 'POST',
      schema: noContentSchema,
    });
  }

  listRoles(workspaceId: string): Promise<WorkspaceRole[]> {
    return this.request(`${workspacePath(workspaceId)}/roles`, {
      schema: z.array(workspaceRoleSchema),
    });
  }

  listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return this.request(`${workspacePath(workspaceId)}/members`, {
      schema: z.array(workspaceMemberSchema),
    });
  }

  async changeMemberRole(
    workspaceId: string,
    membershipId: string,
    roleKey: WorkspaceRoleKey,
  ): Promise<void> {
    await this.request(memberPath(workspaceId, membershipId), {
      method: 'PATCH',
      body: { roleKey },
      schema: noContentSchema,
    });
  }

  async removeMember(workspaceId: string, membershipId: string): Promise<void> {
    await this.request(memberPath(workspaceId, membershipId), {
      method: 'DELETE',
      schema: noContentSchema,
    });
  }

  listInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
    return this.request(`${workspacePath(workspaceId)}/invitations`, {
      schema: z.array(workspaceInvitationSchema),
    });
  }

  inviteMember(workspaceId: string, input: CreateInvitationInput): Promise<IssuedInvitation> {
    return this.request(`${workspacePath(workspaceId)}/invitations`, {
      method: 'POST',
      body: input,
      schema: issuedInvitationSchema,
    });
  }

  resendInvitation(workspaceId: string, invitationId: string): Promise<IssuedInvitation> {
    return this.request(`${invitationPath(workspaceId, invitationId)}/resend`, {
      method: 'POST',
      schema: issuedInvitationSchema,
    });
  }

  async revokeInvitation(workspaceId: string, invitationId: string): Promise<void> {
    await this.request(invitationPath(workspaceId, invitationId), {
      method: 'DELETE',
      schema: noContentSchema,
    });
  }

  /** Invitations addressed to the signed-in user's verified email. */
  myInvitations(): Promise<ReceivedInvitation[]> {
    return this.request('/invitations', { schema: z.array(receivedInvitationSchema) });
  }

  lookupInvitation(token: string): Promise<ReceivedInvitation> {
    return this.request('/invitations/lookup', {
      method: 'POST',
      body: { token },
      schema: receivedInvitationSchema,
    });
  }

  /** Accepts by link token, or by id for invitations listed by `myInvitations`. */
  acceptInvitation(ref: InvitationRef): Promise<AcceptedInvitation> {
    return 'token' in ref
      ? this.request('/invitations/accept', {
          method: 'POST',
          body: { token: ref.token },
          schema: acceptedInvitationSchema,
        })
      : this.request(`/invitations/${encodeURIComponent(ref.id)}/accept`, {
          method: 'POST',
          schema: acceptedInvitationSchema,
        });
  }

  async declineInvitation(ref: InvitationRef): Promise<void> {
    await ('token' in ref
      ? this.request('/invitations/decline', {
          method: 'POST',
          body: { token: ref.token },
          schema: noContentSchema,
        })
      : this.request(`/invitations/${encodeURIComponent(ref.id)}/decline`, {
          method: 'POST',
          schema: noContentSchema,
        }));
  }

  /* ---------------------------------------------------------- Projects */

  listProjects(
    workspaceId: string,
    query: ListProjectsQuery = {},
  ): Promise<Paginated<ProjectSummary>> {
    return this.request(`${workspacePath(workspaceId)}/projects${toQuery(query)}`, {
      schema: paginatedSchema(projectSummarySchema),
    });
  }

  createProject(
    workspaceId: string,
    input: CreateProjectInput,
  ): Promise<{ id: string; slug: string }> {
    return this.request(`${workspacePath(workspaceId)}/projects`, {
      method: 'POST',
      body: input,
      schema: createdSchema,
    });
  }

  getProject(workspaceId: string, projectId: string): Promise<ProjectDetail> {
    return this.request(projectPath(workspaceId, projectId), { schema: projectDetailSchema });
  }

  async updateProject(
    workspaceId: string,
    projectId: string,
    input: UpdateProjectInput,
  ): Promise<void> {
    await this.request(projectPath(workspaceId, projectId), {
      method: 'PATCH',
      body: input,
      schema: noContentSchema,
    });
  }

  async archiveProject(workspaceId: string, projectId: string): Promise<void> {
    await this.request(`${projectPath(workspaceId, projectId)}/archive`, {
      method: 'POST',
      schema: noContentSchema,
    });
  }

  async restoreProject(workspaceId: string, projectId: string): Promise<void> {
    await this.request(`${projectPath(workspaceId, projectId)}/restore`, {
      method: 'POST',
      schema: noContentSchema,
    });
  }

  /** Sensitive: requires a recent step-up. */
  async deleteProject(workspaceId: string, projectId: string): Promise<void> {
    await this.request(projectPath(workspaceId, projectId), {
      method: 'DELETE',
      schema: noContentSchema,
    });
  }

  duplicateProject(
    workspaceId: string,
    projectId: string,
    input: DuplicateProjectInput,
  ): Promise<{ id: string; slug: string }> {
    return this.request(`${projectPath(workspaceId, projectId)}/duplicate`, {
      method: 'POST',
      body: input,
      schema: createdSchema,
    });
  }

  async setProjectFavorite(
    workspaceId: string,
    projectId: string,
    favorite: boolean,
  ): Promise<void> {
    await this.request(`${projectPath(workspaceId, projectId)}/favorite`, {
      method: favorite ? 'PUT' : 'DELETE',
      schema: noContentSchema,
    });
  }

  async recordProjectVisit(workspaceId: string, projectId: string): Promise<void> {
    await this.request(`${projectPath(workspaceId, projectId)}/visits`, {
      method: 'POST',
      schema: noContentSchema,
    });
  }

  projectActivity(
    workspaceId: string,
    projectId: string,
    query: ActivityQuery = {},
  ): Promise<ActivityPage> {
    return this.request(`${projectPath(workspaceId, projectId)}/activity${toQuery(query)}`, {
      schema: activityPageSchema,
    });
  }

  projectMembers(workspaceId: string, projectId: string): Promise<ProjectAccessList> {
    return this.request(`${projectPath(workspaceId, projectId)}/members`, {
      schema: projectAccessListSchema,
    });
  }

  projectRoles(
    workspaceId: string,
    projectId: string,
  ): Promise<{ projectRoles: ScopedRole[]; environmentRoles: ScopedRole[] }> {
    return this.request(`${projectPath(workspaceId, projectId)}/roles`, {
      schema: z.object({
        projectRoles: z.array(scopedRoleSchema),
        environmentRoles: z.array(scopedRoleSchema),
      }),
    });
  }

  addProjectMember(
    workspaceId: string,
    projectId: string,
    input: AddProjectMemberInput,
  ): Promise<{ id: string }> {
    return this.request(`${projectPath(workspaceId, projectId)}/members`, {
      method: 'POST',
      body: input,
      schema: z.object({ id: z.uuid() }),
    });
  }

  async changeProjectMemberRole(
    workspaceId: string,
    projectId: string,
    memberId: string,
    roleKey: ProjectRoleKey,
  ): Promise<void> {
    await this.request(
      `${projectPath(workspaceId, projectId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: 'PATCH',
        body: { roleKey },
        schema: noContentSchema,
      },
    );
  }

  async removeProjectMember(
    workspaceId: string,
    projectId: string,
    memberId: string,
  ): Promise<void> {
    await this.request(
      `${projectPath(workspaceId, projectId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: 'DELETE',
        schema: noContentSchema,
      },
    );
  }

  /* ------------------------------------------------------- Environments */

  listEnvironments(
    workspaceId: string,
    projectId: string,
    query: ListEnvironmentsQuery = {},
  ): Promise<Paginated<EnvironmentSummary>> {
    return this.request(`${projectPath(workspaceId, projectId)}/environments${toQuery(query)}`, {
      schema: paginatedSchema(environmentSummarySchema),
    });
  }

  createEnvironment(
    workspaceId: string,
    projectId: string,
    input: CreateEnvironmentInput,
  ): Promise<{ id: string; slug: string }> {
    return this.request(`${projectPath(workspaceId, projectId)}/environments`, {
      method: 'POST',
      body: input,
      schema: createdSchema,
    });
  }

  async reorderEnvironments(
    workspaceId: string,
    projectId: string,
    environmentIds: string[],
  ): Promise<void> {
    await this.request(`${projectPath(workspaceId, projectId)}/environments/order`, {
      method: 'PUT',
      body: { environmentIds },
      schema: noContentSchema,
    });
  }

  getEnvironment(
    workspaceId: string,
    projectId: string,
    environmentId: string,
  ): Promise<EnvironmentDetail> {
    return this.request(environmentPath(workspaceId, projectId, environmentId), {
      schema: environmentDetailSchema,
    });
  }

  async updateEnvironment(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: UpdateEnvironmentInput,
  ): Promise<void> {
    await this.request(environmentPath(workspaceId, projectId, environmentId), {
      method: 'PATCH',
      body: input,
      schema: noContentSchema,
    });
  }

  /** Removing protection requires a recent step-up. */
  async setEnvironmentProtection(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: UpdateEnvironmentProtectionInput,
  ): Promise<void> {
    await this.request(`${environmentPath(workspaceId, projectId, environmentId)}/protection`, {
      method: 'PUT',
      body: input,
      schema: noContentSchema,
    });
  }

  async archiveEnvironment(
    workspaceId: string,
    projectId: string,
    environmentId: string,
  ): Promise<void> {
    await this.request(`${environmentPath(workspaceId, projectId, environmentId)}/archive`, {
      method: 'POST',
      schema: noContentSchema,
    });
  }

  async restoreEnvironment(
    workspaceId: string,
    projectId: string,
    environmentId: string,
  ): Promise<void> {
    await this.request(`${environmentPath(workspaceId, projectId, environmentId)}/restore`, {
      method: 'POST',
      schema: noContentSchema,
    });
  }

  /** Protected environments require a recent step-up. */
  async deleteEnvironment(
    workspaceId: string,
    projectId: string,
    environmentId: string,
  ): Promise<void> {
    await this.request(environmentPath(workspaceId, projectId, environmentId), {
      method: 'DELETE',
      schema: noContentSchema,
    });
  }

  duplicateEnvironment(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: DuplicateEnvironmentInput,
  ): Promise<{ id: string; slug: string }> {
    return this.request(`${environmentPath(workspaceId, projectId, environmentId)}/duplicate`, {
      method: 'POST',
      body: input,
      schema: createdSchema,
    });
  }

  environmentAccess(
    workspaceId: string,
    projectId: string,
    environmentId: string,
  ): Promise<EnvironmentAccess> {
    return this.request(`${environmentPath(workspaceId, projectId, environmentId)}/access`, {
      schema: environmentAccessSchema,
    });
  }

  grantEnvironmentAccess(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: CreateEnvironmentGrantInput,
  ): Promise<{ id: string }> {
    return this.request(`${environmentPath(workspaceId, projectId, environmentId)}/access`, {
      method: 'POST',
      body: input,
      schema: z.object({ id: z.uuid() }),
    });
  }

  async revokeEnvironmentAccess(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    grantId: string,
  ): Promise<void> {
    await this.request(
      `${environmentPath(workspaceId, projectId, environmentId)}/access/${encodeURIComponent(grantId)}`,
      { method: 'DELETE', schema: noContentSchema },
    );
  }

  /* ---------------------------------------------------------- Templates */

  environmentTemplates(workspaceId: string): Promise<EnvironmentTemplate[]> {
    return this.request(`${workspacePath(workspaceId)}/environment-templates`, {
      schema: z.array(environmentTemplateSchema),
    });
  }

  createEnvironmentTemplate(
    workspaceId: string,
    input: CreateEnvironmentTemplateInput,
  ): Promise<EnvironmentTemplate> {
    return this.request(`${workspacePath(workspaceId)}/environment-templates`, {
      method: 'POST',
      body: input,
      schema: environmentTemplateSchema,
    });
  }

  async deleteEnvironmentTemplate(workspaceId: string, templateId: string): Promise<void> {
    await this.request(
      `${workspacePath(workspaceId)}/environment-templates/${encodeURIComponent(templateId)}`,
      { method: 'DELETE', schema: noContentSchema },
    );
  }

  /* ------------------------------------------------------------ Secrets */

  /** Variable metadata of an environment, one page at a time. Never values. */
  listSecrets(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    query: ListSecretsQuery = {},
  ): Promise<SecretList> {
    const { type, category, ...rest } = query;
    return this.request(
      `${secretsPath(workspaceId, projectId, environmentId)}${toQuery({
        ...rest,
        type: type?.join(','),
        category: category?.join(','),
      })}`,
      { schema: secretListSchema },
    );
  }

  createSecret(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: CreateSecretInput,
  ): Promise<CreatedSecret> {
    return this.request(secretsPath(workspaceId, projectId, environmentId), {
      method: 'POST',
      body: input,
      schema: createdSecretSchema,
    });
  }

  getSecret(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
  ): Promise<SecretSummary> {
    return this.request(secretPath(workspaceId, projectId, environmentId, secretId), {
      schema: secretSummarySchema,
    });
  }

  /** Metadata and/or a new value. Fails with SECRET_CONFLICT when `expectedRevision` is stale. */
  updateSecret(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
    input: UpdateSecretInput,
  ): Promise<SecretSummary> {
    return this.request(secretPath(workspaceId, projectId, environmentId, secretId), {
      method: 'PATCH',
      body: input,
      schema: secretSummarySchema,
    });
  }

  async deleteSecret(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
    expectedRevision?: number,
  ): Promise<void> {
    await this.request(
      `${secretPath(workspaceId, projectId, environmentId, secretId)}${toQuery({ expectedRevision })}`,
      { method: 'DELETE', schema: noContentSchema },
    );
  }

  restoreSecret(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
  ): Promise<SecretSummary> {
    return this.request(`${secretPath(workspaceId, projectId, environmentId, secretId)}/restore`, {
      method: 'POST',
      schema: secretSummarySchema,
    });
  }

  /**
   * Decrypts the current value (audited). Protected environments answer
   * STEP_UP_REQUIRED until {@link stepUp} succeeded. Keep the result out of
   * logs and caches.
   */
  revealSecret(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
  ): Promise<RevealedSecret> {
    return this.request(`${secretPath(workspaceId, projectId, environmentId, secretId)}/reveal`, {
      method: 'POST',
      schema: revealedSecretSchema,
    });
  }

  /** Version history (metadata only), newest first; pass `before` from `nextBefore` for older ones. */
  listSecretVersions(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
    query: SecretVersionsQuery = {},
  ): Promise<SecretVersionPage> {
    return this.request(
      `${secretPath(workspaceId, projectId, environmentId, secretId)}/versions${toQuery({ ...query })}`,
      { schema: secretVersionPageSchema },
    );
  }

  /** Decrypts one historical value (audited; protected environments need a step up). */
  revealSecretVersion(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
    versionId: string,
  ): Promise<RevealedVersion> {
    return this.request(
      `${secretPath(workspaceId, projectId, environmentId, secretId)}/versions/${encodeURIComponent(versionId)}/reveal`,
      { method: 'POST', schema: revealedVersionSchema },
    );
  }

  compareSecretVersions(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
    input: CompareVersionsInput,
  ): Promise<VersionComparison> {
    return this.request(
      `${secretPath(workspaceId, projectId, environmentId, secretId)}/versions/compare`,
      { method: 'POST', body: input, schema: versionComparisonSchema },
    );
  }

  /** Restores an earlier value as a new version. */
  rollbackSecret(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
    input: RollbackInput,
  ): Promise<SecretSummary> {
    return this.request(`${secretPath(workspaceId, projectId, environmentId, secretId)}/rollback`, {
      method: 'POST',
      body: input,
      schema: secretSummarySchema,
    });
  }

  /** Parses .env content on the server and reports what an import would do (no values). */
  previewSecretImport(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: ImportPreviewInput,
  ): Promise<ImportPreview> {
    return this.request(`${secretsPath(workspaceId, projectId, environmentId)}/import/preview`, {
      method: 'POST',
      body: input,
      schema: importPreviewSchema,
    });
  }

  importSecrets(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: ImportCommitInput,
  ): Promise<ImportResult> {
    return this.request(`${secretsPath(workspaceId, projectId, environmentId)}/import`, {
      method: 'POST',
      body: input,
      schema: importResultSchema,
    });
  }

  /** Decrypted file content. Never log, cache or persist the result. */
  exportSecrets(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: ExportInput,
  ): Promise<ExportResult> {
    return this.request(`${secretsPath(workspaceId, projectId, environmentId)}/export`, {
      method: 'POST',
      body: input,
      schema: exportResultSchema,
    });
  }

  /** Ids and revisions of every variable matching the filters (for bulk actions). */
  secretSelection(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    query: ListSecretsQuery = {},
  ): Promise<SecretSelection> {
    const { type, category, ...rest } = query;
    return this.request(
      `${secretsPath(workspaceId, projectId, environmentId)}/selection${toQuery({
        ...rest,
        type: type?.join(','),
        category: category?.join(','),
      })}`,
      { schema: secretSelectionSchema },
    );
  }

  bulkSecrets(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: BulkActionInput,
  ): Promise<BulkResult> {
    return this.request(`${secretsPath(workspaceId, projectId, environmentId)}/bulk`, {
      method: 'POST',
      body: input,
      schema: bulkResultSchema,
    });
  }

  /* --------------------------------------------- Environment intelligence */

  /** Compares two environments of a project (metadata unless `compareValues`). */
  compareEnvironments(
    workspaceId: string,
    projectId: string,
    input: CompareEnvironmentsInput,
  ): Promise<EnvironmentComparison> {
    return this.request(`${projectPath(workspaceId, projectId)}/environments/compare`, {
      method: 'POST',
      body: input,
      schema: environmentComparisonSchema,
    });
  }

  effectiveConfiguration(
    workspaceId: string,
    projectId: string,
    environmentId: string,
  ): Promise<EffectiveConfiguration> {
    return this.request(`${environmentPath(workspaceId, projectId, environmentId)}/effective`, {
      schema: effectiveConfigurationSchema,
    });
  }

  setBaseEnvironment(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    baseEnvironmentId: string | null,
  ): Promise<EffectiveConfiguration> {
    return this.request(`${environmentPath(workspaceId, projectId, environmentId)}/inheritance`, {
      method: 'PUT',
      body: { baseEnvironmentId },
      schema: effectiveConfigurationSchema,
    });
  }

  validationRules(
    workspaceId: string,
    projectId: string,
    environmentId: string,
  ): Promise<ValidationRule[]> {
    return this.request(
      `${environmentPath(workspaceId, projectId, environmentId)}/validation-rules`,
      {
        schema: z.array(validationRuleSchema),
      },
    );
  }

  replaceValidationRules(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: ReplaceValidationRulesInput,
  ): Promise<ValidationRule[]> {
    return this.request(
      `${environmentPath(workspaceId, projectId, environmentId)}/validation-rules`,
      {
        method: 'PUT',
        body: input,
        schema: z.array(validationRuleSchema),
      },
    );
  }

  evaluateReadiness(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: ReadinessInput = {},
  ): Promise<ReadinessReport> {
    return this.request(`${environmentPath(workspaceId, projectId, environmentId)}/readiness`, {
      method: 'POST',
      body: input,
      schema: readinessReportSchema,
    });
  }

  listSnapshots(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    query: { page?: number; pageSize?: number } = {},
  ): Promise<SnapshotPage> {
    return this.request(
      `${environmentPath(workspaceId, projectId, environmentId)}/snapshots${toQuery(query)}`,
      { schema: snapshotPageSchema },
    );
  }

  createSnapshot(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: CreateSnapshotInput = {},
  ): Promise<SnapshotSummary> {
    return this.request(`${environmentPath(workspaceId, projectId, environmentId)}/snapshots`, {
      method: 'POST',
      body: input,
      schema: snapshotSummarySchema,
    });
  }

  getSnapshot(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    snapshotId: string,
  ): Promise<SnapshotDetail> {
    return this.request(snapshotPath(workspaceId, projectId, environmentId, snapshotId), {
      schema: snapshotDetailSchema,
    });
  }

  snapshotDiff(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    snapshotId: string,
    input: SnapshotDiffInput = {},
  ): Promise<SnapshotDiff> {
    return this.request(`${snapshotPath(workspaceId, projectId, environmentId, snapshotId)}/diff`, {
      method: 'POST',
      body: input,
      schema: snapshotDiffSchema,
    });
  }

  previewSnapshotRestore(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    snapshotId: string,
    input: RestorePreviewInput = {},
  ): Promise<RestorePreview> {
    return this.request(
      `${snapshotPath(workspaceId, projectId, environmentId, snapshotId)}/restore/preview`,
      { method: 'POST', body: input, schema: restorePreviewSchema },
    );
  }

  restoreSnapshot(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    snapshotId: string,
    input: RestoreSnapshotInput,
  ): Promise<RestoreResult> {
    return this.request(
      `${snapshotPath(workspaceId, projectId, environmentId, snapshotId)}/restore`,
      {
        method: 'POST',
        body: input,
        schema: restoreResultSchema,
      },
    );
  }

  /** After a Neon Auth password change or session revocation: invalidate issued API tokens. */
  async revokeTokens(reason: 'password_changed' | 'sessions_revoked'): Promise<void> {
    await this.request('/auth/tokens/revoke', {
      method: 'POST',
      body: { reason },
      schema: noContentSchema,
    });
  }

  /** Re-verifies the password with Neon Auth to unlock sensitive actions briefly. */
  stepUp(password: string): Promise<StepUpStatus> {
    return this.request('/auth/step-up', {
      method: 'POST',
      body: { password },
      schema: stepUpStatusSchema,
    });
  }

  /** Revokes the user's API access tokens issued until now. */
  async logout(scope: 'current' | 'all' = 'current'): Promise<void> {
    await this.request('/auth/logout', {
      method: 'POST',
      body: { scope },
      schema: noContentSchema,
    });
  }

  /** Protocol version and features (public). */
  meta(): Promise<MetaResponse> {
    return this.request('/meta', { schema: metaResponseSchema, authenticated: false });
  }

  /** Refuses a server whose protocol version this client does not speak. */
  async checkCompatibility(): Promise<MetaResponse> {
    const meta = await this.meta();
    if (meta.protocolVersion !== API_PROTOCOL_VERSION) {
      throw new EnvVaultIncompatibleApiError(meta.protocolVersion, API_PROTOCOL_VERSION);
    }
    return meta;
  }

  /** CLI sign in, step 1: open a request the person approves in the browser. */
  startCliLogin(input: CliDeviceStartInput): Promise<CliDeviceStart> {
    return this.request('/cli/device/authorize', {
      method: 'POST',
      body: input,
      schema: cliDeviceStartSchema,
      authenticated: false,
    });
  }

  /** CLI sign in, step 3: throws EnvVaultApiError with AUTHORIZATION_PENDING until approved. */
  pollCliLogin(deviceCode: string): Promise<CliToken> {
    return this.request('/cli/device/token', {
      method: 'POST',
      body: { deviceCode },
      schema: cliTokenSchema,
      authenticated: false,
    });
  }

  refreshCliSession(refreshToken: string): Promise<CliToken> {
    return this.request('/cli/token/refresh', {
      method: 'POST',
      body: { refreshToken },
      schema: cliTokenSchema,
      authenticated: false,
    });
  }

  cliLoginRequest(userCode: string): Promise<CliDeviceRequest> {
    return this.request(`/cli/device/${encodeURIComponent(userCode)}`, {
      schema: cliDeviceRequestSchema,
    });
  }

  async approveCliLogin(userCode: string): Promise<void> {
    await this.request('/cli/device/approve', {
      method: 'POST',
      body: { userCode },
      schema: noContentSchema,
    });
  }

  async denyCliLogin(userCode: string): Promise<void> {
    await this.request('/cli/device/deny', {
      method: 'POST',
      body: { userCode },
      schema: noContentSchema,
    });
  }

  async cliSessions(): Promise<CliSession[]> {
    return (await this.request('/cli/sessions', { schema: cliSessionListSchema })).items;
  }

  /** Ends the calling CLI session (envvault logout). */
  async endCliSession(): Promise<void> {
    await this.request('/cli/sessions/current/revoke', { method: 'POST', schema: noContentSchema });
  }

  async revokeCliSession(sessionId: string): Promise<void> {
    await this.request(`/cli/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      schema: noContentSchema,
    });
  }

  /** Decrypted values for a local process. Needs `secret:runtime`; never cached. */
  runtimeConfiguration(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    input: RuntimeConfigurationInput = {},
  ): Promise<RuntimeConfiguration> {
    return this.request(`${environmentPath(workspaceId, projectId, environmentId)}/runtime`, {
      method: 'POST',
      body: input,
      schema: runtimeConfigurationSchema,
    });
  }

  /* ------------------------------------------------- machine identities */

  listMachineIdentities(
    workspaceId: string,
    projectId: string,
    query: MachineIdentityQuery = {},
  ): Promise<MachineIdentityList> {
    return this.request(`${machinePath(workspaceId, projectId)}${toQuery(query)}`, {
      schema: machineIdentityListSchema,
    });
  }

  createMachineIdentity(
    workspaceId: string,
    projectId: string,
    input: CreateMachineIdentityInput,
  ): Promise<MachineIdentitySummary> {
    return this.request(machinePath(workspaceId, projectId), {
      method: 'POST',
      body: input,
      schema: machineIdentitySummarySchema,
    });
  }

  machineIdentity(
    workspaceId: string,
    projectId: string,
    identityId: string,
  ): Promise<MachineIdentitySummary> {
    return this.request(machinePath(workspaceId, projectId, identityId), {
      schema: machineIdentitySummarySchema,
    });
  }

  updateMachineIdentity(
    workspaceId: string,
    projectId: string,
    identityId: string,
    input: UpdateMachineIdentityInput,
  ): Promise<MachineIdentitySummary> {
    return this.request(machinePath(workspaceId, projectId, identityId), {
      method: 'PATCH',
      body: input,
      schema: machineIdentitySummarySchema,
    });
  }

  disableMachineIdentity(
    workspaceId: string,
    projectId: string,
    identityId: string,
    input: DisableMachineIdentityInput = {},
  ): Promise<MachineIdentitySummary> {
    return this.request(`${machinePath(workspaceId, projectId, identityId)}/disable`, {
      method: 'POST',
      body: input,
      schema: machineIdentitySummarySchema,
    });
  }

  /** Needs a recent step up. */
  enableMachineIdentity(
    workspaceId: string,
    projectId: string,
    identityId: string,
  ): Promise<MachineIdentitySummary> {
    return this.request(`${machinePath(workspaceId, projectId, identityId)}/enable`, {
      method: 'POST',
      schema: machineIdentitySummarySchema,
    });
  }

  async retireMachineIdentity(
    workspaceId: string,
    projectId: string,
    identityId: string,
  ): Promise<void> {
    await this.request(machinePath(workspaceId, projectId, identityId), {
      method: 'DELETE',
      schema: noContentSchema,
    });
  }

  async serviceCredentials(
    workspaceId: string,
    projectId: string,
    identityId: string,
  ): Promise<ServiceCredential[]> {
    return (
      await this.request(`${machinePath(workspaceId, projectId, identityId)}/credentials`, {
        schema: serviceCredentialListSchema,
      })
    ).items;
  }

  /** Needs a recent step up. The token in the result is shown once; keep it out of logs. */
  issueServiceCredential(
    workspaceId: string,
    projectId: string,
    identityId: string,
    input: CreateServiceCredentialInput,
  ): Promise<IssuedServiceCredential> {
    return this.request(`${machinePath(workspaceId, projectId, identityId)}/credentials`, {
      method: 'POST',
      body: input,
      schema: issuedServiceCredentialSchema,
    });
  }

  /** Needs a recent step up. Not retried: a repeat would rotate the replacement. */
  rotateServiceCredential(
    workspaceId: string,
    projectId: string,
    identityId: string,
    credentialId: string,
    input: RotateServiceCredentialInput = {},
  ): Promise<IssuedServiceCredential> {
    return this.request(
      `${machinePath(workspaceId, projectId, identityId)}/credentials/${encodeURIComponent(credentialId)}/rotate`,
      { method: 'POST', body: input, schema: issuedServiceCredentialSchema },
    );
  }

  /** Needs a recent step up. */
  revokeServiceCredential(
    workspaceId: string,
    projectId: string,
    identityId: string,
    credentialId: string,
    input: RevokeServiceCredentialInput = {},
  ): Promise<ServiceCredential> {
    return this.request(
      `${machinePath(workspaceId, projectId, identityId)}/credentials/${encodeURIComponent(credentialId)}/revoke`,
      { method: 'POST', body: input, schema: serviceCredentialSchema },
    );
  }

  /** ALLOW needs a recent step up and the role's permissions on that environment yourself. */
  grantMachineAccess(
    workspaceId: string,
    projectId: string,
    identityId: string,
    input: CreateMachineGrantInput,
  ): Promise<MachineIdentitySummary> {
    return this.request(`${machinePath(workspaceId, projectId, identityId)}/grants`, {
      method: 'POST',
      body: input,
      schema: machineIdentitySummarySchema,
    });
  }

  removeMachineGrant(
    workspaceId: string,
    projectId: string,
    identityId: string,
    grantId: string,
  ): Promise<MachineIdentitySummary> {
    return this.request(
      `${machinePath(workspaceId, projectId, identityId)}/grants/${encodeURIComponent(grantId)}`,
      { method: 'DELETE', schema: machineIdentitySummarySchema },
    );
  }

  machineIdentityActivity(
    workspaceId: string,
    projectId: string,
    identityId: string,
    query: ActivityQuery = {},
  ): Promise<MachineActivityPage> {
    return this.request(
      `${machinePath(workspaceId, projectId, identityId)}/activity${toQuery(query)}`,
      { schema: machineActivityPageSchema },
    );
  }

  /* --------------------------------------------- machine side (evv_mt_) */

  /**
   * Exchanges a service credential for a machine access token. The
   * credential goes in the Authorization header of this one request only;
   * use the returned token (via `getAccessToken`) for the other machine calls.
   */
  exchangeServiceCredential(
    credential: string,
    input: MachineTokenInput = {},
  ): Promise<MachineToken> {
    return this.request('/machine/token', {
      method: 'POST',
      body: input,
      bearer: credential,
      schema: machineTokenSchema,
    });
  }

  async revokeMachineToken(): Promise<void> {
    await this.request('/machine/token/revoke', { method: 'POST', schema: noContentSchema });
  }

  machineSelf(): Promise<MachineSelf> {
    return this.request('/machine/identity', { schema: machineSelfSchema });
  }

  async machineEnvironments(): Promise<MachineEnvironment[]> {
    return (
      await this.request('/machine/environments', {
        schema: z.object({ items: z.array(machineEnvironmentSchema) }),
      })
    ).items;
  }

  machineEnvironment(environmentId: string): Promise<MachineEnvironment> {
    return this.request(`/machine/environments/${encodeURIComponent(environmentId)}`, {
      schema: machineEnvironmentSchema,
    });
  }

  machineVariables(environmentId: string): Promise<MachineVariableList> {
    return this.request(`/machine/environments/${encodeURIComponent(environmentId)}/variables`, {
      schema: machineVariableListSchema,
    });
  }

  /** Decrypted values for the calling process. Needs `secret:runtime`; never cached. */
  machineRuntime(
    environmentId: string,
    input: RuntimeConfigurationInput = {},
  ): Promise<RuntimeConfiguration> {
    return this.request(`/machine/environments/${encodeURIComponent(environmentId)}/runtime`, {
      method: 'POST',
      body: input,
      schema: runtimeConfigurationSchema,
    });
  }

  retentionPolicy(workspaceId: string): Promise<RetentionPolicy> {
    return this.request(`${workspacePath(workspaceId)}/retention`, {
      schema: retentionPolicySchema,
    });
  }

  updateRetentionPolicy(
    workspaceId: string,
    input: RetentionPolicyInput,
  ): Promise<RetentionPolicy> {
    return this.request(`${workspacePath(workspaceId)}/retention`, {
      method: 'PUT',
      body: input,
      schema: retentionPolicySchema,
    });
  }

  previewRetention(workspaceId: string): Promise<RetentionPreview> {
    return this.request(`${workspacePath(workspaceId)}/retention/preview`, {
      method: 'POST',
      schema: retentionPreviewSchema,
    });
  }

  /** Queues a purge. Needs workspace:delete, a recent step up and the slug as confirmation. */
  startRetentionRun(workspaceId: string, confirm: string): Promise<MaintenanceJob> {
    return this.request(`${workspacePath(workspaceId)}/retention/runs`, {
      method: 'POST',
      body: { confirm },
      schema: maintenanceJobSchema,
    });
  }

  retentionRuns(workspaceId: string): Promise<{ items: MaintenanceJob[] }> {
    return this.request(`${workspacePath(workspaceId)}/retention/runs`, {
      schema: z.object({ items: z.array(maintenanceJobSchema) }),
    });
  }

  retentionRun(workspaceId: string, jobId: string): Promise<MaintenanceJob> {
    return this.request(
      `${workspacePath(workspaceId)}/retention/runs/${encodeURIComponent(jobId)}`,
      {
        schema: maintenanceJobSchema,
      },
    );
  }

  /* --------------------------------------------------------- iteration */

  /** Every project of a workspace the caller can see, fetched page by page. */
  iterateProjects(workspaceId: string, query: Omit<ListProjectsQuery, 'page'> = {}) {
    return paginate((page) => this.listProjects(workspaceId, { ...query, page, pageSize: 100 }));
  }

  iterateEnvironments(
    workspaceId: string,
    projectId: string,
    query: Omit<ListEnvironmentsQuery, 'page'> = {},
  ) {
    return paginate((page) =>
      this.listEnvironments(workspaceId, projectId, { ...query, page, pageSize: 100 }),
    );
  }

  /** Variable metadata (never values) of an environment. */
  iterateSecrets(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    query: Omit<ListSecretsQuery, 'page'> = {},
  ) {
    return paginate((page) =>
      this.listSecrets(workspaceId, projectId, environmentId, { ...query, page, pageSize: 100 }),
    );
  }

  iterateSecretVersions(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
  ) {
    return paginateBefore((before) =>
      this.listSecretVersions(workspaceId, projectId, environmentId, secretId, {
        ...(before === undefined ? {} : { before }),
      }),
    );
  }

  iterateSnapshots(workspaceId: string, projectId: string, environmentId: string) {
    return paginate((page) =>
      this.listSnapshots(workspaceId, projectId, environmentId, { page, pageSize: 100 }),
    );
  }

  iterateProjectActivity(
    workspaceId: string,
    projectId: string,
    query: Omit<ActivityQuery, 'cursor'> = {},
  ) {
    return paginateCursor((cursor) =>
      this.projectActivity(workspaceId, projectId, {
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
  }

  iterateMachineIdentityActivity(workspaceId: string, projectId: string, identityId: string) {
    return paginateCursor((cursor) =>
      this.machineIdentityActivity(workspaceId, projectId, identityId, {
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
  }

  private async request<T>(path: string, options: RequestOptions<T>): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.userAgent) headers['user-agent'] = this.options.userAgent;
    if (options.bearer !== undefined) {
      headers.authorization = `Bearer ${options.bearer}`;
    } else if (options.authenticated !== false) {
      const token = await this.getAccessToken?.();
      if (!token) {
        throw new EnvVaultApiError(401, {
          statusCode: 401,
          code: 'UNAUTHENTICATED',
          message: 'Not signed in',
        });
      }
      headers.authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.idempotencyKey && method !== 'GET') {
      headers['idempotency-key'] = this.idempotencyKey;
    }
    // Repeating is only safe for reads and for mutations the server can deduplicate.
    const repeatable = method === 'GET' || this.idempotencyKey !== undefined;
    const attempts = 1 + (repeatable ? Math.max(0, this.options.retries ?? 0) : 0);
    const rateLimitAttempts = repeatable ? Math.max(0, this.options.rateLimitRetries ?? 0) : 0;
    const maxWait = this.options.maxRetryAfterMs ?? 30_000;
    const cancel = this.signal;

    let response: Response | undefined;
    let rateLimited = 0;
    for (let attempt = 1; ; attempt++) {
      if (cancel?.aborted) throw new EnvVaultAbortError();
      const timeout = AbortSignal.timeout(this.timeoutMs);
      try {
        response = await this.fetchImpl(`${this.baseUrl}${API_BASE_PATH}${path}`, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout,
        });
      } catch (error) {
        if (cancel?.aborted) throw new EnvVaultAbortError();
        if (attempt < attempts) {
          await pause(backoffMs(attempt), cancel);
          continue;
        }
        const name = (error as Error | undefined)?.name;
        throw new EnvVaultNetworkError(
          name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable',
        );
      }
      if (attempt < attempts && [502, 503, 504].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        await pause(backoffMs(attempt), cancel);
        continue;
      }
      const wait = retryAfterMs(response);
      if (
        response.status === 429 &&
        rateLimited < rateLimitAttempts &&
        wait !== undefined &&
        wait <= maxWait
      ) {
        rateLimited++;
        await response.body?.cancel().catch(() => undefined);
        await pause(wait, cancel);
        continue;
      }
      break;
    }
    const body: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => undefined);

    if (!response.ok && !(options.acceptedErrorStatuses ?? []).includes(response.status)) {
      const parsedError = apiErrorResponseSchema.safeParse(body);
      const wait = retryAfterMs(response);
      throw new EnvVaultApiError(
        response.status,
        parsedError.success ? parsedError.data.error : undefined,
        {
          retryAfterSeconds: wait === undefined ? undefined : Math.ceil(wait / 1000),
          requestId: response.headers.get(REQUEST_ID_HEADER) ?? undefined,
        },
      );
    }

    const parsed = (options.schema ?? z.unknown()).safeParse(body);
    if (!parsed.success) {
      throw new EnvVaultResponseValidationError(path);
    }
    return parsed.data as T;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(2000, 200 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
}

/** Waits `ms`, or rejects with EnvVaultAbortError as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EnvVaultAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new EnvVaultAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `Retry-After` as milliseconds (seconds or an HTTP date), when present and sane. */
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** An invitation by link token, or by id when it is addressed to the signed-in user. */
export type InvitationRef = { token: string } | { id: string };

const createdSchema = z.object({ id: z.uuid(), slug: z.string() });

/** Query string from defined, non-empty values. */
function toQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (
      typeof value === 'string'
        ? value !== ''
        : typeof value === 'number' || typeof value === 'boolean'
    ) {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function projectPath(workspaceId: string, projectId: string): string {
  return `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}`;
}

function environmentPath(workspaceId: string, projectId: string, environmentId: string): string {
  return `${projectPath(workspaceId, projectId)}/environments/${encodeURIComponent(environmentId)}`;
}

function secretsPath(workspaceId: string, projectId: string, environmentId: string): string {
  return `${environmentPath(workspaceId, projectId, environmentId)}/secrets`;
}

function secretPath(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  secretId: string,
): string {
  return `${secretsPath(workspaceId, projectId, environmentId)}/${encodeURIComponent(secretId)}`;
}

function snapshotPath(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  snapshotId: string,
): string {
  return `${environmentPath(workspaceId, projectId, environmentId)}/snapshots/${encodeURIComponent(snapshotId)}`;
}

function machinePath(workspaceId: string, projectId: string, identityId?: string): string {
  const base = `${projectPath(workspaceId, projectId)}/machine-identities`;
  return identityId ? `${base}/${encodeURIComponent(identityId)}` : base;
}

function workspacePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}`;
}

function memberPath(workspaceId: string, membershipId: string): string {
  return `${workspacePath(workspaceId)}/members/${encodeURIComponent(membershipId)}`;
}

function invitationPath(workspaceId: string, invitationId: string): string {
  return `${workspacePath(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`;
}

export function createEnvVaultClient(options: EnvVaultClientOptions): EnvVaultClient {
  return new EnvVaultClient(options);
}
