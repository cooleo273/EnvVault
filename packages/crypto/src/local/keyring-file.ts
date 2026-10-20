import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { KeyConfigurationError } from '../errors.js';
import { type Keyring, parseKeyringJson, serializeKeyring } from './keyring.js';

const MAX_KEYRING_FILE_BYTES = 1024 * 1024;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/** POSIX permission bits are meaningful; on Windows access is governed by NTFS ACLs. */
export function enforcesPosixPermissions(platform = process.platform): boolean {
  return platform !== 'win32';
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Reads and validates a keyring file. Refuses symlinks, oversized files and,
 * on POSIX systems, files readable or writable by group or others (like ssh).
 */
export async function readKeyringFile(path: string): Promise<Keyring> {
  if (!isAbsolute(path)) {
    throw new KeyConfigurationError('Keyring file path must be absolute');
  }
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    throw new KeyConfigurationError(
      isNotFound(error) ? 'Keyring file does not exist' : 'Keyring file cannot be read',
    );
  }
  if (stats.isSymbolicLink()) throw new KeyConfigurationError('Keyring file must not be a symlink');
  if (!stats.isFile()) throw new KeyConfigurationError('Keyring path is not a regular file');
  if (stats.size > MAX_KEYRING_FILE_BYTES) {
    throw new KeyConfigurationError('Keyring file is too large');
  }
  if (enforcesPosixPermissions() && (stats.mode & 0o077) !== 0) {
    throw new KeyConfigurationError(
      'Keyring file permissions are too open (run: chmod 600 <keyring file>)',
    );
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new KeyConfigurationError('Keyring file cannot be read');
  }
  return parseKeyringJson(text);
}

export async function keyringFileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw new KeyConfigurationError('Keyring file cannot be inspected');
  }
}

/**
 * Writes a keyring atomically: a new temporary file (exclusive create, mode
 * 0600) in the same directory, flushed, then renamed over the target. A crash
 * leaves either the old or the new keyring, never a partial file.
 */
export async function writeKeyringFile(path: string, keyring: Keyring): Promise<void> {
  if (!isAbsolute(path)) {
    throw new KeyConfigurationError('Keyring file path must be absolute');
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', FILE_MODE);
  try {
    await handle.writeFile(serializeKeyring(keyring), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (enforcesPosixPermissions()) await chmod(temporary, FILE_MODE);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
