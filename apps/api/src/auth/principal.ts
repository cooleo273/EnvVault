import type { ActiveMembership, WorkspaceScope } from '@envvault/database';
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

export type AuthenticatedRequest = Request & {
  id?: unknown;
  principal?: Principal;
  workspace?: AuthorizedWorkspace;
};
