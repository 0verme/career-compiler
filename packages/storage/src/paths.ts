import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// The storage path follows the host OS so the database never lands in a scanned repository.
export function getDefaultDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'career-compiler');
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'career-compiler');
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'career-compiler');
}

export function getDefaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDefaultDataDirectory(env), 'career-compiler.sqlite');
}
