/**
 * Builds the child process environment: the step's environment without the
 * runner's control variables and credentials, plus the EnvVault values,
 * following a fixed precedence and naming policy (docs/integrations/github-actions.md).
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

/**
 * Names EnvVault never sets: they steer the runner, hold its credentials, or
 * change what code the child runs. The first group cannot be allowed at all.
 */
const FORBIDDEN_PREFIXES = ['GITHUB_', 'RUNNER_', 'ACTIONS_', 'INPUT_', 'STATE_'];
const RESERVED = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'IFS',
  'ENV',
  'BASH_ENV',
  'PS4',
  'PROMPT_COMMAND',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CI',
]);
const RESERVED_PREFIXES = ['DYLD_', 'ENVVAULT_', 'BASH_FUNC_'];

/** Removed from the child's environment whatever the step set. */
const STRIPPED_PREFIXES = ['INPUT_', 'STATE_'];
const STRIPPED = new Set([
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ENVVAULT_SERVICE_CREDENTIAL',
  'ENVVAULT_SERVICE_CREDENTIAL_FILE',
]);

export class EnvironmentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentPolicyError';
  }
}

export type NameVerdict = 'ok' | 'invalid' | 'forbidden' | 'reserved';

export function judgeName(name: string): NameVerdict {
  if (!NAME.test(name)) return 'invalid';
  const upper = name.toUpperCase();
  if (FORBIDDEN_PREFIXES.some((p) => upper.startsWith(p))) return 'forbidden';
  if (RESERVED.has(upper) || RESERVED_PREFIXES.some((p) => upper.startsWith(p))) {
    return 'reserved';
  }
  return 'ok';
}

export interface MergeOptions {
  /** Only these keys are passed on (all when undefined). */
  keys: string[] | undefined;
  /** Reserved names the workflow explicitly accepts. Forbidden ones stay refused. */
  allowReservedKeys: string[];
  /** EnvVault values replace variables the step already has (default). */
  override: boolean;
}

export interface MergedEnvironment {
  env: Record<string, string>;
  /** Keys passed to the child. */
  applied: string[];
  /** Keys kept from the step because `override` is off. */
  kept: string[];
}

/**
 * The child's environment. Fails, before anything runs, on a value whose
 * name is invalid or steers the runner, so a misconfigured variable cannot
 * hijack the job. Key names are not secret and appear in the error.
 */
export function mergeEnvironment(
  base: NodeJS.ProcessEnv,
  values: Record<string, string>,
  options: MergeOptions,
): MergedEnvironment {
  const allowed = new Set(options.allowReservedKeys.map((k) => k.toUpperCase()));
  const wanted = options.keys ? new Set(options.keys) : null;
  const problems: string[] = [];
  const selected: [string, string][] = [];
  for (const [key, value] of Object.entries(values)) {
    if (wanted && !wanted.has(key)) continue;
    const verdict = judgeName(key);
    if (verdict === 'invalid') problems.push(`${key} is not a valid variable name`);
    else if (verdict === 'forbidden') problems.push(`${key} would steer the GitHub runner`);
    else if (verdict === 'reserved' && !allowed.has(key.toUpperCase())) {
      problems.push(`${key} is reserved (list it in allow-reserved-keys to accept it)`);
    } else selected.push([key, value]);
  }
  if (wanted) {
    const missing = [...wanted].filter((k) => !(k in values));
    if (missing.length > 0) problems.push(`not found in EnvVault: ${missing.join(', ')}`);
  }
  if (problems.length > 0) throw new EnvironmentPolicyError(problems.join('; '));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (STRIPPED.has(upper) || STRIPPED_PREFIXES.some((p) => upper.startsWith(p))) continue;
    env[key] = value;
  }
  const applied: string[] = [];
  const kept: string[] = [];
  for (const [key, value] of selected) {
    if (!options.override && key in env) {
      kept.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { env, applied, kept };
}
