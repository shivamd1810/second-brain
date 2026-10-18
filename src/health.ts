// A second brain with stale data quietly gives wrong answers, so every connector is watched.
//   STALE  = no successful run for `staleHours` (auth expired, password changed, path moved…)
//   ERROR  = the last run failed, but an earlier one succeeded recently
//   QUIET  = runs fine but brought nothing new for `quietHours[connector]` (0 disables)
import { execFile } from 'node:child_process';
import { onPath } from './util.ts';
import type { Config } from './config.ts';
import { CONNECTORS } from './connectors/index.ts';
import type { Brain, ConnectorRow } from './db.ts';

export type Status = 'OK' | 'OFF' | 'NEVER RUN' | 'ERROR' | 'STALE' | 'QUIET';

export interface ConnectorHealth {
  name: string;
  status: Status;
  lastSuccess: string | null;
  lastNew: number;
  lastNewAt: string | null;
  total: number;
  summarized: number;
  detail: string;
}

export function hoursSince(iso: string | null, now = Date.now()): number {
  return iso ? (now - Date.parse(iso)) / 3_600_000 : Infinity;
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function connectorHealth(brain: Brain, cfg: Config, now = Date.now()): ConnectorHealth[] {
  const rows = new Map<string, ConnectorRow>(brain.connectorRows().map((r) => [r.name, r]));
  const counts = new Map(brain.counts().map((c) => [c.source, c]));
  return CONNECTORS.map((c) => {
    const row = rows.get(c.name);
    const count = counts.get(c.name);
    const base = {
      name: c.name,
      lastSuccess: row?.last_success_at ?? null,
      lastNew: row?.last_new ?? 0,
      lastNewAt: row?.last_new_at ?? null,
      total: count?.total ?? 0,
      summarized: count?.summarized ?? 0,
    };
    if (!c.enabled(cfg)) return { ...base, status: 'OFF' as Status, detail: c.describe(cfg) };
    if (!row?.last_run_at) return { ...base, status: 'NEVER RUN' as Status, detail: 'run: second-brain sync' };
    const sinceOk = hoursSince(row.last_success_at, now);
    if (sinceOk > cfg.health.staleHours)
      return {
        ...base,
        status: 'STALE' as Status,
        detail: `${Number.isFinite(sinceOk) ? `no successful sync for ${Math.round(sinceOk)} h` : 'never synced successfully'}${row.last_error ? ` (last error: ${row.last_error})` : ''}`,
      };
    if (row.last_status === 'error') return { ...base, status: 'ERROR' as Status, detail: row.last_error ?? 'last run failed' };
    const quiet = cfg.health.quietHours[c.name] ?? 0;
    const sinceNew = hoursSince(row.last_new_at ?? null, now);
    // Only call it quiet once we have watched it for that long.
    const watched = hoursSince(firstRun(brain, c.name), now);
    if (quiet > 0 && sinceNew > quiet && watched > quiet)
      return { ...base, status: 'QUIET' as Status, detail: Number.isFinite(sinceNew) ? `nothing new for ${Math.round(sinceNew)} h` : 'has never brought in anything new' };
    return { ...base, status: 'OK' as Status, detail: c.describe(cfg) };
  });
}

function firstRun(brain: Brain, kind: string): string | null {
  const row = brain.db.prepare('SELECT min(started_at) AS t FROM runs WHERE kind = ?').get(kind) as { t: string | null };
  return row.t;
}

export function isUnhealthy(h: ConnectorHealth): boolean {
  return h.status === 'STALE' || h.status === 'ERROR';
}

/** One line for agents: appended to search results when something is stale. */
export function staleWarning(brain: Brain, cfg: Config): string | null {
  const bad = connectorHealth(brain, cfg).filter(isUnhealthy);
  if (!bad.length) return null;
  return `⚠ Memory may be out of date: ${bad.map((b) => `${b.name} is ${b.status} (last good sync ${ago(b.lastSuccess)})`).join('; ')}. Tell the user to run \`second-brain doctor\`.`;
}

/** Desktop notification so you hear about a broken connector the same day (macOS, Linux). */
export function notify(title: string, message: string): void {
  if (process.platform === 'linux' && onPath('notify-send')) {
    execFile('notify-send', [title, message], () => {});
    return;
  }
  if (process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], () => {});
}
