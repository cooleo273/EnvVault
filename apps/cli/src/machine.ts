import { readFile, stat } from 'node:fs/promises';
import type { EnvVaultClient } from '@envvault/sdk';
import {
  type MachineEnvironment,
  type MachineToken,
  type MachineTokenInput,
  SERVICE_CREDENTIAL_PATTERN,
} from '@envvault/shared';
import type { Context } from './context.js';
import { CliError, EXIT, toCliError } from './errors.js';

/** Where CI systems put the credential: a masked secret variable, or a file only the job can read. */
export const CREDENTIAL_ENV = 'ENVVAULT_SERVICE_CREDENTIAL';
export const CREDENTIAL_FILE_ENV = 'ENVVAULT_SERVICE_CREDENTIAL_FILE';

export type CredentialSource = { kind: 'env' } | { kind: 'file'; path: string } | { kind: 'stdin' };

/** True when the environment selects machine authentication for every command. */
export function machineMode(env: Record<string, string | undefined>): boolean {
  return Boolean(env[CREDENTIAL_ENV] ?? env[CREDENTIAL_FILE_ENV]);
}

/** The parent environment without the credential, for child processes. */
export function withoutCredential(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  Reflect.deleteProperty(copy, CREDENTIAL_ENV);
  Reflect.deleteProperty(copy, CREDENTIAL_FILE_ENV);
  return copy;
}

function checked(value: string, origin: string): string {
  const token = value.trim();
  if (!SERVICE_CREDENTIAL_PATTERN.test(token)) {
    // Never echo what was read: it may be a different secret pasted by mistake.
    throw new CliError(`${origin} does not hold an EnvVault service credential.`, EXIT.config);
  }
  return token;
}

async function fromFile(path: string): Promise<string> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new CliError(`Cannot read the credential file ${path}.`, EXIT.config);
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new CliError(
      'The credential file can be read by other users.',
      EXIT.config,
      `Run: chmod 600 "${path}"`,
    );
  }
  return checked(await readFile(path, 'utf8'), 'The credential file');
}

/**
 * Reads the service credential from the chosen source, or from
 * ENVVAULT_SERVICE_CREDENTIAL, then ENVVAULT_SERVICE_CREDENTIAL_FILE. There
 * is deliberately no command line argument: arguments end up in shell
 * history, process listings and CI logs.
 */
export async function readServiceCredential(
  ctx: Context,
  source?: CredentialSource,
): Promise<string> {
  if (source?.kind === 'file') return fromFile(source.path);
  if (source?.kind === 'stdin') {
    if (!ctx.io.readStdin) throw new CliError('No input to read the credential from.', EXIT.usage);
    return checked(await ctx.io.readStdin(), 'Standard input');
  }
  const inline = ctx.io.env[CREDENTIAL_ENV];
  if (inline) return checked(inline, CREDENTIAL_ENV);
  const file = ctx.io.env[CREDENTIAL_FILE_ENV];
  if (file) return fromFile(file);
  throw new CliError(
    'No service credential found.',
    EXIT.auth,
    `Set ${CREDENTIAL_ENV} (or ${CREDENTIAL_FILE_ENV}) from your CI system's secret store.`,
  );
}

export interface MachineSession {
  api: EnvVaultClient;
  apiUrl: string;
  token: MachineToken;
  /** Ends the access token on the server; best effort, it expires within 15 minutes anyway. */
  end(): Promise<void>;
}

/** Exchanges the credential for an access token used by this command only. */
export async function machineSession(
  ctx: Context,
  source?: CredentialSource,
  input: MachineTokenInput = {},
): Promise<MachineSession> {
  const credential = await readServiceCredential(ctx, source);
  const apiUrl = await ctx.apiUrl();
  let token: MachineToken;
  try {
    const anonymous = ctx.client(apiUrl);
    await anonymous.checkCompatibility();
    token = await anonymous.exchangeServiceCredential(credential, input);
  } catch (error) {
    throw toCliError(error, { machine: true });
  }
  const api = ctx.client(apiUrl, () => Promise.resolve(token.accessToken));
  return {
    api,
    apiUrl,
    token,
    end: () => api.revokeMachineToken().catch(() => undefined),
  };
}

function matches(env: MachineEnvironment, ref: string): boolean {
  const lower = ref.toLowerCase();
  return env.id === lower || env.slug === lower || env.name.toLowerCase() === lower;
}

/** Picks an environment the identity can read, by name, slug or id. */
export function resolveMachineEnvironment(
  items: MachineEnvironment[],
  ref: string | undefined,
  fallbackId: string | undefined,
): MachineEnvironment {
  const wanted = ref ?? fallbackId;
  if (!wanted) {
    throw new CliError(
      'No environment chosen.',
      EXIT.usage,
      'Pass --env <name>, or link the directory with a default environment.',
    );
  }
  const found = items.find((env) => matches(env, wanted));
  if (!found) {
    throw new CliError(
      `This machine identity has no access to an environment "${wanted}".`,
      EXIT.notFound,
      'Grant it a role on that environment in the project settings.',
    );
  }
  if (found.status === 'ARCHIVED') {
    throw new CliError(`The environment ${found.name} is archived.`, EXIT.notFound);
  }
  return found;
}

/** Refused in machine mode: these act as a person. */
export function personOnly(command: string): CliError {
  return new CliError(
    `envvault ${command} is not available with a service credential.`,
    EXIT.usage,
    `Unset ${CREDENTIAL_ENV} and ${CREDENTIAL_FILE_ENV} to act as yourself.`,
  );
}
