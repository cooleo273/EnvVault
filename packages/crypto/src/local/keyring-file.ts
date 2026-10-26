import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
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
 * Reads a file that holds key material. Refuses symlinks, oversized files and,
 * on POSIX systems, files readable or writable by group or others (like ssh).
 * `label` names the file in error messages; the content is never echoed.
 */
export async function readProtectedFile(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new KeyConfigurationError(`${label} path must be absolute`);
  }
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    throw new KeyConfigurationError(
      isNotFound(error) ? `${label} does not exist` : `${label} cannot be read`,
    );
  }
  if (stats.isSymbolicLink()) throw new KeyConfigurationError(`${label} must not be a symlink`);
  if (!stats.isFile()) throw new KeyConfigurationError(`${label} path is not a regular file`);
  if (stats.size > MAX_KEYRING_FILE_BYTES) {
    throw new KeyConfigurationError(`${label} is too large`);
  }
  if (enforcesPosixPermissions() && (stats.mode & 0o077) !== 0) {
    throw new KeyConfigurationError(`${label} permissions are too open (run: chmod 600 <file>)`);
  }
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new KeyConfigurationError(`${label} cannot be read`);
  }
}

/** Reads and validates a keyring file (see {@link readProtectedFile}). */
export async function readKeyringFile(path: string): Promise<Keyring> {
  return parseKeyringJson(await readProtectedFile(path, 'Keyring file'));
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
 * Writes a file atomically: a new temporary file (exclusive create, mode
 * 0600) in the same directory, flushed, then renamed over the target. A crash
 * leaves either the old or the new content, never a partial file. With
 * `exclusive`, an existing target is never replaced.
 */
export async function writeProtectedFile(
  path: string,
  text: string,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  if (!isAbsolute(path)) {
    throw new KeyConfigurationError('File path must be absolute');
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', FILE_MODE);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (enforcesPosixPermissions()) await chmod(temporary, FILE_MODE);
    if (options.exclusive) {
      // link() fails when the target exists, unlike rename().
      await link(temporary, path);
      await rm(temporary, { force: true });
    } else {
      await rename(temporary, path);
    }
  } catch (error) {
    await rm(temporary, { force: true });
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
      throw new KeyConfigurationError('Refusing to overwrite an existing file');
    }
    throw error;
  }
}

/** Writes a keyring atomically (see {@link writeProtectedFile}). */
export async function writeKeyringFile(path: string, keyring: Keyring): Promise<void> {
  await writeProtectedFile(path, serializeKeyring(keyring));
}
