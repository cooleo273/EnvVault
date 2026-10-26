import { join } from 'node:path';
import type { EnvVaultClient } from '@envvault/sdk';
import type { EnvironmentSummary, ProjectSummary, WorkspaceSummary } from '@envvault/shared';
import {
  DEFAULT_API_URL,
  PROJECT_CONFIG_FILE,
  type ProjectConfig,
  requireProjectConfig,
  writeProjectConfig,
  writeUserConfig,
} from '../config.js';
import { type Choice, type Context, table } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { terminalPrompts } from '../prompts.js';
import { signedIn } from '../session.js';

function matches(item: { id: string; slug: string; name: string }, ref: string): boolean {
  const lower = ref.toLowerCase();
  return item.id === lower || item.slug === lower || item.name.toLowerCase() === lower;
}

/** Picks by id, slug or name; asks on a terminal; otherwise names the flag to use. */
async function choose<T extends { id: string; slug: string; name: string }>(
  ctx: Context,
  items: T[],
  ref: string | undefined,
  what: string,
  flag: string,
  describe: (item: T) => string = () => '',
): Promise<T> {
  if (ref) {
    const found = items.find((item) => matches(item, ref));
    // Never confirm whether an inaccessible item exists: the lists only hold what the caller may see.
    if (!found) throw new CliError(`No ${what} "${ref}" that you can access.`, EXIT.notFound);
    return found;
  }
  const [only] = items;
  if (items.length === 1 && only) return only;
  if (items.length === 0) throw new CliError(`You have no ${what}s you can access.`, EXIT.notFound);
  if (!ctx.io.interactive) {
    throw new CliError(`Choose a ${what} with ${flag} <name, slug or id>.`, EXIT.usage);
  }
  const prompts = ctx.io.prompts ?? terminalPrompts;
  const choices: Choice<T>[] = items.map((item) => ({
    name: item.name,
    value: item,
    description: describe(item),
  }));
  return prompts.select(`Choose a ${what}`, choices);
}

async function workspaces(api: EnvVaultClient): Promise<WorkspaceSummary[]> {
  return api.listWorkspaces();
}

async function projects(api: EnvVaultClient, workspaceId: string): Promise<ProjectSummary[]> {
  return (await api.listProjects(workspaceId, { pageSize: 100 })).items;
}

async function environments(
  api: EnvVaultClient,
  config: { workspaceId: string; projectId: string },
) {
  return (await api.listEnvironments(config.workspaceId, config.projectId, { pageSize: 200 }))
    .items;
}

export function resolveEnvironment(
  items: EnvironmentSummary[],
  ref: string | undefined,
  fallbackId: string | undefined,
): EnvironmentSummary {
  const wanted = ref ?? fallbackId;
  if (!wanted) {
    throw new CliError(
      'No environment chosen.',
      EXIT.usage,
      'Pass --env <name>, or set a default with envvault env use <name>.',
    );
  }
  const found = items.find((env) => matches(env, wanted));
  if (!found) {
    throw new CliError(
      ref
        ? `No environment "${ref}" that you can access in this project.`
        : 'The default environment no longer exists or you lost access to it.',
      EXIT.notFound,
      'See envvault env list.',
    );
  }
  if (found.status === 'ARCHIVED') {
    throw new CliError(
      `The environment ${found.name} is archived.`,
      EXIT.notFound,
      'Pick another one with envvault env use.',
    );
  }
  return found;
}

/**
 * envvault init: links this directory to a workspace, project and default
 * environment by writing .envvault.json (ids only). It never writes a .env
 * file or any value.
 */
export async function init(
  ctx: Context,
  options: { workspace?: string; project?: string; env?: string; force?: boolean },
): Promise<number> {
  const session = await signedIn(ctx);
  const existing = await ctx.project();
  const target = existing?.path ?? join(ctx.io.cwd, PROJECT_CONFIG_FILE);
  if (existing && !options.force) {
    if (!ctx.io.interactive) {
      throw new CliError(
        `${existing.path} already links this directory.`,
        EXIT.usage,
        'Pass --force to link it again.',
      );
    }
    const prompts = ctx.io.prompts ?? terminalPrompts;
    if (
      !(await prompts.confirm(
        `${existing.path} already links this directory. Link it again?`,
        false,
      ))
    ) {
      return EXIT.ok;
    }
  }
  const workspace = await choose(
    ctx,
    await workspaces(session.api),
    options.workspace,
    'workspace',
    '--workspace',
  );
  const liveProjects = (await projects(session.api, workspace.id)).filter(
    (p) => p.status === 'ACTIVE',
  );
  const project = await choose(
    ctx,
    liveProjects,
    options.project,
    'project',
    '--project',
    (p) => p.description ?? '',
  );
  const envs = (
    await environments(session.api, { workspaceId: workspace.id, projectId: project.id })
  ).filter((e) => e.status === 'ACTIVE');
  const environment = await choose(ctx, envs, options.env, 'environment', '--env', (e) =>
    e.isProtected ? 'protected' : e.kind.toLowerCase(),
  );
  const apiUrl = await ctx.apiUrl();
  const config: ProjectConfig = {
    version: 1,
    ...(apiUrl === DEFAULT_API_URL ? {} : { apiUrl }),
    workspaceId: workspace.id,
    projectId: project.id,
    environmentId: environment.id,
  };
  await writeProjectConfig(target, config);
  if (ctx.json) ctx.printJson({ path: target, ...config });
  else {
    ctx.out(
      `Linked to ${workspace.name} / ${project.name}, default environment ${environment.name}.`,
    );
    ctx.out(
      `Wrote ${target} (ids only; safe to commit). Run your app with: envvault run -- <command>`,
    );
  }
  return EXIT.ok;
}

export async function workspaceList(ctx: Context): Promise<number> {
  const session = await signedIn(ctx);
  const items = await workspaces(session.api);
  const linked = (await ctx.project())?.config.workspaceId ?? (await ctx.user()).workspaceId;
  if (ctx.json) {
    ctx.printJson(
      items.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        role: w.role.key,
        current: w.id === linked,
      })),
    );
    return EXIT.ok;
  }
  if (items.length === 0) {
    ctx.out('You are not a member of any workspace.');
    return EXIT.ok;
  }
  ctx.out(
    table([
      ['', 'NAME', 'SLUG', 'ROLE'],
      ...items.map((w) => [w.id === linked ? '*' : '', w.name, w.slug, w.role.name]),
    ]),
  );
  return EXIT.ok;
}

/** Remembers a workspace for project commands outside a linked directory. */
export async function workspaceUse(ctx: Context, ref: string): Promise<number> {
  const session = await signedIn(ctx);
  const workspace = await choose(
    ctx,
    await workspaces(session.api),
    ref,
    'workspace',
    '<workspace>',
  );
  await writeUserConfig(ctx.dir, { ...(await ctx.user()), workspaceId: workspace.id });
  ctx.out(`Using workspace ${workspace.name} outside linked directories.`);
  return EXIT.ok;
}

async function currentWorkspaceId(
  ctx: Context,
  flag: string | undefined,
  api: EnvVaultClient,
): Promise<string> {
  if (flag) return (await choose(ctx, await workspaces(api), flag, 'workspace', '--workspace')).id;
  const linked = (await ctx.project())?.config.workspaceId ?? (await ctx.user()).workspaceId;
  if (linked) return linked;
  return (await choose(ctx, await workspaces(api), undefined, 'workspace', '--workspace')).id;
}

export async function projectList(
  ctx: Context,
  options: { workspace?: string; all?: boolean },
): Promise<number> {
  const session = await signedIn(ctx);
  const workspaceId = await currentWorkspaceId(ctx, options.workspace, session.api);
  const items = (await projects(session.api, workspaceId)).filter(
    (p) => options.all === true || p.status === 'ACTIVE',
  );
  const linked = (await ctx.project())?.config.projectId;
  if (ctx.json) {
    ctx.printJson(
      items.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        status: p.status,
        environments: p.environmentCount,
        current: p.id === linked,
      })),
    );
    return EXIT.ok;
  }
  if (items.length === 0) {
    ctx.out('No projects you can access in this workspace.');
    return EXIT.ok;
  }
  ctx.out(
    table([
      ['', 'NAME', 'SLUG', 'ENVIRONMENTS', 'STATUS'],
      ...items.map((p) => [
        p.id === linked ? '*' : '',
        p.name,
        p.slug,
        String(p.environmentCount),
        p.status.toLowerCase(),
      ]),
    ]),
  );
  return EXIT.ok;
}

/** Links this directory to another project (keeps the workspace, drops the default environment). */
export async function projectUse(
  ctx: Context,
  ref: string,
  options: { workspace?: string },
): Promise<number> {
  const session = await signedIn(ctx);
  const existing = await ctx.project();
  const workspaceId = await currentWorkspaceId(ctx, options.workspace, session.api);
  const project = await choose(
    ctx,
    (await projects(session.api, workspaceId)).filter((p) => p.status === 'ACTIVE'),
    ref,
    'project',
    '<project>',
  );
  const path = existing?.path ?? join(ctx.io.cwd, PROJECT_CONFIG_FILE);
  await writeProjectConfig(path, {
    version: 1,
    ...(existing?.config.apiUrl ? { apiUrl: existing.config.apiUrl } : {}),
    workspaceId,
    projectId: project.id,
  });
  ctx.out(
    `Linked ${path} to ${project.name}. Choose a default environment with envvault env use <name>.`,
  );
  return EXIT.ok;
}

export async function projectInfo(ctx: Context): Promise<number> {
  const session = await signedIn(ctx);
  const { config } = await requireProjectConfig(ctx.io.cwd);
  const project = await session.api.getProject(config.workspaceId, config.projectId);
  const info = {
    id: project.id,
    name: project.name,
    slug: project.slug,
    status: project.status,
    environments: project.environmentCount,
    protectedEnvironments: project.protectedEnvironmentCount,
    access: project.access.role?.name ?? project.access.source,
  };
  if (ctx.json) ctx.printJson(info);
  else {
    ctx.out(
      table([
        ['Project', `${info.name} (${info.slug})`],
        ['Status', info.status.toLowerCase()],
        [
          'Environments',
          `${String(info.environments)} (${String(info.protectedEnvironments)} protected)`,
        ],
        ['Your access', info.access],
      ]),
    );
  }
  if (project.status === 'ARCHIVED')
    ctx.note('This project is archived: values can be read but not changed.');
  return EXIT.ok;
}

export async function envList(ctx: Context): Promise<number> {
  const session = await signedIn(ctx);
  const { config } = await requireProjectConfig(ctx.io.cwd);
  const items = await environments(session.api, config);
  if (ctx.json) {
    ctx.printJson(
      items.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        kind: e.kind,
        protected: e.isProtected,
        status: e.status,
        current: e.id === config.environmentId,
      })),
    );
    return EXIT.ok;
  }
  ctx.out(
    table([
      ['', 'NAME', 'SLUG', 'TYPE', 'PROTECTED', 'STATUS'],
      ...items.map((e) => [
        e.id === config.environmentId ? '*' : '',
        e.name,
        e.slug,
        e.kind.toLowerCase(),
        e.isProtected ? 'yes' : 'no',
        e.status.toLowerCase(),
      ]),
    ]),
  );
  return EXIT.ok;
}

export async function envUse(ctx: Context, ref: string): Promise<number> {
  const session = await signedIn(ctx);
  const found = await requireProjectConfig(ctx.io.cwd);
  const environment = resolveEnvironment(
    await environments(session.api, found.config),
    ref,
    undefined,
  );
  await writeProjectConfig(found.path, { ...found.config, environmentId: environment.id });
  ctx.out(
    `Default environment: ${environment.name}${environment.isProtected ? ' (protected)' : ''}.`,
  );
  return EXIT.ok;
}

export async function envInfo(ctx: Context, ref: string | undefined): Promise<number> {
  const session = await signedIn(ctx);
  const { config } = await requireProjectConfig(ctx.io.cwd);
  const summary = resolveEnvironment(
    await environments(session.api, config),
    ref,
    config.environmentId,
  );
  const detail = await session.api.getEnvironment(config.workspaceId, config.projectId, summary.id);
  const can = (permission: string) => detail.permissions.includes(permission);
  const info = {
    id: detail.id,
    name: detail.name,
    slug: detail.slug,
    kind: detail.kind,
    protected: detail.isProtected,
    status: detail.status,
    default: detail.id === config.environmentId,
    canRun: can('secret:runtime'),
    canPull: can('secret:export') && can('secret:read'),
    hasBase: detail.baseEnvironmentId !== null,
  };
  if (ctx.json) ctx.printJson(info);
  else {
    ctx.out(
      table([
        ['Environment', `${info.name} (${info.slug})${info.default ? ', default' : ''}`],
        ['Type', info.kind.toLowerCase()],
        [
          'Protected',
          info.protected ? 'yes: values need a direct grant and a password confirmation' : 'no',
        ],
        ['envvault run', info.canRun ? 'allowed' : 'not allowed (needs secret:runtime)'],
        ['envvault pull', info.canPull ? 'allowed' : 'not allowed (needs secret:export)'],
        ['Inherits from a base', info.hasBase ? 'yes' : 'no'],
      ]),
    );
  }
  return EXIT.ok;
}
