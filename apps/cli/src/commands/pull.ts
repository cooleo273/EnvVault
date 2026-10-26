import { spawnSync } from 'node:child_process';
import { appendFile, chmod, link, lstat, open, readFile, rename, rm, stat } from 'node:fs/promises';
import nodePath, { basename, dirname, join, relative, sep, type PlatformPath } from 'node:path';
import { requireProjectConfig } from '../config.js';
import type { Context } from '../context.js';
import { CliError, EXIT, toCliError } from '../errors.js';
import { terminalPrompts } from '../prompts.js';
import { signedIn } from '../session.js';
import { resolveEnvironment } from './link.js';

/** Directories that web servers and bundlers publish or ship. */
const PUBLISHED = new Set([
  'public',
  'static',
  'www',
  'dist',
  'build',
  'out',
  '.next',
  'node_modules',
]);

/** Where a plaintext file may go: inside the project and outside published directories. */
export function checkOutputPath(
  projectRoot: string,
  cwd: string,
  output: string,
  paths: PlatformPath = nodePath,
): string {
  const target = paths.resolve(cwd, output);
  const within = (dir: string) => {
    const rel = paths.relative(dir, target);
    return rel !== '' && !rel.startsWith('..') && !paths.isAbsolute(rel);
  };
  if (!within(projectRoot)) {
    throw new CliError('The output file must be inside the linked project directory.', EXIT.usage);
  }
  const segments = paths.relative(projectRoot, target).split(paths.sep);
  if (segments.some((segment) => PUBLISHED.has(segment.toLowerCase()))) {
    throw new CliError(
      'Refusing to write secrets into a directory that is published or shipped.',
      EXIT.usage,
    );
  }
  return target;
}

/** A directory other users may write to (such as /tmp) lets them swap or watch the file. */
async function assertPrivateDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new CliError(`${dir} does not exist.`, EXIT.usage);
  if ((info.mode & 0o002) !== 0) {
    throw new CliError(
      'Refusing to write secrets into a directory every user can write to.',
      EXIT.usage,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates or replaces the file with owner only permissions, through a temporary file. */
async function writePrivate(path: string, content: string, replace: boolean): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${String(process.pid)}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    if (replace) await rename(temporary, path);
    else {
      await link(temporary, path);
      await rm(temporary, { force: true });
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Adds the file to .gitignore when Git would otherwise pick it up. */
async function ignoreInGit(
  projectRoot: string,
  path: string,
): Promise<'ignored' | 'added' | 'no-git'> {
  const check = spawnSync('git', ['check-ignore', '-q', path], {
    cwd: projectRoot,
    stdio: 'ignore',
    shell: false,
  });
  if (check.error || check.status === 128) return 'no-git';
  if (check.status === 0) return 'ignored';
  const gitignore = join(projectRoot, '.gitignore');
  const current = await readFile(gitignore, 'utf8').catch(() => '');
  const entry = `/${relative(projectRoot, path).split(sep).join('/')}`;
  const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(
    gitignore,
    `${prefix}# Plaintext secrets written by envvault pull\n${entry}\n`,
    'utf8',
  );
  return 'added';
}

export interface PullOptions {
  env?: string;
  output: string;
  force: boolean;
  gitignore: boolean;
}

/**
 * envvault pull: writes a plaintext .env file. Needs `secret:export` (and
 * `secret:read`), goes through the API's export limits and audit, and asks
 * before replacing a file. `envvault run` avoids the file altogether.
 */
export async function pull(ctx: Context, options: PullOptions): Promise<number> {
  const session = await signedIn(ctx);
  const found = await requireProjectConfig(ctx.io.cwd);
  const root = dirname(found.path);
  const target = checkOutputPath(root, ctx.io.cwd, options.output);
  await assertPrivateDirectory(dirname(target));
  const environments = (
    await session.api.listEnvironments(found.config.workspaceId, found.config.projectId, {
      pageSize: 200,
    })
  ).items;
  const environment = resolveEnvironment(environments, options.env, found.config.environmentId);

  const replace = await exists(target);
  if (replace && !options.force) {
    if (!ctx.io.interactive) {
      throw new CliError(`${target} exists.`, EXIT.usage, 'Pass --force to replace it.');
    }
    const prompts = ctx.io.prompts ?? terminalPrompts;
    if (
      !(await prompts.confirm(
        `${target} exists. Replace it with plaintext values from ${environment.name}?`,
        false,
      ))
    ) {
      return EXIT.ok;
    }
  }

  let content: string;
  let count: number;
  let skipped: number;
  try {
    const result = await session.api.exportSecrets(
      found.config.workspaceId,
      found.config.projectId,
      environment.id,
      {
        format: 'dotenv',
      },
    );
    content = result.content;
    count = result.count;
    skipped = result.skipped.length + result.warnings.length;
  } catch (error) {
    const cli = toCliError(
      error,
      session.credential.webUrl ? { confirmUrl: `${session.credential.webUrl}/cli/confirm` } : {},
    );
    if (cli.exitCode === EXIT.forbidden && !cli.hint) {
      throw new CliError(
        cli.message,
        cli.exitCode,
        'Writing a .env file needs secret:export. envvault run needs only secret:runtime.',
      );
    }
    throw cli;
  }
  await writePrivate(target, content, replace);
  const git = options.gitignore ? await ignoreInGit(root, target) : 'no-git';

  ctx.note(
    ctx.paint.yellow(
      `Warning: ${target} contains plaintext secrets. Prefer envvault run, and delete the file when you are done.`,
    ),
  );
  if (git === 'added') ctx.note('Added it to .gitignore.');
  if (process.platform === 'win32')
    ctx.note('On Windows the file inherits the permissions of its folder.');
  if (ctx.json)
    ctx.printJson({ path: target, environment: environment.name, count, skipped, gitignore: git });
  else
    ctx.out(
      `Wrote ${String(count)} variables from ${environment.name} to ${target}${skipped > 0 ? ` (${String(skipped)} left out)` : ''}.`,
    );
  return EXIT.ok;
}
