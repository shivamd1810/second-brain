import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when this module is the script node was started with (works through symlinks, e.g. npm link). */
export function isMain(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
