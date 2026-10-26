import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { Shell } from './inputs.js';

export const COMMAND_NOT_FOUND = 127;
export const COMMAND_TIMED_OUT = 124;
const KILL_GRACE_MS = 10_000;

/**
 * Splits a command line into arguments without a shell: whitespace separates,
 * single quotes keep text literally, double quotes keep spaces and allow
 * `\"` and `\\`. No variable expansion, globbing, pipes or redirection.
 */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        current += command.charAt(++i);
      } else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error('command has an unclosed quote');
  if (started) args.push(current);
  return args;
}

/** The program and arguments to start. A shell is used only when the workflow asks for one. */
export function commandLine(command: string, shell: Shell): [string, string[]] {
  switch (shell) {
    case 'bash':
      return ['bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', command]];
    case 'sh':
      return ['sh', ['-e', '-c', command]];
    case 'pwsh':
      return ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]];
    case 'cmd':
      return ['cmd.exe', ['/D', '/S', '/C', command]];
    default: {
      const [program, ...args] = splitCommand(command);
      if (!program) throw new Error('command is empty');
      return [program, args];
    }
  }
}

export interface RunOptions {
  env: Record<string, string>;
  cwd: string | undefined;
  timeoutMs: number;
  /** Signals forwarded to the child (the runner sends SIGINT, then SIGTERM, on cancel). */
  signals?: readonly NodeJS.Signals[];
}

/**
 * Runs the command with inherited stdio and resolves with its exit status:
 * its own code, 128 plus the signal number when a signal ended it, 127 when
 * it could not be started, 124 after the timeout.
 */
export function runCommand(
  program: string,
  args: string[],
  options: RunOptions,
): Promise<{ code: number; timedOut: boolean; startError: string | null }> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(program, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    const signals = options.signals ?? ['SIGINT', 'SIGTERM'];
    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode === null) child.kill(signal);
    };
    for (const signal of signals) process.on(signal, forward);
    let killer: NodeJS.Timeout | undefined;
    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
          }, options.timeoutMs)
        : undefined;
    const finish = (result: { code: number; timedOut: boolean; startError: string | null }) => {
      clearTimeout(timer);
      clearTimeout(killer);
      for (const signal of signals) process.off(signal, forward);
      resolve(result);
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        code: COMMAND_NOT_FOUND,
        timedOut: false,
        startError: error.code === 'ENOENT' ? `${program} was not found` : error.message,
      });
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish({ code: COMMAND_TIMED_OUT, timedOut, startError: null });
        return;
      }
      const number = signal
        ? ((constants.signals[signal] as number | undefined) ?? 1)
        : (code ?? 1);
      finish({ code: signal ? 128 + number : number, timedOut, startError: null });
    });
  });
}
