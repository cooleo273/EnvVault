import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_NOT_FOUND,
  COMMAND_TIMED_OUT,
  commandLine,
  runCommand,
  splitCommand,
} from './command.js';
import { EnvironmentPolicyError, judgeName, mergeEnvironment } from './environment.js';
import { InputError, parseApiUrl, parseInputs } from './inputs.js';
import { type Runner, run } from './main.js';
import { masksFor, redact } from './masking.js';

const CREDENTIAL = `evv_sk_${'A'.repeat(16)}_${'b'.repeat(43)}`;
const posixOnly = process.platform === 'win32' ? it.skip : it;

const inputs = (values: Record<string, string>) => (name: string) => values[name] ?? '';
const base = { 'api-url': 'https://api.envvault.test', environment: 'staging', command: 'node -v' };

describe('inputs', () => {
  it('defaults to OIDC with the API origin as audience', () => {
    const parsed = parseInputs(inputs(base));
    expect(parsed.authMode).toBe('oidc');
    expect(parsed.audience).toBe('https://api.envvault.test');
    expect(parsed.override).toBe(true);
    expect(parsed.shell).toBe('none');
  });

  it('accepts https, or http on loopback only, without credentials in the URL', () => {
    expect(parseApiUrl('http://127.0.0.1:4000/')).toBe('http://127.0.0.1:4000');
    for (const bad of [
      'http://api.envvault.test',
      'https://user:pw@api.test',
      'https://api.test/?x=1',
      'ftp://x',
      'nope',
    ]) {
      expect(() => parseApiUrl(bad), bad).toThrow(InputError);
    }
  });

  it('never falls back to a service credential and validates its format', () => {
    expect(() => parseInputs(inputs({ ...base, 'service-credential': CREDENTIAL }))).toThrow(
      /auth-mode/,
    );
    expect(() => parseInputs(inputs({ ...base, 'auth-mode': 'service-credential' }))).toThrow(
      /needs/,
    );
    expect(() =>
      parseInputs(
        inputs({
          ...base,
          'auth-mode': 'service-credential',
          'service-credential': 'evv_sk_short',
        }),
      ),
    ).toThrow(/not an EnvVault/);
    // The error never repeats what was passed.
    try {
      parseInputs(
        inputs({
          ...base,
          'auth-mode': 'service-credential',
          'service-credential': 'evv_sk_short',
        }),
      );
    } catch (error) {
      expect((error as Error).message).not.toContain('evv_sk_short');
    }
  });

  it('validates ids, booleans, shells and timeouts', () => {
    for (const bad of [
      { 'project-id': 'acme' },
      { override: 'yes' },
      { shell: 'zsh' },
      { 'command-timeout-minutes': '-1' },
      { 'auth-mode': 'token' },
      { audience: 'has space' },
    ]) {
      expect(() => parseInputs(inputs({ ...base, ...bad })), JSON.stringify(bad)).toThrow(
        InputError,
      );
    }
  });
});

describe('environment policy', () => {
  it('judges names', () => {
    expect(judgeName('DATABASE_URL')).toBe('ok');
    expect(judgeName('1BAD')).toBe('invalid');
    expect(judgeName('BAD-NAME')).toBe('invalid');
    expect(judgeName('GITHUB_TOKEN')).toBe('forbidden');
    expect(judgeName('github_env')).toBe('forbidden');
    expect(judgeName('ACTIONS_ID_TOKEN_REQUEST_URL')).toBe('forbidden');
    expect(judgeName('PATH')).toBe('reserved');
    expect(judgeName('NODE_OPTIONS')).toBe('reserved');
    expect(judgeName('DYLD_INSERT_LIBRARIES')).toBe('reserved');
  });

  it('strips runner credentials and inputs, and lets EnvVault win by default', () => {
    const merged = mergeEnvironment(
      {
        PATH: '/bin',
        'INPUT_SERVICE-CREDENTIAL': CREDENTIAL,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner',
        ENVVAULT_SERVICE_CREDENTIAL: CREDENTIAL,
        API_URL: 'from-step',
      },
      { API_URL: 'from-envvault', TOKEN: 'synthetic' },
      { keys: undefined, allowReservedKeys: [], override: true },
    );
    expect(merged.env).toEqual({ PATH: '/bin', API_URL: 'from-envvault', TOKEN: 'synthetic' });
    const kept = mergeEnvironment(
      { API_URL: 'from-step' },
      { API_URL: 'x' },
      {
        keys: undefined,
        allowReservedKeys: [],
        override: false,
      },
    );
    expect(kept.env.API_URL).toBe('from-step');
    expect(kept.kept).toEqual(['API_URL']);
  });

  it('refuses dangerous names unless explicitly allowed, and never runner names', () => {
    const run = (values: Record<string, string>, allowReservedKeys: string[] = []) =>
      mergeEnvironment({}, values, { keys: undefined, allowReservedKeys, override: true });
    expect(() => run({ PATH: '/evil' })).toThrow(EnvironmentPolicyError);
    expect(() => run({ GITHUB_ENV: '/tmp/x' }, ['GITHUB_ENV'])).toThrow(/steer/);
    expect(run({ PYTHONPATH: 'src' }, ['PYTHONPATH']).applied).toEqual(['PYTHONPATH']);
    expect(() => run({ 'bad name': 'x' })).toThrow(/valid/);
  });

  it('passes only the listed keys and fails on missing ones', () => {
    const merged = mergeEnvironment(
      {},
      { A: '1', B: '2' },
      { keys: ['B'], allowReservedKeys: [], override: true },
    );
    expect(merged.applied).toEqual(['B']);
    expect(() =>
      mergeEnvironment({}, { A: '1' }, { keys: ['A', 'C'], allowReservedKeys: [], override: true }),
    ).toThrow(/not found in EnvVault: C/);
  });
});

describe('masking', () => {
  it('masks whole values, each line, and the JSON form; skips empty and tiny values', () => {
    expect(masksFor('')).toEqual([]);
    expect(masksFor('on')).toEqual([]);
    const multiline = '-----BEGIN KEY-----\r\nabcdef\n-----END KEY-----';
    const masks = masksFor(multiline);
    expect(masks).toContain(multiline);
    expect(masks).toContain('abcdef');
    expect(masks).toContain('-----BEGIN KEY-----');
    expect(masks).toContain(JSON.stringify(multiline).slice(1, -1));
    expect(masksFor('{"a":"b c"}')).toContain('{\\"a\\":\\"b c\\"}');
  });

  it('redacts longest values first, repeated occurrences included', () => {
    expect(redact('token abcd and abcdef and abcdef', ['abcd', 'abcdef'])).toBe(
      'token *** and *** and ***',
    );
  });
});

describe('command', () => {
  it('splits arguments without a shell', () => {
    expect(splitCommand(`npm run build -- --flag "a b" 'c $HOME'`)).toEqual([
      'npm',
      'run',
      'build',
      '--',
      '--flag',
      'a b',
      'c $HOME',
    ]);
    expect(splitCommand(`echo "say \\"hi\\""`)).toEqual(['echo', 'say "hi"']);
    expect(splitCommand(`a '' b`)).toEqual(['a', '', 'b']);
    expect(() => splitCommand(`echo "open`)).toThrow(/unclosed/);
    expect(commandLine('ls -la | wc', 'none')).toEqual(['ls', ['-la', '|', 'wc']]);
    expect(commandLine('ls | wc', 'bash')[0]).toBe('bash');
  });

  it('passes exit codes through and reports a missing program', async () => {
    const env = { PATH: process.env.PATH ?? '' };
    expect(
      (
        await runCommand(process.execPath, ['-e', 'process.exit(7)'], {
          env,
          cwd: undefined,
          timeoutMs: 0,
        })
      ).code,
    ).toBe(7);
    const missing = await runCommand('definitely-not-a-command-xyz', [], {
      env,
      cwd: undefined,
      timeoutMs: 0,
    });
    expect(missing.code).toBe(COMMAND_NOT_FOUND);
    expect(missing.startError).toMatch(/not found/);
  });

  posixOnly(
    'reports signals as 128 plus the signal number, and stops after the timeout',
    async () => {
      const env = { PATH: process.env.PATH ?? '' };
      const killed = await runCommand(
        process.execPath,
        ['-e', "process.kill(process.pid, 'SIGTERM')"],
        {
          env,
          cwd: undefined,
          timeoutMs: 0,
        },
      );
      expect(killed.code).toBe(143);
      const slow = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        env,
        cwd: undefined,
        timeoutMs: 200,
      });
      expect(slow).toMatchObject({ code: COMMAND_TIMED_OUT, timedOut: true });
    },
  );

  posixOnly('forwards cancellation signals to the command', async () => {
    const env = { PATH: process.env.PATH ?? '' };
    const pending = runCommand(
      process.execPath,
      ['-e', "process.on('SIGINT', () => process.exit(42)); setTimeout(() => {}, 60000)"],
      { env, cwd: undefined, timeoutMs: 0, signals: ['SIGUSR2'] },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.emit('SIGUSR2', 'SIGUSR2');
    // SIGUSR2 is forwarded as SIGUSR2; the child has no handler for it and ends.
    expect((await pending).code).toBe(128 + 31);
  });
});

describe('run', () => {
  const VALUE = 'synthetic-action-value-c41d';
  const meta = { service: 'envvault-api', version: '1.0.0', protocolVersion: 1, features: [] };
  const environment = {
    id: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c05',
    name: 'Staging',
    slug: 'staging',
    kind: 'STAGING',
    isProtected: false,
    status: 'ACTIVE',
    permissions: ['environment:read', 'secret:runtime'],
  };
  const machineToken = {
    accessToken: `evv_mt_${'x'.repeat(43)}`,
    tokenType: 'Bearer',
    expiresIn: 900,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    scopes: ['environment:read', 'secret:runtime'],
    environmentIds: [environment.id],
    identity: {
      id: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c01',
      name: 'ci',
      workspaceId: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c02',
      projectId: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c03',
    },
    credential: {
      id: '0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c04',
      name: 'ci',
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  };

  function api(values: { key: string; value: string }[], missingRequired: string[] = []) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        const reply = (status: number, body: unknown) =>
          Promise.resolve(
            new Response(body === undefined ? null : JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
          );
        if (url.endsWith('/meta')) return reply(200, meta);
        if (url.endsWith('/machine/oidc/token') || url.endsWith('/machine/token'))
          return reply(200, machineToken);
        if (url.endsWith('/machine/environments')) return reply(200, { items: [environment] });
        if (url.endsWith('/runtime'))
          return reply(200, {
            environmentId: environment.id,
            values: values.map((v) => ({ ...v, source: 'local' })),
            missingRequired,
            withheldInherited: 0,
            issuedAt: new Date().toISOString(),
          });
        return reply(204, undefined);
      }),
    );
    return calls;
  }

  function runner(values: Record<string, string>, idToken = 'header.payload.signature') {
    const events: string[] = [];
    const failures: string[] = [];
    const r: Runner = {
      getInput: inputs(values),
      getIDToken: vi.fn(() => Promise.resolve(idToken)),
      setSecret: (v) => events.push(`mask:${v}`),
      setOutput: (n, v) => events.push(`output:${n}=${v}`),
      info: (m) => events.push(`info:${m}`),
      warning: (m) => events.push(`warning:${m}`),
      setFailed: (m) => failures.push(m),
      env: { PATH: process.env.PATH ?? '' },
    };
    return { r, events, failures };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('masks values before the command runs, passes them only to it, and revokes the token', async () => {
    const calls = api([{ key: 'API_TOKEN', value: VALUE }]);
    const check = `process.exit(process.env.API_TOKEN === ${JSON.stringify(VALUE)} && !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ? 0 : 9)`;
    const { r, events, failures } = runner({
      ...base,
      command: `${process.execPath} -e "${check.replace(/"/g, '\\"')}"`,
    });
    expect(await run(r)).toBe(0);
    expect(failures).toEqual([]);
    expect(events.indexOf(`mask:${VALUE}`)).toBeGreaterThan(-1);
    expect(events.indexOf(`mask:${VALUE}`)).toBeLessThan(
      events.findIndex((e) => e.startsWith('info:Loaded')),
    );
    expect(events).toContain('mask:header.payload.signature');
    expect(events).toContain('output:variables-loaded=1');
    expect(events).toContain('output:exit-code=0');
    expect(events.filter((e) => e.startsWith('output:')).join()).not.toContain(VALUE);
    expect(calls).toContain('POST /api/v1/machine/oidc/token');
    expect(calls).toContain('POST /api/v1/machine/token/revoke');
  });

  it('passes the command exit status through and fails the step', async () => {
    api([{ key: 'API_TOKEN', value: VALUE }]);
    const { r, failures } = runner({
      ...base,
      command: `${process.execPath} -e "process.exit(3)"`,
    });
    expect(await run(r)).toBe(3);
    expect(failures).toEqual(['The command exited with status 3']);
  });

  it('stops before running anything on missing required values or a reserved name', async () => {
    api([{ key: 'API_TOKEN', value: VALUE }], ['DATABASE_URL']);
    const first = runner({ ...base, command: `${process.execPath} -e "process.exit(0)"` });
    expect(await run(first.r)).toBe(1);
    expect(first.failures[0]).toMatch(/DATABASE_URL/);

    api([{ key: 'PATH', value: '/evil' }]);
    const second = runner({ ...base });
    expect(await run(second.r)).toBe(1);
    expect(second.failures[0]).toMatch(/PATH is reserved/);
  });

  it('explains missing id-token permission and never prints credentials', async () => {
    api([]);
    const { r, failures } = runner(base);
    r.getIDToken = () =>
      Promise.reject(new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable'));
    expect(await run(r)).toBe(1);
    expect(failures[0]).toMatch(/id-token: write/);

    const withCredential = runner({
      ...base,
      'auth-mode': 'service-credential',
      'service-credential': CREDENTIAL,
    });
    const calls = api([]);
    expect(await run(withCredential.r)).toBe(0);
    expect(withCredential.events[0]).toBe(`mask:${CREDENTIAL}`);
    expect(calls).toContain('POST /api/v1/machine/token');
    expect(
      JSON.stringify(withCredential.events.filter((e) => !e.startsWith('mask:'))),
    ).not.toContain(CREDENTIAL);
  });
});
