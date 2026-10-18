// Optional: run `sync` every 15 minutes. macOS: launchd. Linux: your crontab. Windows: a
// Task Scheduler command to run yourself. Anywhere: `second-brain sync --watch`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.ts';
import { onPath, stableNodePath } from './util.ts';

export const LABEL = 'com.second-brain.sync';

export function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function cliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts');
}


const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildPlist(everyMinutes: number): string {
  const node = stableNodePath();
  const claude = onPath('claude');
  // launchd starts with a bare PATH; include where node and claude live so `claude -p` works.
  const pathDirs = [path.dirname(node), claude ? path.dirname(claude) : '', '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i);
  const logs = path.join(dataDir(), 'logs');
  const env: Record<string, string> = { PATH: pathDirs.join(':'), SECOND_BRAIN_HOME: dataDir(), HOME: os.homedir() };
  const args = [node, cliPath(), 'sync', '--notify', '--quiet'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>StartInterval</key><integer>${everyMinutes * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'sync.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'sync.log'))}</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
</dict>
</plist>
`;
}

const CRON_MARK = '# second-brain-sync';

function scheduleEnvPath(): string {
  const node = stableNodePath();
  const claude = onPath('claude');
  return [path.dirname(node), claude ? path.dirname(claude) : '', '/usr/local/bin', '/usr/bin', '/bin']
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i)
    .join(':');
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Linux/BSD: one crontab line. PATH is set inline because cron starts with a bare PATH. */
export function cronLine(everyMinutes: number): string {
  const log = path.join(dataDir(), 'logs', 'sync.log');
  return `*/${everyMinutes} * * * * PATH=${sq(scheduleEnvPath())} SECOND_BRAIN_HOME=${sq(dataDir())} ${sq(stableNodePath())} ${sq(cliPath())} sync --notify --quiet >> ${sq(log)} 2>&1 ${CRON_MARK}`;
}

/** Replace any earlier second-brain line in a crontab with `line` (or just remove it). */
export function editCrontab(existing: string, line: string | null): string {
  const kept = existing.split('\n').filter((l) => l.trim() && !l.includes(CRON_MARK));
  if (line) kept.push(line);
  return kept.length ? kept.join('\n') + '\n' : '';
}

function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // "no crontab for user"
  }
}

function writeCrontab(text: string): void {
  execFileSync('crontab', ['-'], { input: text });
}

/** Windows: a Task Scheduler command (printed, not run: Windows support is untested). */
export function schtasksCommand(everyMinutes: number): string {
  const tr = `"${stableNodePath()}" "${cliPath()}" sync --quiet`;
  return `schtasks /Create /F /SC MINUTE /MO ${everyMinutes} /TN "second-brain sync" /TR "${tr.replace(/"/g, '\\"')}"`;
}

/** What `schedule print` shows on this platform. */
export function printable(everyMinutes: number): string {
  if (process.platform === 'darwin') return buildPlist(everyMinutes);
  if (process.platform === 'win32') return schtasksCommand(everyMinutes);
  return cronLine(everyMinutes);
}

function uid(): string {
  return String(os.userInfo().uid);
}

export function isInstalled(): boolean {
  if (process.platform === 'darwin') {
    try {
      execFileSync('launchctl', ['print', `gui/${uid()}/${LABEL}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  if (process.platform === 'win32') return false;
  return readCrontab().includes(CRON_MARK);
}

export function install(everyMinutes: number): string {
  fs.mkdirSync(path.join(dataDir(), 'logs'), { recursive: true, mode: 0o700 });
  if (process.platform === 'win32')
    throw new Error(`Run this once in a terminal (or see README → Scheduling → Windows):\n${schtasksCommand(everyMinutes)}`);
  if (process.platform !== 'darwin') {
    writeCrontab(editCrontab(readCrontab(), cronLine(everyMinutes)));
    return 'your crontab (crontab -l to see it)';
  }
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  if (isInstalled()) uninstall();
  fs.writeFileSync(plistPath(), buildPlist(everyMinutes));
  execFileSync('launchctl', ['bootstrap', `gui/${uid()}`, plistPath()]);
  return plistPath();
}

export function uninstall(): void {
  if (process.platform === 'win32') throw new Error('Run: schtasks /Delete /TN "second-brain sync" /F');
  if (process.platform !== 'darwin') {
    const current = readCrontab();
    if (current.includes(CRON_MARK)) writeCrontab(editCrontab(current, null));
    return;
  }
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { stdio: 'ignore' });
  } catch {}
  if (fs.existsSync(plistPath())) fs.unlinkSync(plistPath());
}
