/**
 * GitHub Actions trust policy rules, shared by the API (which enforces them)
 * and the dashboard (which explains them). Pure functions over already
 * verified claims: signature, issuer, audience and lifetime are checked
 * before any of this runs.
 */

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/** Events whose workflow code can come from a pull request's author. */
export const PULL_REQUEST_EVENTS: readonly string[] = ['pull_request', 'pull_request_target'];

/** Claims EnvVault reads from a GitHub Actions OIDC token. */
export interface GithubClaims {
  sub: string;
  repository: string;
  repository_id: string;
  repository_owner: string;
  repository_owner_id: string;
  workflow_ref: string;
  job_workflow_ref: string;
  ref: string;
  event_name: string;
  environment?: string | undefined;
  run_id?: string | undefined;
  run_attempt?: string | undefined;
  sha?: string | undefined;
}

export interface GithubTrustConditions {
  repositoryId: string;
  repositoryOwnerId: string;
  workflowPath: string | null;
  jobWorkflowRef: string | null;
  refs: readonly string[];
  githubEnvironments: readonly string[];
  eventNames: readonly string[];
  subject: string | null;
}

export type GithubMismatch =
  | 'repository'
  | 'repository_owner'
  | 'workflow'
  | 'job_workflow'
  | 'ref'
  | 'environment'
  | 'event'
  | 'pull_request'
  | 'subject';

/** `refs/tags/v*` matches by prefix; anything else must match exactly. */
export function refMatches(pattern: string, ref: string): boolean {
  return pattern.endsWith('*') ? ref.startsWith(pattern.slice(0, -1)) : ref === pattern;
}

/**
 * The workflow file path from `workflow_ref` (`owner/repo/.github/workflows/x.yml@ref`),
 * or null when it does not belong to the token's own repository.
 */
export function workflowPathOf(
  claims: Pick<GithubClaims, 'repository' | 'workflow_ref'>,
): string | null {
  const at = claims.workflow_ref.lastIndexOf('@');
  const full = at === -1 ? claims.workflow_ref : claims.workflow_ref.slice(0, at);
  const prefix = `${claims.repository}/`;
  return full.startsWith(prefix) ? full.slice(prefix.length) : null;
}

/** The first condition the claims fail, or null when every condition holds. */
export function githubMismatch(
  conditions: GithubTrustConditions,
  claims: GithubClaims,
): GithubMismatch | null {
  // Stable ids decide; names can be renamed or registered again by someone else.
  if (claims.repository_id !== conditions.repositoryId) return 'repository';
  if (claims.repository_owner_id !== conditions.repositoryOwnerId) return 'repository_owner';
  if (PULL_REQUEST_EVENTS.includes(claims.event_name)) {
    if (claims.event_name === 'pull_request_target') return 'pull_request';
    if (!conditions.eventNames.includes(claims.event_name)) return 'pull_request';
  }
  if (conditions.eventNames.length > 0 && !conditions.eventNames.includes(claims.event_name)) {
    return 'event';
  }
  if (conditions.workflowPath !== null && workflowPathOf(claims) !== conditions.workflowPath) {
    return 'workflow';
  }
  if (conditions.jobWorkflowRef !== null && claims.job_workflow_ref !== conditions.jobWorkflowRef) {
    return 'job_workflow';
  }
  if (conditions.refs.length > 0 && !conditions.refs.some((p) => refMatches(p, claims.ref))) {
    return 'ref';
  }
  if (conditions.githubEnvironments.length > 0) {
    const environment = claims.environment?.toLowerCase();
    if (
      !environment ||
      !conditions.githubEnvironments.some((e) => e.toLowerCase() === environment)
    ) {
      return 'environment';
    }
  }
  if (conditions.subject !== null && claims.sub !== conditions.subject) return 'subject';
  return null;
}

/**
 * Why a binding is not strict enough to reach a protected environment, or an
 * empty list. Protected environments need a binding that pins the workflow to
 * reviewed code: named events that are not pull requests, and specific
 * branches or tags, or a GitHub deployment environment (which GitHub can guard
 * with required reviewers and branch rules).
 */
export function protectedPolicyProblems(
  conditions: Pick<GithubTrustConditions, 'refs' | 'githubEnvironments' | 'eventNames'>,
): string[] {
  const problems: string[] = [];
  if (conditions.eventNames.length === 0) {
    problems.push('List the events allowed to run (for example push or workflow_dispatch)');
  }
  if (conditions.eventNames.some((e) => PULL_REQUEST_EVENTS.includes(e))) {
    problems.push('Pull request events cannot reach a protected environment');
  }
  if (conditions.refs.length === 0 && conditions.githubEnvironments.length === 0) {
    problems.push('Restrict branches or tags, or require a GitHub deployment environment');
  }
  if (conditions.refs.some((r) => r.startsWith('refs/pull/'))) {
    problems.push('Pull request refs cannot reach a protected environment');
  }
  // `refs/heads/*` admits any branch anyone with push access creates.
  if (conditions.refs.some((r) => r.endsWith('*')) && conditions.githubEnvironments.length === 0) {
    problems.push('Wildcard refs also need a GitHub deployment environment');
  }
  return problems;
}
