import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { CliError, EXIT } from './errors.js';

export const PROJECT_CONFIG_FILE = '.envvault.json';
export const DEFAULT_API_URL = 'http://localhost:4000';

/**
 * The link between a directory and an EnvVault project. Ids and an API
 * address only: never values, tokens or other credentials, so it can be
 * committed.
 */
export const projectConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    apiUrl: z.url({ protocol: /^https?$/ }).optional(),
    workspaceId: z.uuid(),
    projectId: z.uuid(),
    environmentId: z.uuid().optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const userConfigSchema = z
  .object({
    apiUrl: z.url({ protocol: /^https?$/ }).optional(),
    workspaceId: z.uuid().optional(),
  })
  .strict();
export type UserConfig = z.infer<typeof userConfigSchema>;

export interface FoundProjectConfig {
  path: string;
  config: ProjectConfig;
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CliError(`Cannot read ${path}.`, EXIT.config);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError(
      `${path} is not valid JSON.`,
      EXIT.config,
      'Fix it, or run envvault init to recreate it.',
    );
  }
}

/** Looks for .envvault.json in `cwd` and its parents, like Git does. */
export async function findProjectConfig(cwd: string): Promise<FoundProjectConfig | null> {
  let dir = resolve(cwd);
  const { root } = parse(dir);
  for (;;) {
    const path = join(dir, PROJECT_CONFIG_FILE);
    const raw = await readJson(path);
    if (raw !== undefined) {
      const parsed = projectConfigSchema.safeParse(raw);
      if (!parsed.success) {
        const where = parsed.error.issues[0]?.path ?? [];
        const field = where.length > 0 ? where.join('.') : 'file';
        throw new CliError(
          `${path} is not a valid EnvVault configuration (${field}).`,
          EXIT.config,
          'Run envvault init to link again.',
        );
      }
      return { path, config: parsed.data };
    }
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

export async function requireProjectConfig(cwd: string): Promise<FoundProjectConfig> {
  const found = await findProjectConfig(cwd);
  if (!found) {
    throw new CliError(
      'This directory is not linked to an EnvVault project.',
      EXIT.config,
      'Run envvault init.',
    );
  }
  return found;
}

/** Writes via a temporary file and rename, so a crash never leaves half a file. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export async function writeProjectConfig(path: string, config: ProjectConfig): Promise<void> {
  await writeJson(path, projectConfigSchema.parse(config));
}

export async function readUserConfig(dir: string): Promise<UserConfig> {
  const raw = await readJson(join(dir, 'config.json'));
  if (raw === undefined) return {};
  const parsed = userConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(`${join(dir, 'config.json')} is not a valid configuration.`, EXIT.config);
  }
  return parsed.data;
}

export async function writeUserConfig(dir: string, config: UserConfig): Promise<void> {
  await writeJson(join(dir, 'config.json'), userConfigSchema.parse(config));
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * The API origin. Tokens and values must not cross the network in clear
 * text, so http is accepted only for this machine.
 */
export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Invalid API address: ${value}`, EXIT.usage);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new CliError('The API address must use https (http only for localhost).', EXIT.usage);
  }
  return url.origin;
}
