// Optional: run `sync` every 15 minutes with macOS launchd. Prints a cron line elsewhere.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.ts';
import { stableNodePath } from './util.ts';

export const LABEL = 'com.second-brain.sync';

export function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function cliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts');
}

function which(bin: string): string | null {
  try {
    return execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildPlist(everyMinutes: number): string {
  const node = stableNodePath();
  const claude = which('claude');
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

export function cronLine(everyMinutes: number): string {
  return `*/${everyMinutes} * * * * ${stableNodePath()} ${cliPath()} sync --quiet >> ${path.join(dataDir(), 'logs', 'sync.log')} 2>&1`;
}

function uid(): string {
  return String(os.userInfo().uid);
}

export function isInstalled(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('launchctl', ['print', `gui/${uid()}/${LABEL}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function install(everyMinutes: number): string {
  if (process.platform !== 'darwin') throw new Error(`launchd is macOS only. Add this to crontab -e instead:\n${cronLine(everyMinutes)}`);
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.mkdirSync(path.join(dataDir(), 'logs'), { recursive: true, mode: 0o700 });
  if (isInstalled()) uninstall();
  fs.writeFileSync(plistPath(), buildPlist(everyMinutes));
  execFileSync('launchctl', ['bootstrap', `gui/${uid()}`, plistPath()]);
  return plistPath();
}

export function uninstall(): void {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { stdio: 'ignore' });
  } catch {}
  if (fs.existsSync(plistPath())) fs.unlinkSync(plistPath());
}
