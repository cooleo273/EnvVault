import {
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
  type SecretVersionInfo,
  secretVersionSchema,
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
import { EnvVaultApiError, EnvVaultResponseValidationError } from './errors.js';

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
}

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  schema?: z.ZodType<T>;
  body?: unknown;
  authenticated?: boolean;
  acceptedErrorStatuses?: number[];
}

const noContentSchema = z.undefined();

export class EnvVaultClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getAccessToken: (() => Promise<string | null>) | undefined;

  constructor(options: EnvVaultClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('baseUrl must use http or https');
    }
    this.baseUrl = url.origin;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.getAccessToken = options.getAccessToken;
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

  listSecretVersions(
    workspaceId: string,
    projectId: string,
    environmentId: string,
    secretId: string,
  ): Promise<SecretVersionInfo[]> {
    return this.request(`${secretPath(workspaceId, projectId, environmentId, secretId)}/versions`, {
      schema: z.array(secretVersionSchema),
    });
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

  private async request<T>(path: string, options: RequestOptions<T>): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.authenticated !== false) {
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

    const response = await this.fetchImpl(`${this.baseUrl}${API_BASE_PATH}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => undefined);

    if (!response.ok && !(options.acceptedErrorStatuses ?? []).includes(response.status)) {
      const parsedError = apiErrorResponseSchema.safeParse(body);
      throw new EnvVaultApiError(
        response.status,
        parsedError.success ? parsedError.data.error : undefined,
      );
    }

    const parsed = (options.schema ?? z.unknown()).safeParse(body);
    if (!parsed.success) {
      throw new EnvVaultResponseValidationError(path);
    }
    return parsed.data as T;
  }
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
