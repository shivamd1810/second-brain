// Config lives in the data dir (default ~/.second-brain/config.json), never in the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ClaudeSessionsConfig {
  enabled: boolean;
  projectsDir: string;
  includeSubagents: boolean;
  /** Substrings; any session file whose path contains one is skipped. */
  exclude: string[];
  /** A session's open tail is indexed once the file has been idle this long. */
  idleMinutes: number;
}

export interface GitConfig {
  enabled: boolean;
  repos: string[];
  /** Cap for the very first run of a repo, newest first. */
  maxCommitsFirstRun: number;
}

export interface NotesConfig {
  enabled: boolean;
  dirs: string[];
  extensions: string[];
}

export interface GmailConfig {
  enabled: boolean;
  /** Extra Gmail search filter applied on every run. */
  query: string;
  firstRunDays: number;
  maxMessagesPerRun: number;
}

export interface SummarizerConfig {
  /**
   * "auto" = Anthropic API if ANTHROPIC_API_KEY is set, else the `claude` CLI if installed,
   * else `command` if set, else none (search falls back to raw text).
   */
  backend: 'auto' | 'claude-cli' | 'anthropic-api' | 'command' | 'none';
  /** For backend "command": a shell command that reads the prompt on stdin and prints JSON. */
  command: string;
  /** Model for the claude CLI backend (alias or full id). */
  cliModel: string;
  /** Model for the Anthropic API backend. */
  apiModel: string;
  maxRecordsPerRun: number;
  maxCostUsdPerRun: number;
  /** Characters of record text packed into one model call. */
  batchChars: number;
  concurrency: number;
}

export interface SearchConfig {
  /** Max extra weight for a brand-new record (0.5 = up to +50%). */
  recencyBoost: number;
  /** Age at which the boost has halved. */
  halfLifeDays: number;
}

export interface HealthConfig {
  /** No successful run for this long = STALE (loud). */
  staleHours: number;
  /** Per connector: no new records for this long = QUIET (warning). 0 = off. */
  quietHours: Record<string, number>;
}

export interface Config {
  connectors: {
    'claude-sessions': ClaudeSessionsConfig;
    git: GitConfig;
    notes: NotesConfig;
    gmail: GmailConfig;
  };
  summarizer: SummarizerConfig;
  search: SearchConfig;
  health: HealthConfig;
}

export const DEFAULT_CONFIG: Config = {
  connectors: {
    'claude-sessions': {
      enabled: true,
      projectsDir: '~/.claude/projects',
      includeSubagents: true,
      exclude: [],
      idleMinutes: 20,
    },
    git: { enabled: true, repos: [], maxCommitsFirstRun: 500 },
    notes: { enabled: false, dirs: [], extensions: ['.md', '.markdown', '.txt'] },
    gmail: {
      enabled: false,
      query: '-category:promotions -category:social -in:spam -in:trash',
      firstRunDays: 90,
      maxMessagesPerRun: 300,
    },
  },
  summarizer: {
    backend: 'auto',
    command: '',
    cliModel: 'haiku',
    apiModel: 'claude-haiku-5-5',
    maxRecordsPerRun: 200,
    maxCostUsdPerRun: 1.0,
    batchChars: 40000,
    concurrency: 3,
  },
  search: { recencyBoost: 0.5, halfLifeDays: 30 },
  health: {
    staleHours: 6,
    quietHours: { 'claude-sessions': 72, gmail: 48, git: 0, notes: 0 },
  },
};

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function dataDir(): string {
  return path.resolve(expandHome(process.env.SECOND_BRAIN_HOME || '~/.second-brain'));
}

export function configPath(): string {
  return path.join(dataDir(), 'config.json');
}

export function dbPath(): string {
  return path.join(dataDir(), 'brain.db');
}

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (!isPlain(base) || !isPlain(over)) return (over === undefined ? base : over) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
}

export function loadConfig(): Config {
  const file = configPath();
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return merge(structuredClone(DEFAULT_CONFIG), raw);
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}
