import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvVaultApiError } from '@envvault/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIo } from '../cli.js';
import { Context } from '../context.js';
import { CliError, EXIT, toCliError } from '../errors.js';
import {
  CREDENTIAL_ENV,
  CREDENTIAL_FILE_ENV,
  readServiceCredential,
  resolveMachineEnvironment,
  withoutCredential,
} from '../machine.js';

const CREDENTIAL = `evv_sk_${'A'.repeat(16)}_${'b'.repeat(43)}`;
const posixOnly = process.platform === 'win32' ? it.skip : it;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'envvault-machine-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function createIo(env: Record<string, string> = {}, extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { ENVVAULT_CONFIG_DIR: dir, ENVVAULT_CREDENTIAL_STORE: 'file', ...env },
    cwd: dir,
    interactive: false,
    ...extra,
  };
  return { io, out: () => out.join(''), err: () => err.join('') };
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

describe('service credential input', () => {
  it('reads the credential from the environment', async () => {
    const { io } = createIo({ [CREDENTIAL_ENV]: `  ${CREDENTIAL}\n` });
    await expect(readServiceCredential(new Context(io, {}))).resolves.toBe(CREDENTIAL);
  });

  it('never echoes a value that is not a credential', async () => {
    const pasted = 'ghp_synthetic-not-an-envvault-token';
    const { io } = createIo({ [CREDENTIAL_ENV]: pasted });
    const error = await failure(readServiceCredential(new Context(io, {})));
    expect(error.exitCode).toBe(EXIT.config);
    expect(JSON.stringify(error)).not.toContain(pasted);
    expect(error.message).not.toContain(pasted);
  });

  posixOnly('requires a credential file only its owner can read', async () => {
    const path = join(dir, 'credential');
    await writeFile(path, CREDENTIAL, { mode: 0o600 });
    const { io } = createIo({ [CREDENTIAL_FILE_ENV]: path });
    await expect(readServiceCredential(new Context(io, {}))).resolves.toBe(CREDENTIAL);
    await chmod(path, 0o644);
    expect((await failure(readServiceCredential(new Context(io, {})))).exitCode).toBe(EXIT.config);
  });

  it('reads from standard input when asked', async () => {
    const { io } = createIo({}, { readStdin: () => Promise.resolve(`${CREDENTIAL}\n`) });
    await expect(readServiceCredential(new Context(io, {}), { kind: 'stdin' })).resolves.toBe(
      CREDENTIAL,
    );
  });

  it('says where to put the credential when there is none', async () => {
    const { io } = createIo();
    const error = await failure(readServiceCredential(new Context(io, {})));
    expect(error.exitCode).toBe(EXIT.auth);
    expect(error.hint).toContain(CREDENTIAL_ENV);
  });
});

describe('machine mode', () => {
  it('removes the credential from the child environment', () => {
    const env = { PATH: '/bin', [CREDENTIAL_ENV]: CREDENTIAL, [CREDENTIAL_FILE_ENV]: '/x' };
    expect(withoutCredential(env)).toEqual({ PATH: '/bin' });
    expect(env[CREDENTIAL_ENV]).toBe(CREDENTIAL);
  });

  it('refuses commands that act as a person', async () => {
    for (const command of [
      ['login'],
      ['logout'],
      ['init'],
      ['workspace', 'list'],
      ['project', 'list'],
    ]) {
      const { io, err } = createIo({ [CREDENTIAL_ENV]: CREDENTIAL });
      await expect(main(command, io)).resolves.toBe(EXIT.usage);
      expect(err()).toContain('not available with a service credential');
    }
  });

  it('never writes .env files for a machine', async () => {
    const { io, err } = createIo({ [CREDENTIAL_ENV]: CREDENTIAL });
    await expect(main(['pull'], io)).resolves.toBe(EXIT.forbidden);
    expect(err()).toContain('envvault run');
  });

  it('has no command line option that takes the credential', async () => {
    const { io, out } = createIo();
    await main(['auth', 'service', '--help'], io);
    expect(out()).not.toMatch(/--credential\b|--token\b/);
  });

  it('maps machine authentication failures to the auth exit code', () => {
    for (const code of [
      'INVALID_CREDENTIAL',
      'CREDENTIAL_EXPIRED',
      'CREDENTIAL_REVOKED',
      'IDENTITY_DISABLED',
    ]) {
      const error = toCliError(new EnvVaultApiError(401, { statusCode: 401, code, message: 'x' }));
      expect(error.exitCode).toBe(EXIT.auth);
    }
    expect(
      toCliError(
        new EnvVaultApiError(401, { statusCode: 401, code: 'TOKEN_EXPIRED', message: 'x' }),
        {
          machine: true,
        },
      ).hint,
    ).not.toContain('envvault login');
  });

  it('resolves environments by name, slug or id', () => {
    const items = [
      {
        id: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c01',
        name: 'QA',
        slug: 'qa',
        kind: 'STAGING' as const,
        isProtected: false,
        status: 'ACTIVE' as const,
        permissions: ['environment:read', 'secret:runtime'],
      },
    ];
    expect(resolveMachineEnvironment(items, 'qa', undefined).name).toBe('QA');
    expect(resolveMachineEnvironment(items, undefined, items[0]?.id).name).toBe('QA');
    expect(() => resolveMachineEnvironment(items, 'production', undefined)).toThrow(CliError);
    expect(() => resolveMachineEnvironment(items, undefined, undefined)).toThrow(CliError);
  });
});
