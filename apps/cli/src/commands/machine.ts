import { API_PROTOCOL_VERSION, type MachineEnvironment } from '@envvault/shared';
import { findProjectConfig } from '../config.js';
import { CLI_VERSION, type Context, table } from '../context.js';
import { CliError, EXIT, toCliError } from '../errors.js';
import {
  type CredentialSource,
  type MachineSession,
  machineSession,
  resolveMachineEnvironment,
} from '../machine.js';

/**
 * The linked environment, if this directory is linked to the identity's own
 * project. A link to another project is refused rather than silently ignored.
 */
async function linkedEnvironmentId(
  ctx: Context,
  session: MachineSession,
): Promise<string | undefined> {
  const found = await findProjectConfig(ctx.io.cwd);
  if (!found) return undefined;
  if (found.config.projectId !== session.token.identity.projectId) {
    throw new CliError(
      `${found.path} links another project than the machine identity ${session.token.identity.name} belongs to.`,
      EXIT.config,
      'Run from a directory of that project, or remove the link in CI.',
    );
  }
  return found.config.environmentId;
}

function describe(env: MachineEnvironment): string {
  const can = (p: string) => env.permissions.includes(p);
  return [can('secret:runtime') ? 'run' : null, can('secret:list') ? 'list' : null, 'read']
    .filter(Boolean)
    .join(', ');
}

/**
 * envvault auth service: checks a service credential by exchanging it, and
 * shows what it may do. Prints no token; stores nothing.
 */
export async function authService(ctx: Context, source?: CredentialSource): Promise<number> {
  const session = await machineSession(ctx, source);
  try {
    const self = await session.api.machineSelf();
    const info = {
      identity: self.identity.name,
      identityId: self.identity.id,
      project: self.identity.projectName,
      apiUrl: session.apiUrl,
      credential: self.credential.name,
      credentialExpiresAt: self.credential.expiresAt,
      scopes: self.token.scopes,
      environments: self.environments.map((e) => ({
        name: e.name,
        slug: e.slug,
        permissions: e.permissions,
      })),
    };
    if (ctx.json) ctx.printJson(info);
    else {
      ctx.out(
        `Authenticated as machine identity ${info.identity} (project ${info.project}) on ${info.apiUrl}`,
      );
      ctx.out(`  credential: ${info.credential}, expires ${info.credentialExpiresAt}`);
      ctx.out(`  scopes:     ${info.scopes.join(', ')}`);
      ctx.out(
        `  environments: ${self.environments.length > 0 ? self.environments.map((e) => `${e.name} (${describe(e)})`).join('; ') : 'none granted'}`,
      );
    }
    return EXIT.ok;
  } catch (error) {
    throw toCliError(error, { machine: true });
  } finally {
    await session.end();
  }
}

export async function machineWhoami(ctx: Context): Promise<number> {
  const session = await machineSession(ctx);
  try {
    const self = await session.api.machineSelf();
    const info = {
      kind: 'machine',
      identity: self.identity.name,
      identityId: self.identity.id,
      projectId: self.identity.projectId,
      apiUrl: session.apiUrl,
      credentialExpiresAt: self.credential.expiresAt,
    };
    if (ctx.json) ctx.printJson(info);
    else ctx.out(`machine identity ${info.identity} on ${info.apiUrl}`);
    return EXIT.ok;
  } catch (error) {
    throw toCliError(error, { machine: true });
  } finally {
    await session.end();
  }
}

export async function machineEnvList(ctx: Context): Promise<number> {
  const session = await machineSession(ctx);
  try {
    const items = await session.api.machineEnvironments();
    const linked = await linkedEnvironmentId(ctx, session);
    if (ctx.json) {
      ctx.printJson(items.map((e) => ({ ...e, current: e.id === linked })));
      return EXIT.ok;
    }
    if (items.length === 0) {
      ctx.out('This machine identity has no environment grants.');
      return EXIT.ok;
    }
    ctx.out(
      table([
        ['', 'NAME', 'SLUG', 'PROTECTED', 'MAY'],
        ...items.map((e) => [
          e.id === linked ? '*' : '',
          e.name,
          e.slug,
          e.isProtected ? 'yes' : 'no',
          describe(e),
        ]),
      ]),
    );
    return EXIT.ok;
  } catch (error) {
    throw toCliError(error, { machine: true });
  } finally {
    await session.end();
  }
}

export async function machineEnvInfo(ctx: Context, ref: string | undefined): Promise<number> {
  const session = await machineSession(ctx);
  try {
    const items = await session.api.machineEnvironments();
    const env = resolveMachineEnvironment(items, ref, await linkedEnvironmentId(ctx, session));
    const info = {
      id: env.id,
      name: env.name,
      slug: env.slug,
      kind: env.kind,
      protected: env.isProtected,
      status: env.status,
      canRun: env.permissions.includes('secret:runtime'),
      canList: env.permissions.includes('secret:list'),
      canPull: false,
    };
    if (ctx.json) ctx.printJson(info);
    else {
      ctx.out(
        table([
          ['Environment', `${info.name} (${info.slug})`],
          ['Protected', info.protected ? 'yes' : 'no'],
          ['envvault run', info.canRun ? 'allowed' : 'not allowed (needs secret:runtime)'],
          ['envvault pull', 'never for machine identities'],
        ]),
      );
    }
    return EXIT.ok;
  } catch (error) {
    throw toCliError(error, { machine: true });
  } finally {
    await session.end();
  }
}

/** Values for `envvault run` as a machine identity. The token ends before the child starts. */
export async function machineRuntimeValues(
  ctx: Context,
  options: { env?: string | undefined; inherited: boolean },
) {
  const session = await machineSession(ctx);
  try {
    const items = await session.api.machineEnvironments();
    const environment = resolveMachineEnvironment(
      items,
      options.env,
      await linkedEnvironmentId(ctx, session),
    );
    const loaded = await session.api.machineRuntime(environment.id, {
      includeInherited: options.inherited,
    });
    return { environment, loaded };
  } catch (error) {
    throw toCliError(error, { machine: true });
  } finally {
    await session.end();
  }
}

type Outcome = 'ok' | 'warn' | 'fail';

/** envvault doctor in machine mode: credential, identity, link and runtime access. */
export async function machineDoctor(ctx: Context): Promise<number> {
  const checks: { name: string; outcome: Outcome; detail: string; hint?: string }[] = [];
  const failed = (name: string, error: unknown) => {
    const cli = toCliError(error, { machine: true });
    checks.push({
      name,
      outcome: 'fail',
      detail: cli.message,
      ...(cli.hint ? { hint: cli.hint } : {}),
    });
  };
  checks.push({
    name: 'CLI',
    outcome: 'ok',
    detail: `envvault ${CLI_VERSION} on Node.js ${process.versions.node} (${process.platform}), protocol ${String(API_PROTOCOL_VERSION)}`,
  });
  let session: MachineSession | null = null;
  try {
    session = await machineSession(ctx);
    checks.push({
      name: 'Service credential',
      outcome: 'ok',
      detail: `${session.token.credential.name}, expires ${session.token.credential.expiresAt}`,
    });
  } catch (error) {
    failed('Service credential', error);
  }
  if (session) {
    try {
      const self = await session.api.machineSelf();
      checks.push({
        name: 'Machine identity',
        outcome: 'ok',
        detail: `${self.identity.name} in ${self.identity.projectName}`,
      });
      const linked = await linkedEnvironmentId(ctx, session);
      const env = linked ? self.environments.find((e) => e.id === linked) : undefined;
      if (!linked) {
        checks.push({
          name: 'Environment',
          outcome: 'warn',
          detail: 'No linked default environment',
          hint: 'Pass --env <name> to envvault run.',
        });
      } else if (!env) {
        checks.push({
          name: 'Environment',
          outcome: 'fail',
          detail: 'The linked environment is not granted to this identity',
          hint: 'Grant it a role there in the project settings.',
        });
      } else {
        const canRun = env.permissions.includes('secret:runtime');
        checks.push({
          name: 'Runtime access',
          outcome: canRun ? 'ok' : 'fail',
          detail: canRun
            ? `envvault run may load ${env.name}`
            : `Missing secret:runtime on ${env.name}`,
          ...(canRun
            ? {}
            : { hint: 'Check the credential scopes and the grant on this environment.' }),
        });
      }
      if (self.environments.length === 0) {
        checks.push({ name: 'Grants', outcome: 'warn', detail: 'No environment is granted' });
      }
    } catch (error) {
      failed('Machine identity', error);
    } finally {
      await session.end();
    }
  }
  const anyFailed = checks.some((c) => c.outcome === 'fail');
  if (ctx.json) ctx.printJson({ ok: !anyFailed, mode: 'machine', checks });
  else {
    const p = ctx.paint;
    const mark: Record<Outcome, string> = {
      ok: p.green('ok  '),
      warn: p.yellow('warn'),
      fail: p.red('fail'),
    };
    for (const check of checks) {
      ctx.out(`${mark[check.outcome]}  ${check.name}: ${check.detail}`);
      if (check.hint) ctx.out(`      ${check.hint}`);
    }
  }
  return anyFailed ? EXIT.failure : EXIT.ok;
}
