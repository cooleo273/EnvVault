import {
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
