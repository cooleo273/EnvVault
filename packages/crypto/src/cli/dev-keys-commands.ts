import { resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isCryptoError } from '../errors.js';
import { generateKeyring, keyringMetadata, rotateKeyring } from '../local/keyring.js';
import {
  enforcesPosixPermissions,
  keyringFileExists,
  readKeyringFile,
  writeKeyringFile,
} from '../local/keyring-file.js';

export const DEFAULT_KEYRING_RELATIVE_PATH = '.envvault/dev-keyring.json';
const WEB_SERVED_SEGMENTS = new Set(['public', '.next', 'static', 'www']);

export interface CliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `Usage: pnpm crypto:<command>:dev [--file <path>]

Commands:
  init     Create a new development keyring (refuses to overwrite one).
  rotate   Add a new active key version; older versions stay decrypt-only.
  status   Show key ids, versions and statuses (never key material).

Options:
  --file <path>          Keyring file (default: ${DEFAULT_KEYRING_RELATIVE_PATH})
  --overwrite <key id>   init only: replace an existing keyring. Destroys its keys.`;

const LOSS_WARNING = [
  'WARNING: this file is the only copy of the master keys. If it is lost, every',
  'secret encrypted with it is permanently unrecoverable. Keep a protected backup',
  '(e.g. in a password manager or an encrypted volume), never in Git or the database.',
];

function isWebServed(path: string): boolean {
  return path.split(sep).some((segment) => WEB_SERVED_SEGMENTS.has(segment));
}

function describeError(error: unknown): string {
  if (isCryptoError(error)) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code ? `File system error (${code})` : 'Unexpected error';
}

async function init(path: string, overwrite: string | undefined, io: CliIo): Promise<number> {
  if (await keyringFileExists(path)) {
    let existingKeyId: string;
    try {
      existingKeyId = (await readKeyringFile(path)).keyId;
    } catch (error) {
      io.err(
        `A keyring file already exists at ${path} but cannot be used: ${describeError(error)}.`,
      );
      io.err('Back it up and remove it manually if you really want to replace it.');
      return 1;
    }
    if (overwrite !== existingKeyId) {
      io.err(
        `A keyring already exists at ${path} (key id ${existingKeyId}). Refusing to overwrite.`,
      );
      io.err('Replacing it destroys its keys: data encrypted with them becomes unrecoverable.');
      io.err(`To replace it anyway, run again with --overwrite ${existingKeyId}`);
      return 1;
    }
  }
  const keyring = generateKeyring();
  await writeKeyringFile(path, keyring);
  io.out(`Created development keyring ${keyring.keyId} (version 1 active) at:`);
  io.out(`  ${path}`);
  io.out(
    enforcesPosixPermissions()
      ? 'File permissions: 0600 (owner read/write only).'
      : 'Windows: POSIX permissions do not apply; the file inherits the ACL of its folder. Keep it inside your user profile.',
  );
  io.out('');
  io.out('Add to your .env (server-side only, never NEXT_PUBLIC_*):');
  io.out('  ENCRYPTION_PROVIDER=local');
  io.out(`  ENCRYPTION_KEYRING_FILE=${path}`);
  io.out('');
  for (const line of LOSS_WARNING) io.out(line);
  return 0;
}

async function rotate(path: string, io: CliIo): Promise<number> {
  const current = await readKeyringFile(path);
  if (current.usage !== 'development') {
    io.err(
      'This keyring has usage "self-managed". Use the operator tooling (pnpm ops keys:rotate).',
    );
    return 1;
  }
  const rotated = rotateKeyring(current);
  await writeKeyringFile(path, rotated);
  io.out(`Rotated ${rotated.keyId}: version ${String(rotated.activeVersion)} is now active.`);
  io.out('Older versions remain available for decryption. Restart the API to use the new version.');
  io.out('Existing data keys keep their old version until they are re-wrapped.');
  return 0;
}

async function status(path: string, io: CliIo): Promise<number> {
  const keyring = await readKeyringFile(path);
  io.out(`Keyring ${keyring.keyId} at ${path}`);
  for (const entry of keyringMetadata(keyring)) {
    io.out(
      `  v${String(entry.keyVersion)}  ${entry.status.padEnd(12)}  created ${entry.createdAt}`,
    );
  }
  return 0;
}

/** Developer-only key tooling. Never prints key material. */
export async function runDevKeys(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        file: { type: 'string' },
        overwrite: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch {
    io.err(USAGE);
    return 2;
  }
  const [command] = parsed.positionals;
  if (parsed.values.help || !command || !['init', 'rotate', 'status'].includes(command)) {
    io.err(USAGE);
    return 2;
  }
  if (io.env.NODE_ENV === 'production') {
    io.err('Development keys cannot be managed with NODE_ENV=production.');
    return 1;
  }
  const file = parsed.values.file ?? DEFAULT_KEYRING_RELATIVE_PATH;
  // resolve() also normalises redundant separators (e.g. doubled backslashes from shell quoting).
  const path = resolve(io.cwd, file);
  if (isWebServed(path)) {
    io.err('Refusing to place keys inside a web-served directory.');
    return 1;
  }
  try {
    if (command === 'init') return await init(path, parsed.values.overwrite, io);
    if (command === 'rotate') return await rotate(path, io);
    return await status(path, io);
  } catch (error) {
    io.err(`Failed: ${describeError(error)}`);
    return 1;
  }
}
