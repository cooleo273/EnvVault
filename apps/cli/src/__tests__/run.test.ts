import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { childEnvironment, launch, type Spawner } from '../commands/run.js';
import { CliError } from '../errors.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
}

function fakeSpawner() {
  const child = new FakeChild();
  const calls: { file: string; args: string[]; options: SpawnOptions }[] = [];
  const spawner: Spawner = (file, args, options) => {
    calls.push({ file, args, options });
    return child as unknown as ChildProcess;
  };
  return { child, calls, spawner };
}

describe('child environment', () => {
  it('adds values and overrides by default', () => {
    const values = new Map([
      ['DATABASE_URL', 'postgres://synthetic'],
      ['PORT', '4000'],
    ]);
    const { env, kept } = childEnvironment({ PATH: '/bin', PORT: '3000' }, values, true);
    expect(env).toEqual({ PATH: '/bin', PORT: '4000', DATABASE_URL: 'postgres://synthetic' });
    expect(kept).toBe(0);
  });

  it('keeps variables already set without override', () => {
    const { env, kept } = childEnvironment({ PORT: '3000' }, new Map([['PORT', '4000']]), false);
    expect(env.PORT).toBe('3000');
    expect(kept).toBe(1);
  });

  it('does not modify the parent environment', () => {
    const base = { PATH: '/bin' };
    childEnvironment(base, new Map([['TOKEN', 'synthetic']]), true);
    expect(base).toEqual({ PATH: '/bin' });
  });
});

describe('launch', () => {
  it('starts the command without a shell and with values only in its environment', async () => {
    const { child, calls, spawner } = fakeSpawner();
    const env = { API_KEY: 'synthetic-value' };
    const done = launch('node', ['server.js'], env, '/work/app', spawner, false);
    const [call] = calls;
    expect(call?.options.shell).toBe(false);
    expect(call?.options.env).toEqual({ API_KEY: 'synthetic-value' });
    expect(call?.args).toEqual(['server.js']);
    expect(JSON.stringify(call?.args)).not.toContain('synthetic-value');
    child.emit('exit', 3, null);
    await expect(done).resolves.toBe(3);
    // References are dropped once the child has exited.
    expect(env).toEqual({});
  });

  it('reports a signal exit as 128 plus the signal number', async () => {
    const { child, spawner } = fakeSpawner();
    const done = launch('node', [], {}, '/', spawner, false);
    child.emit('exit', null, 'SIGTERM');
    await expect(done).resolves.toBe(143);
  });

  it('exits 127 when the command does not exist', async () => {
    const { child, spawner } = fakeSpawner();
    const done = launch('missing-command', [], {}, '/', spawner, false);
    child.emit(
      'error',
      Object.assign(new Error('spawn missing-command ENOENT'), { code: 'ENOENT' }),
    );
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(127);
  });

  it('forwards termination signals to the child', async () => {
    const { child, spawner } = fakeSpawner();
    const done = launch('node', [], {}, '/', spawner, false);
    process.emit('SIGTERM', 'SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    await done;
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('does not repeat a terminal interrupt the child already received', async () => {
    const { child, spawner } = fakeSpawner();
    const done = launch('node', [], {}, '/', spawner, true);
    process.emit('SIGINT', 'SIGINT');
    expect(child.kill).not.toHaveBeenCalled();
    process.emit('SIGTERM', 'SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 130, null);
    await expect(done).resolves.toBe(130);
  });
});
