import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import crossSpawn from 'cross-spawn';
import type { Context } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { withoutCredential } from '../machine.js';
import { machineRuntimeValues } from './machine.js';
import { launch, personRuntimeValues, type Spawner } from './run.js';

export type DockerMode = 'run' | 'compose';

export interface DockerOptions {
  env?: string;
  keys?: string[];
  docker?: string;
  allowMissing: boolean;
  inherited: boolean;
  quiet: boolean;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names that would reconfigure the docker CLI itself rather than the
 * container: DOCKER_HOST could send the values to another daemon, PATH or a
 * loader variable could run other code. They are never passed.
 */
export function refusedName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith('DOCKER_') ||
    upper.startsWith('COMPOSE_') ||
    upper.startsWith('BUILDKIT_') ||
    upper.startsWith('DYLD_') ||
    upper.startsWith('LD_') ||
    upper.startsWith('ENVVAULT_') ||
    ['PATH', 'HOME', 'SHELL', 'NODE_OPTIONS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(upper)
  );
}

/**
 * `docker run --env KEY ... <args>`: Docker takes each value from the docker
 * CLI's own environment, so no value is ever on a command line. Compose gets
 * the values in its environment and uses them as the Compose file says
 * (interpolation, `environment:` pass through, or `secrets:` files).
 */
export function dockerArguments(mode: DockerMode, keys: string[], userArgs: string[]): string[] {
  if (mode === 'compose') return ['compose', ...userArgs];
  return ['run', ...keys.flatMap((key) => ['--env', key]), ...userArgs];
}

/** The docker binary: an explicit absolute path that exists and is executable, or `docker` from PATH. */
export function dockerBinary(path: string | undefined): string {
  if (path === undefined) return 'docker';
  if (!isAbsolute(path)) {
    throw new CliError('--docker must be an absolute path to the docker executable', EXIT.usage);
  }
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
    accessSync(path, fsConstants.X_OK);
  } catch {
    throw new CliError(`${path} is not an executable file`, EXIT.usage);
  }
  return path;
}

/** Which loaded keys are passed, after the allowlist and the refused names. */
export function selectKeys(
  loaded: ReadonlyMap<string, string>,
  keys: string[] | undefined,
): { selected: string[]; refused: string[] } {
  if (keys) {
    const invalid = keys.filter((k) => !NAME.test(k));
    if (invalid.length > 0) {
      throw new CliError(`Not variable names: ${invalid.join(', ')}`, EXIT.usage);
    }
    const missing = keys.filter((k) => !loaded.has(k));
    if (missing.length > 0) {
      throw new CliError(`Not found in this environment: ${missing.join(', ')}`, EXIT.notFound);
    }
  }
  const wanted = keys ?? [...loaded.keys()];
  return {
    selected: wanted.filter((k) => !refusedName(k)).sort(),
    refused: wanted.filter((k) => refusedName(k)).sort(),
  };
}

/**
 * envvault docker run|compose: loads the environment's values and starts the
 * docker CLI with them in its environment only. Nothing is written to disk
 * and no value is put on a command line. Container environment variables
 * are visible to anyone who can run `docker inspect` on the host; use
 * Compose secrets for values that should appear as files instead.
 */
export async function docker(
  ctx: Context,
  mode: DockerMode,
  userArgs: string[],
  options: DockerOptions,
  spawner: Spawner = crossSpawn,
): Promise<number> {
  if (mode === 'run' && userArgs.length === 0) {
    throw new CliError(
      'Give the image and its options after --, for example: envvault docker run -- --rm my-image',
      EXIT.usage,
    );
  }
  const binary = dockerBinary(options.docker);
  const { environment, loaded } = ctx.machine
    ? await machineRuntimeValues(ctx, options)
    : await personRuntimeValues(ctx, { ...options, override: true });
  if (loaded.missingRequired.length > 0 && !options.allowMissing) {
    throw new CliError(
      `Required variables have no value in ${environment.name}: ${loaded.missingRequired.join(', ')}`,
      EXIT.missingSecrets,
      'Set them in EnvVault, or pass --allow-missing to run anyway.',
    );
  }
  const values = new Map(loaded.values.map((v) => [v.key, v.value]));
  loaded.values.length = 0;
  const { selected, refused } = selectKeys(values, options.keys);
  const env: NodeJS.ProcessEnv = { ...withoutCredential(process.env) };
  for (const key of selected) env[key] = values.get(key);
  values.clear();
  if (!options.quiet) {
    if (refused.length > 0) {
      ctx.note(`Not passed (they would reconfigure Docker itself): ${refused.join(', ')}`);
    }
    ctx.note(
      `Passing ${String(selected.length)} variables from ${environment.name}; values are not shown.`,
    );
    if (mode === 'run') {
      ctx.note(
        'Container environment variables can be read with docker inspect by anyone with access to this Docker host.',
      );
    }
  }
  return launch(binary, dockerArguments(mode, selected, userArgs), env, ctx.io.cwd, spawner);
}
