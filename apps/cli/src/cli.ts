import { parseArgs } from 'node:util';
import { createEnvVaultClient, EnvVaultApiError, type EnvVaultClient } from '@envvault/sdk';

export const CLI_VERSION = '0.0.0';
export const DEFAULT_API_URL = 'http://localhost:4000';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  createClient?: (baseUrl: string) => Pick<EnvVaultClient, 'health'>;
}

const HELP = `EnvVault CLI v${CLI_VERSION}

Usage:
  envvault <command> [options]

Commands:
  health            Check that the EnvVault API is reachable

Options:
  --api-url <url>   API origin (default: $ENVVAULT_API_URL or ${DEFAULT_API_URL})
  --json            Print machine-readable JSON output
  -h, --help        Show this help
  -v, --version     Show the CLI version

Secret management commands will be added in a later release.
`;

/** Runs the CLI and returns the process exit code. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'api-url': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${CLI_VERSION}\n`);
    return 0;
  }
  const [command] = positionals;
  if (values.help || command === undefined) {
    io.stdout(HELP);
    return 0;
  }

  if (command === 'health') {
    const apiUrl = values['api-url'] ?? io.env.ENVVAULT_API_URL ?? DEFAULT_API_URL;
    return health(apiUrl, values.json, io);
  }

  io.stderr(`Unknown command: ${command}\n\n${HELP}`);
  return 2;
}

async function health(apiUrl: string, json: boolean, io: CliIo): Promise<number> {
  try {
    const client = (io.createClient ?? ((baseUrl) => createEnvVaultClient({ baseUrl })))(apiUrl);
    const result = await client.health();
    io.stdout(
      json
        ? `${JSON.stringify(result)}\n`
        : `API ${result.status} (${result.service} v${result.version}) at ${apiUrl}\n`,
    );
    return result.status === 'ok' ? 0 : 1;
  } catch (error) {
    const reason =
      error instanceof EnvVaultApiError
        ? `HTTP ${error.statusCode} ${error.code}`
        : (error as Error).message;
    io.stderr(`Unable to reach EnvVault API at ${apiUrl}: ${reason}\n`);
    return 1;
  }
}
