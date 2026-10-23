import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { constants } from 'node:os';
import crossSpawn from 'cross-spawn';
import { requireProjectConfig } from '../config.js';
import type { Context } from '../context.js';
import { CliError, EXIT, toCliError } from '../errors.js';
import { signedIn } from '../session.js';
import { resolveEnvironment } from './link.js';

export type Spawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Signals passed on to the child; the CLI itself then waits for the child to exit. */
const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
/**
 * From a terminal, Ctrl+C and Ctrl+\ already reach the child (same process
 * group); sending them again would interrupt it twice.
 */
const FROM_TERMINAL: ReadonlySet<NodeJS.Signals> = new Set(['SIGINT', 'SIGQUIT']);

export interface RunOptions {
  env?: string;
  override: boolean;
  allowMissing: boolean;
  inherited: boolean;
  quiet: boolean;
}

/**
 * envvault run: loads the environment's values and starts `command` with
 * them in its environment. Nothing is written to disk, printed or put on a
 * command line. The child, and anyone allowed to inspect its process (the
 * same user, administrators), can read its environment; that is how
 * environment variables work on every operating system.
 */
export async function run(
  ctx: Context,
  command: string[],
  options: RunOptions,
  spawner: Spawner = crossSpawn,
): Promise<number> {
  const [file, ...args] = command;
  if (!file)
    throw new CliError(
      'Give a command to run after --, for example: envvault run -- npm run dev',
      EXIT.usage,
    );
  const session = await signedIn(ctx);
  const { config } = await requireProjectConfig(ctx.io.cwd);
  const environments = (
    await session.api.listEnvironments(config.workspaceId, config.projectId, { pageSize: 200 })
  ).items;
  const environment = resolveEnvironment(environments, options.env, config.environmentId);

  let values: Map<string, string>;
  try {
    const loaded = await session.api.runtimeConfiguration(
      config.workspaceId,
      config.projectId,
      environment.id,
      {
        includeInherited: options.inherited,
      },
    );
    if (loaded.missingRequired.length > 0 && !options.allowMissing) {
      throw new CliError(
        `Required variables have no value in ${environment.name}: ${loaded.missingRequired.join(', ')}`,
        EXIT.missingSecrets,
        'Set them in EnvVault, or pass --allow-missing to run anyway.',
      );
    }
    if (loaded.withheldInherited > 0 && !options.quiet) {
      ctx.note(
        `${String(loaded.withheldInherited)} inherited variables were left out: you may not load the base environment.`,
      );
    }
    values = new Map(loaded.values.map((v) => [v.key, v.value]));
  } catch (error) {
    throw toCliError(
      error,
      session.credential.webUrl ? { confirmUrl: `${session.credential.webUrl}/cli/confirm` } : {},
    );
  }

  const { env: childEnv, kept } = childEnvironment(process.env, values, options.override);
  const count = values.size;
  // Drop our references as soon as the child has its copy; JavaScript cannot wipe strings.
  values.clear();
  if (!options.quiet) {
    ctx.note(
      `Loaded ${String(count - kept)} variables from ${environment.name}${kept > 0 ? ` (kept ${String(kept)} already set)` : ''}; values are not shown.`,
    );
  }
  return launch(file, args, childEnv, ctx.io.cwd, spawner);
}

/** The parent environment plus the loaded values; with `override` off, variables already set win. */
export function childEnvironment(
  base: NodeJS.ProcessEnv,
  values: ReadonlyMap<string, string>,
  override: boolean,
): { env: NodeJS.ProcessEnv; kept: number } {
  const env: NodeJS.ProcessEnv = { ...base };
  let kept = 0;
  for (const [key, value] of values) {
    if (!override && env[key] !== undefined) {
      kept++;
      continue;
    }
    env[key] = value;
  }
  return { env, kept };
}

/**
 * Starts the child without a shell, forwards termination signals and
 * resolves with its exit code (128 + signal number when a signal ended it,
 * 127 when the command does not exist).
 */
export function launch(
  file: string,
  args: string[],
  childEnv: NodeJS.ProcessEnv,
  cwd: string,
  spawner: Spawner,
  terminal = process.stdin.isTTY,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawner(file, args, { stdio: 'inherit', env: childEnv, shell: false, cwd });
    } catch {
      reject(new CliError(`Could not start ${file}.`, EXIT.failure));
      return;
    }
    const forward = (signal: NodeJS.Signals) => {
      if (terminal && FROM_TERMINAL.has(signal)) return;
      if (child.exitCode === null) child.kill(signal);
    };
    for (const signal of FORWARDED) process.on(signal, forward);
    const cleanup = () => {
      for (const signal of FORWARDED) process.removeListener(signal, forward);
      for (const key of Object.keys(childEnv)) Reflect.deleteProperty(childEnv, key);
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        new CliError(
          error.code === 'ENOENT' ? `Command not found: ${file}` : `Could not start ${file}.`,
          error.code === 'ENOENT' ? 127 : EXIT.failure,
        ),
      );
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code !== null) resolve(code);
      else if (signal) resolve(128 + constants.signals[signal]);
      else resolve(EXIT.failure);
    });
  });
}
