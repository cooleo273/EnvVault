import { Command, CommanderError, Option } from 'commander';
import { authStatus, login, logout, whoami } from './commands/auth.js';
import { doctor } from './commands/doctor.js';
import {
  authService,
  machineDoctor,
  machineEnvInfo,
  machineEnvList,
  machineWhoami,
} from './commands/machine.js';
import {
  envInfo,
  envList,
  envUse,
  init,
  projectInfo,
  projectList,
  projectUse,
  workspaceList,
  workspaceUse,
} from './commands/link.js';
import { pull } from './commands/pull.js';
import { run } from './commands/run.js';
import { DEFAULT_API_URL } from './config.js';
import { CLI_VERSION, type CliIo, Context, type GlobalOptions } from './context.js';
import { CliError, EXIT, toCliError } from './errors.js';
import { type CredentialSource, personOnly } from './machine.js';

export { CLI_VERSION, DEFAULT_API_URL, type CliIo };

type Action = (ctx: Context, command: Command) => Promise<number>;

function build(io: CliIo, done: (code: number) => void): Command {
  const program = new Command('envvault')
    .description('EnvVault: load your project configuration without copying secrets around.')
    .version(CLI_VERSION, '-v, --version', 'Show the CLI version')
    .helpOption('-h, --help', 'Show help')
    .addOption(
      new Option(
        '--api-url <url>',
        `API origin (default: $ENVVAULT_API_URL, the project link, or ${DEFAULT_API_URL})`,
      ),
    )
    .option('--json', 'Print machine readable JSON on stdout')
    .enablePositionalOptions()
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  const action =
    (fn: Action) =>
    async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const ctx = new Context(io, command.optsWithGlobals<GlobalOptions>());
      done(await fn(ctx, command));
    };
  /** Commands that act as a person; refused while a service credential is configured. */
  const person =
    (name: string, fn: Action): Action =>
    (ctx, command) => {
      if (ctx.machine) throw personOnly(name);
      return fn(ctx, command);
    };
  /** One command, two implementations: as a person or as the configured machine identity. */
  const either =
    (forPerson: Action, forMachine: Action): Action =>
    (ctx, command) =>
      ctx.machine ? forMachine(ctx, command) : forPerson(ctx, command);
  const sub = (parent: Command, name: string, summary: string) =>
    parent
      .command(name)
      .description(summary)
      .exitOverride()
      .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  sub(program, 'login', 'Sign in through the web app')
    .option('--no-browser', 'Print the address instead of opening a browser')
    .action(
      action(
        person('login', (ctx, cmd) =>
          login(ctx, { browser: cmd.opts<{ browser: boolean }>().browser }),
        ),
      ),
    );
  sub(program, 'logout', 'End this CLI session and forget its credentials').action(
    action(person('logout', (ctx) => logout(ctx))),
  );
  sub(program, 'whoami', 'Show who (or which machine identity) you are').action(
    action(
      either(
        (ctx) => whoami(ctx),
        (ctx) => machineWhoami(ctx),
      ),
    ),
  );
  const auth = sub(program, 'auth', 'Inspect the CLI session or a service credential');
  sub(auth, 'status', 'Show the session, where credentials are kept and when they expire').action(
    action(
      either(
        (ctx) => authStatus(ctx),
        (ctx) => authService(ctx),
      ),
    ),
  );
  sub(auth, 'service', 'Check a service credential (CI, servers) and show what it may do')
    .option(
      '--from-env',
      'Read ENVVAULT_SERVICE_CREDENTIAL or ENVVAULT_SERVICE_CREDENTIAL_FILE (default)',
    )
    .option('--from-file <path>', 'Read the credential from a file only you can read')
    .option('--from-stdin', 'Read the credential from standard input')
    .action(
      action((ctx, cmd) => {
        const o = cmd.opts<{ fromEnv?: boolean; fromFile?: string; fromStdin?: boolean }>();
        if ([o.fromEnv, o.fromFile, o.fromStdin].filter(Boolean).length > 1) {
          throw new CliError('Choose one of --from-env, --from-file and --from-stdin.', EXIT.usage);
        }
        const source: CredentialSource | undefined = o.fromFile
          ? { kind: 'file', path: o.fromFile }
          : o.fromStdin
            ? { kind: 'stdin' }
            : undefined;
        return authService(ctx, source);
      }),
    );

  sub(
    program,
    'init',
    'Link this directory to a project (writes .envvault.json, never a .env file)',
  )
    .option('--workspace <ref>', 'Workspace name, slug or id')
    .option('--project <ref>', 'Project name, slug or id')
    .option('--env <ref>', 'Default environment name, slug or id')
    .option('--force', 'Replace an existing link without asking')
    .action(action(person('init', (ctx, cmd) => init(ctx, cmd.opts()))));

  const workspace = sub(program, 'workspace', 'Workspaces you belong to');
  sub(workspace, 'list', 'List workspaces').action(
    action(person('workspace list', (ctx) => workspaceList(ctx))),
  );
  sub(workspace, 'use', 'Remember a workspace for use outside linked directories')
    .argument('<workspace>', 'Name, slug or id')
    .action(action(person('workspace use', (ctx, cmd) => workspaceUse(ctx, cmd.args[0] ?? ''))));

  const project = sub(program, 'project', 'Projects in a workspace');
  sub(project, 'list', 'List projects')
    .option('--workspace <ref>', 'Workspace name, slug or id')
    .option('--all', 'Include archived projects')
    .action(action(person('project list', (ctx, cmd) => projectList(ctx, cmd.opts()))));
  sub(project, 'use', 'Link this directory to a project')
    .argument('<project>', 'Name, slug or id')
    .option('--workspace <ref>', 'Workspace name, slug or id')
    .action(
      action(person('project use', (ctx, cmd) => projectUse(ctx, cmd.args[0] ?? '', cmd.opts()))),
    );
  sub(project, 'info', 'Show the linked project').action(
    action(person('project info', (ctx) => projectInfo(ctx))),
  );

  const env = sub(program, 'env', 'Environments of the linked project');
  sub(env, 'list', 'List environments').action(
    action(
      either(
        (ctx) => envList(ctx),
        (ctx) => machineEnvList(ctx),
      ),
    ),
  );
  sub(env, 'use', 'Set the default environment')
    .argument('<environment>', 'Name, slug or id')
    .action(action(person('env use', (ctx, cmd) => envUse(ctx, cmd.args[0] ?? ''))));
  sub(env, 'info', 'Show an environment and what you may do with it')
    .argument('[environment]', 'Name, slug or id (default: the linked default)')
    .action(
      action(
        either(
          (ctx, cmd) => envInfo(ctx, cmd.args[0]),
          (ctx, cmd) => machineEnvInfo(ctx, cmd.args[0]),
        ),
      ),
    );

  sub(program, 'run', "Run a command with the environment's values in its environment")
    .usage('[options] -- <command> [args...]')
    .argument('<command...>', 'The command and its arguments, after --')
    .option('-e, --env <ref>', 'Environment name, slug or id (default: the linked default)')
    .option('--no-override', 'Keep variables already set in your shell')
    .option('--no-inherited', 'Leave out values inherited from a base environment')
    .option('--allow-missing', 'Run even when required variables have no value')
    .option('-q, --quiet', 'Print nothing of its own unless something fails')
    .passThroughOptions()
    .action(
      action((ctx, cmd) => {
        const o = cmd.opts<{
          env?: string;
          override: boolean;
          inherited: boolean;
          allowMissing?: boolean;
          quiet?: boolean;
        }>();
        return run(ctx, cmd.args, {
          ...(o.env ? { env: o.env } : {}),
          override: o.override,
          inherited: o.inherited,
          allowMissing: o.allowMissing === true,
          quiet: o.quiet === true,
        });
      }),
    );

  sub(program, 'pull', "Write the environment's values to a plaintext .env file (prefer run)")
    .option('-e, --env <ref>', 'Environment name, slug or id (default: the linked default)')
    .option('-o, --output <file>', 'File to write, inside the project', '.env.local')
    .option('--force', 'Replace an existing file without asking')
    .option('--no-gitignore', 'Do not add the file to .gitignore')
    .action(
      action((ctx, cmd) => {
        if (ctx.machine) {
          throw new CliError(
            'Machine identities cannot write .env files.',
            EXIT.forbidden,
            'Use envvault run, which passes values to the process without a file.',
          );
        }
        const o = cmd.opts<{ env?: string; output: string; force?: boolean; gitignore: boolean }>();
        return pull(ctx, {
          ...(o.env ? { env: o.env } : {}),
          output: o.output,
          force: o.force === true,
          gitignore: o.gitignore,
        });
      }),
    );

  sub(program, 'doctor', 'Check configuration, connectivity, sign in and access').action(
    action(
      either(
        (ctx) => doctor(ctx),
        (ctx) => machineDoctor(ctx),
      ),
    ),
  );

  sub(program, 'health', 'Check that the EnvVault API is reachable').action(
    action(async (ctx) => {
      const apiUrl = await ctx.apiUrl();
      const result = await ctx.client(apiUrl).health();
      if (ctx.json) ctx.printJson(result);
      else ctx.out(`API ${result.status} (${result.service} v${result.version}) at ${apiUrl}`);
      return result.status === 'ok' ? EXIT.ok : EXIT.failure;
    }),
  );

  // Accept --json and --api-url after the subcommand as well, as people type them there.
  const leaves = (command: Command): Command[] =>
    command.commands.length === 0 ? [command] : command.commands.flatMap(leaves);
  for (const leaf of leaves(program)) {
    leaf
      .addOption(new Option('--api-url <url>').hideHelp())
      .addOption(new Option('--json').hideHelp());
  }
  return program;
}

/** Runs the CLI and returns the process exit code. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  let code: number = EXIT.ok;
  const program = build(io, (c) => {
    code = c;
  });
  if (argv.length === 0) {
    io.stdout(program.helpInformation());
    return EXIT.ok;
  }
  try {
    await program.parseAsync(argv, { from: 'user' });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    const cli = toCliError(error);
    io.stderr(`Error: ${cli.message}\n`);
    if (cli.hint) io.stderr(`${cli.hint}\n`);
    return cli.exitCode;
  }
}
