import { API_PROTOCOL_VERSION } from '@envvault/shared';
import { CLI_VERSION, type Context } from '../context.js';
import { EXIT, toCliError } from '../errors.js';
import { type Session, signedIn } from '../session.js';

type Outcome = 'ok' | 'warn' | 'fail' | 'skip';

interface Check {
  name: string;
  outcome: Outcome;
  detail: string;
  hint?: string;
}

/**
 * envvault doctor: checks each link of the chain from this directory to the
 * values, and says what to do about the first broken one. Never prints a
 * value or a token.
 */
export async function doctor(ctx: Context): Promise<number> {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);
  const fail = (name: string, error: unknown) => {
    const cli = toCliError(error);
    add({ name, outcome: 'fail', detail: cli.message, ...(cli.hint ? { hint: cli.hint } : {}) });
  };

  const node = Number(process.versions.node.split('.')[0]);
  add({
    name: 'CLI',
    outcome: node >= 22 ? 'ok' : 'warn',
    detail: `envvault ${CLI_VERSION} on Node.js ${process.versions.node} (${process.platform})`,
    ...(node >= 22 ? {} : { hint: 'Use Node.js 22 or later.' }),
  });

  let project: Awaited<ReturnType<Context['project']>> = null;
  try {
    project = await ctx.project();
    add(
      project
        ? { name: 'Project link', outcome: 'ok', detail: project.path }
        : {
            name: 'Project link',
            outcome: 'fail',
            detail: 'No .envvault.json here or above',
            hint: 'Run envvault init.',
          },
    );
  } catch (error) {
    fail('Project link', error);
  }

  let apiUrl: string | null = null;
  try {
    apiUrl = await ctx.apiUrl();
    const api = ctx.client(apiUrl);
    await api.health();
    const meta = await api.checkCompatibility();
    add({
      name: 'API',
      outcome: 'ok',
      detail: `${apiUrl} (API ${meta.version}, protocol ${String(API_PROTOCOL_VERSION)})`,
    });
  } catch (error) {
    fail('API', error);
  }

  let session: Session | null = null;
  if (apiUrl) {
    try {
      session = await signedIn(ctx);
      const me = await session.api.me();
      add({
        name: 'Signed in',
        outcome: 'ok',
        detail: `${me.user.email} (${ctx.store.kind === 'keychain' ? 'credential store' : 'credential file'})`,
      });
    } catch (error) {
      fail('Signed in', error);
    }
  }

  if (session && project) {
    const { config } = project;
    try {
      const detail = await session.api.getProject(config.workspaceId, config.projectId);
      add({
        name: 'Project access',
        outcome: detail.status === 'ACTIVE' ? 'ok' : 'warn',
        detail: `${detail.name}${detail.status === 'ACTIVE' ? '' : ' (archived)'}`,
      });
    } catch (error) {
      fail('Project access', error);
    }
    if (!config.environmentId) {
      add({
        name: 'Environment',
        outcome: 'warn',
        detail: 'No default environment',
        hint: 'Run envvault env use <name>.',
      });
    } else {
      try {
        const env = await session.api.getEnvironment(
          config.workspaceId,
          config.projectId,
          config.environmentId,
        );
        const canRun = env.permissions.includes('secret:runtime');
        add({
          name: 'Environment',
          outcome: env.status === 'ACTIVE' ? 'ok' : 'fail',
          detail: `${env.name}${env.isProtected ? ' (protected)' : ''}${env.status === 'ACTIVE' ? '' : ' (archived)'}`,
        });
        add({
          name: 'Runtime access',
          outcome: canRun ? 'ok' : 'fail',
          detail: canRun ? 'envvault run may load values' : 'Missing secret:runtime here',
          ...(canRun
            ? env.isProtected
              ? { hint: 'Protected: confirm your password in the web app before running.' }
              : {}
            : { hint: 'Ask a project admin for a role or environment grant with secret:runtime.' }),
        });
        if (env.permissions.includes('secret:list')) {
          const report = await session.api.evaluateReadiness(
            config.workspaceId,
            config.projectId,
            env.id,
            { inspectValues: false },
          );
          const missing = report.issues.filter(
            (i) => i.code === 'REQUIRED_MISSING' || i.code === 'REQUIRED_NO_VALUE',
          );
          add({
            name: 'Required variables',
            outcome: missing.length === 0 ? 'ok' : 'fail',
            detail:
              missing.length === 0
                ? `${String(report.coverage.present)} of ${String(report.coverage.required)} have values`
                : `Missing: ${missing.map((i) => i.key ?? '?').join(', ')}`,
          });
          add({
            name: 'Readiness',
            outcome:
              report.status === 'READY' ? 'ok' : report.status === 'BLOCKED' ? 'fail' : 'warn',
            detail: report.status.toLowerCase(),
          });
        } else {
          add({
            name: 'Required variables',
            outcome: 'skip',
            detail: 'You cannot list variables here',
          });
        }
      } catch (error) {
        fail('Environment', error);
      }
    }
  }

  const failed = checks.some((c) => c.outcome === 'fail');
  if (ctx.json) {
    ctx.printJson({ ok: !failed, checks });
  } else {
    const p = ctx.paint;
    const mark: Record<Outcome, string> = {
      ok: p.green('ok  '),
      warn: p.yellow('warn'),
      fail: p.red('fail'),
      skip: p.dim('skip'),
    };
    for (const check of checks) {
      ctx.out(`${mark[check.outcome]}  ${check.name}: ${check.detail}`);
      if (check.hint) ctx.out(`      ${check.hint}`);
    }
  }
  return failed ? EXIT.failure : EXIT.ok;
}
