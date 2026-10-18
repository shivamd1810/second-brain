import { execFileSync } from 'node:child_process';
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

/**
 * The node binary to write into configs: the PATH one (e.g. /opt/homebrew/bin/node, a stable
 * symlink) when it is the same node we run on, else our own path. Survives `brew upgrade node`.
 */
export function stableNodePath(): string {
  try {
    const onPath = execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim();
    if (onPath && fs.realpathSync(onPath) === fs.realpathSync(process.execPath)) return onPath;
  } catch {}
  return process.execPath;
}
