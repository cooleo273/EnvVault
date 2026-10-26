import {
  EnvVaultApiError,
  EnvVaultIncompatibleApiError,
  EnvVaultMachineClient,
  EnvVaultNetworkError,
  createEnvVaultClient,
} from '@envvault/sdk';
import { commandLine, runCommand } from './command.js';
import { EnvironmentPolicyError, mergeEnvironment } from './environment.js';
import { type ActionInputs, InputError, parseInputs } from './inputs.js';
import { masksFor, redact } from './masking.js';

export const ACTION_VERSION = '0.1.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The parts of @actions/core the action uses, injectable for tests. */
export interface Runner {
  getInput(name: string): string;
  getIDToken(audience: string): Promise<string>;
  setSecret(value: string): void;
  setOutput(name: string, value: string): void;
  info(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
  env: NodeJS.ProcessEnv;
}

class ActionError extends Error {}

function describe(error: unknown): string {
  if (error instanceof EnvVaultApiError) {
    const request = error.requestId ? ` (request ${error.requestId})` : '';
    return `EnvVault refused the request: ${error.code}: ${error.message}${request}`;
  }
  if (error instanceof EnvVaultNetworkError) {
    return error.reason === 'timeout'
      ? 'The EnvVault API did not answer in time'
      : 'The EnvVault API could not be reached';
  }
  if (error instanceof EnvVaultIncompatibleApiError) {
    return `This action speaks protocol ${String(error.clientVersion)}; the API speaks ${String(error.serverVersion)}. Use a matching action version.`;
  }
  if (
    error instanceof InputError ||
    error instanceof EnvironmentPolicyError ||
    error instanceof ActionError
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}

function machineClient(inputs: ActionInputs, runner: Runner): EnvVaultMachineClient {
  const common = {
    baseUrl: inputs.apiUrl,
    userAgent: `envvault-github-action/${ACTION_VERSION}`,
    timeoutMs: 15_000,
    // Reads only; token exchanges are never repeated (each identity token is single use).
    retries: 2,
    ...(UUID.test(inputs.environment)
      ? { environmentIds: [inputs.environment.toLowerCase()] }
      : {}),
  };
  if (inputs.authMode === 'service-credential') {
    return new EnvVaultMachineClient({ ...common, credential: inputs.serviceCredential ?? '' });
  }
  return new EnvVaultMachineClient({
    ...common,
    oidcToken: async () => {
      let token: string;
      try {
        token = await runner.getIDToken(inputs.audience);
      } catch {
        throw new ActionError(
          'Could not get a GitHub OIDC token. Give the job `permissions: id-token: write` (and `contents: read`).',
        );
      }
      runner.setSecret(token);
      return token;
    },
    oidc: {
      ...(inputs.workspaceId ? { workspaceId: inputs.workspaceId } : {}),
      ...(inputs.projectId ? { projectId: inputs.projectId } : {}),
      ...(inputs.bindingId ? { bindingId: inputs.bindingId } : {}),
    },
  });
}

/**
 * Loads the environment's values with a short lived machine token, masks
 * them, ends the token, and runs the command with the values in its
 * environment only. Returns the exit status for the step.
 */
export async function run(runner: Runner): Promise<number> {
  const known = new Set<string>();
  let client: EnvVaultMachineClient | null = null;
  try {
    const serviceCredential = runner.getInput('service-credential');
    if (serviceCredential) {
      runner.setSecret(serviceCredential);
      known.add(serviceCredential);
    }
    const inputs = parseInputs((name) => runner.getInput(name));
    await createEnvVaultClient({ baseUrl: inputs.apiUrl, timeoutMs: 15_000 }).checkCompatibility();

    client = machineClient(inputs, runner);
    const config = await client.runtime(inputs.environment, {
      includeInherited: inputs.includeInherited,
    });
    let values: Record<string, string> = {};
    for (const { key, value } of config.values) {
      values[key] = value;
      known.add(value);
      for (const mask of masksFor(value)) runner.setSecret(mask);
    }
    // The values are in memory now; the token is not needed for the command.
    await client.close();
    client = null;

    if (config.missingRequired.length > 0 && !inputs.allowMissing) {
      throw new ActionError(
        `Required variables have no value in EnvVault: ${config.missingRequired.join(', ')}`,
      );
    }
    const merged = mergeEnvironment(runner.env, values, {
      keys: inputs.keys,
      allowReservedKeys: inputs.allowReservedKeys,
      override: inputs.override,
    });
    values = {};
    runner.info(
      `Loaded ${String(merged.applied.length)} variables from EnvVault environment "${inputs.environment}".`,
    );
    if (merged.kept.length > 0) {
      runner.warning(`Kept the step's own value for: ${merged.kept.join(', ')} (override: false)`);
    }
    runner.setOutput('variables-loaded', String(merged.applied.length));

    const [program, args] = commandLine(inputs.command, inputs.shell);
    const result = await runCommand(program, args, {
      env: merged.env,
      cwd: inputs.workingDirectory,
      timeoutMs: inputs.timeoutMinutes * 60_000,
    });
    runner.setOutput('exit-code', String(result.code));
    if (result.startError) {
      runner.setFailed(redact(`Could not start the command: ${result.startError}`, known));
    } else if (result.timedOut) {
      runner.setFailed(
        `The command ran longer than ${String(inputs.timeoutMinutes)} minutes and was stopped`,
      );
    } else if (result.code !== 0) {
      runner.setFailed(`The command exited with status ${String(result.code)}`);
    }
    return result.code;
  } catch (error) {
    runner.setFailed(redact(describe(error), known));
    return 1;
  } finally {
    await client?.close().catch(() => undefined);
  }
}
