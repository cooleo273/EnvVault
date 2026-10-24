import type {
  ActiveMembership,
  EnvironmentScope,
  ProjectScope,
  WorkspaceScope,
} from '@envvault/database';
import type { Request } from 'express';

/**
 * The authenticated caller, derived exclusively from a verified Neon Auth
 * token or from an EnvVault CLI session that a Neon Auth user approved.
 */
export interface Principal {
  /** EnvVault profile id (`users.id`). */
  userId: string;
  /** Neon Auth user id (token `sub`). */
  authUserId: string;
  email: string;
  emailVerified: boolean;
  tokenIssuedAt: Date;
  /** Set when the request carries a CLI access token instead of a Neon Auth token. */
  cliSessionId?: string;
}

/**
 * A machine identity authenticated by a machine access token. Deliberately
 * not a {@link Principal}: it has no user row, no membership and no step up,
 * and only routes marked @MachineRoute() accept it.
 */
export interface MachinePrincipal {
  serviceIdentityId: string;
  identityName: string;
  workspaceId: string;
  projectId: string;
  credentialId: string;
  credentialName: string;
  credentialExpiresAt: Date;
  tokenId: string;
  tokenExpiresAt: Date;
  /** Token scopes; effective permissions are these intersected with grants. */
  scopes: ReadonlySet<string>;
  /** Environments the token is restricted to; empty means every granted one. */
  environmentIds: readonly string[];
}

/** Result of workspace authorization: proof of access plus the caller's role. */
export interface AuthorizedWorkspace {
  scope: WorkspaceScope;
  membership: ActiveMembership;
}

/** Result of project authorization: scope plus effective project permissions. */
export interface AuthorizedProject {
  scope: ProjectScope;
  permissions: ReadonlySet<string>;
  access: {
    source: 'project_member' | 'workspace_role';
    role: { key: string; name: string } | null;
  };
  archived: boolean;
}

/** Result of environment authorization: scope plus effective environment permissions. */
export interface AuthorizedEnvironment {
  scope: EnvironmentScope;
  permissions: ReadonlySet<string>;
  isProtected: boolean;
  archived: boolean;
}

export type AuthenticatedRequest = Request & {
  id?: unknown;
  principal?: Principal;
  machine?: MachinePrincipal;
  workspace?: AuthorizedWorkspace;
  project?: AuthorizedProject;
  environment?: AuthorizedEnvironment;
};
