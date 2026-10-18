import fs from 'node:fs';
import path from 'node:path';
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
    const found = onPath('node');
    if (found && fs.realpathSync(found) === fs.realpathSync(process.execPath)) return found;
  } catch {}
  return process.execPath;
}

/** Find an executable on PATH without a shell (works on macOS, Linux and Windows). */
export function onPath(bin: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}
