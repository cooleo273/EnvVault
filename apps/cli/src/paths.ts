import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * Per user configuration directory: %APPDATA%\envvault on Windows,
 * ~/Library/Application Support/envvault on macOS, $XDG_CONFIG_HOME/envvault
 * (or ~/.config/envvault) elsewhere. ENVVAULT_CONFIG_DIR overrides it.
 */
export function configDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (env.ENVVAULT_CONFIG_DIR) return env.ENVVAULT_CONFIG_DIR;
  if (platform === 'win32')
    return win32.join(env.APPDATA ?? win32.join(home, 'AppData', 'Roaming'), 'envvault');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'envvault');
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, '.config'), 'envvault');
}
