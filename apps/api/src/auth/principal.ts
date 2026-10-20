import type {
  ActiveMembership,
  EnvironmentScope,
  ProjectScope,
  WorkspaceScope,
} from '@envvault/database';
import type { Request } from 'express';

/** The authenticated caller, derived exclusively from a verified Neon Auth token. */
export interface Principal {
  /** EnvVault profile id (`users.id`). */
  userId: string;
  /** Neon Auth user id (token `sub`). */
  authUserId: string;
  email: string;
  emailVerified: boolean;
  tokenIssuedAt: Date;
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
  workspace?: AuthorizedWorkspace;
  project?: AuthorizedProject;
  environment?: AuthorizedEnvironment;
};
