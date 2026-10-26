/**
 * Action inputs, validated before anything is requested from GitHub or
 * EnvVault. Errors name the input, never a credential.
 */

export type AuthMode = 'oidc' | 'service-credential';
export type Shell = 'none' | 'bash' | 'sh' | 'pwsh' | 'cmd';

export interface ActionInputs {
  apiUrl: string;
  environment: string;
  workspaceId: string | undefined;
  projectId: string | undefined;
  bindingId: string | undefined;
  audience: string;
  authMode: AuthMode;
  serviceCredential: string | undefined;
  command: string;
  shell: Shell;
  workingDirectory: string | undefined;
  timeoutMinutes: number;
  keys: string[] | undefined;
  allowReservedKeys: string[];
  override: boolean;
  includeInherited: boolean;
  allowMissing: boolean;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_CREDENTIAL = /^evv_sk_[A-Za-z0-9]{16}_[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https only, except a loopback API for local testing. No user info, query or fragment. */
export function parseApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InputError(
      'api-url must be an absolute URL such as https://api.envvault.example.com',
    );
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new InputError('api-url must use https (plain http is accepted only for localhost)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new InputError('api-url must not contain credentials, a query or a fragment');
  }
  return url.origin;
}

function list(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function bool(name: string, value: string, fallback: boolean): boolean {
  if (value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new InputError(`${name} must be true or false`);
}

function uuid(name: string, value: string): string | undefined {
  if (value === '') return undefined;
  if (!UUID.test(value)) throw new InputError(`${name} must be an id (UUID)`);
  return value.toLowerCase();
}

/** `read(name)` returns the trimmed input or '' (as @actions/core getInput does). */
export function parseInputs(read: (name: string) => string): ActionInputs {
  const apiUrl = parseApiUrl(read('api-url'));
  const environment = read('environment');
  if (!environment) throw new InputError('environment is required (a name, slug or id)');
  if (environment.length > 128 || /[\p{Cc}]/u.test(environment)) {
    throw new InputError('environment is not a valid name, slug or id');
  }
  const command = read('command');
  if (!command) throw new InputError('command is required');

  const mode = read('auth-mode') || 'oidc';
  if (mode !== 'oidc' && mode !== 'service-credential') {
    throw new InputError('auth-mode must be oidc or service-credential');
  }
  const authMode: AuthMode = mode;
  const serviceCredential = read('service-credential') || undefined;
  if (authMode === 'service-credential') {
    if (!serviceCredential) {
      throw new InputError('auth-mode service-credential needs the service-credential input');
    }
    if (!SERVICE_CREDENTIAL.test(serviceCredential)) {
      throw new InputError('service-credential is not an EnvVault service credential');
    }
  } else if (serviceCredential) {
    // No silent fallback: a credential is used only when explicitly chosen.
    throw new InputError(
      'service-credential is set but auth-mode is oidc; set auth-mode: service-credential to use it',
    );
  }

  const audience = read('audience') || apiUrl;
  if (!/^[\x21-\x7e]{1,255}$/.test(audience)) {
    throw new InputError('audience must be printable characters without spaces');
  }
  const shell = (read('shell') || 'none') as Shell;
  if (!['none', 'bash', 'sh', 'pwsh', 'cmd'].includes(shell)) {
    throw new InputError('shell must be none, bash, sh, pwsh or cmd');
  }
  const timeoutText = read('command-timeout-minutes') || '0';
  const timeoutMinutes = Number(timeoutText);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 0 || timeoutMinutes > 360) {
    throw new InputError('command-timeout-minutes must be a whole number from 0 to 360');
  }
  const keysText = read('keys');
  return {
    apiUrl,
    environment,
    workspaceId: uuid('workspace-id', read('workspace-id')),
    projectId: uuid('project-id', read('project-id')),
    bindingId: uuid('binding-id', read('binding-id')),
    audience,
    authMode,
    serviceCredential,
    command,
    shell,
    workingDirectory: read('working-directory') || undefined,
    timeoutMinutes,
    keys: keysText ? list(keysText) : undefined,
    allowReservedKeys: list(read('allow-reserved-keys')),
    override: bool('override', read('override'), true),
    includeInherited: bool('include-inherited', read('include-inherited'), true),
    allowMissing: bool('allow-missing', read('allow-missing'), false),
  };
}
