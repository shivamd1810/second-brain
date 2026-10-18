#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// second-brain: connectors → cheap notes → SQLite FTS5 (BM25) → one MCP server for every agent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { configPath, dataDir, dbPath, DEFAULT_CONFIG, expandHome, loadConfig, saveConfig, type Config } from './config.ts';
import { SOURCES } from './connectors/index.ts';
import { gmailAuth } from './connectors/gmail.ts';
import { Brain } from './db.ts';
import { hitsToText, recordToText, parseFacts } from './format.ts';
import { ago, connectorHealth, isUnhealthy, notify } from './health.ts';
import { pickLlm, resolveBackend } from './llm.ts';
import * as schedule from './schedule.ts';
import { recent, search } from './search.ts';
import { summarizePending } from './summarize.ts';
import { runConnectors } from './sync.ts';
import { isMain, stableNodePath } from './util.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.join(HERE, 'mcp.ts');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const cyan = c('36');

const HELP = `second-brain — one local memory for every coding agent

Usage: second-brain <command> [options]

  init [--git <repo>…] [--scan <dir>] [--notes <dir>…] [--no-subagents]
                         create ${'~/.second-brain/config.json'}
  sync [--limit N] [--no-summarize] [--only a,b] [--full] [--notify] [--quiet] [--watch [--every 15]]
                         pull only what's new from each source, then write notes
                         (--full re-reads sources from scratch; unchanged records keep their notes)
  summarize [--limit N] [--ids a,b]  write notes for records still waiting (resumable)
  search <words…> [--limit N] [--source S] [--since DATE] [--explain] [--json]
  recent [--days 7] [--source S]   newest records, no keywords
  show <id>              one record: its note and the full original
  doctor                 health check: last good run per connector, stale = loud
  stats                  record counts per source
  mcp                    start the MCP server (stdio) — what agents connect to
  mcp-config             print the one-line registration for Claude Code, Gemini CLI, Codex
  gmail-auth             one-time browser consent for read-only Gmail
  schedule install|uninstall|status|print [--every 15]
                         macOS launchd, Linux crontab, Windows: prints a schtasks command

Data: ${dataDir()} (override with SECOND_BRAIN_HOME)`;

function out(s = ''): void {
  process.stdout.write(s + '\n');
}

function findRepos(root: string, depth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, d: number) => {
    if (fs.existsSync(path.join(dir, '.git'))) {
      found.push(dir);
      return;
    }
    if (d === 0) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries)
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), d - 1);
  };
  walk(path.resolve(expandHome(root)), depth);
  return found;
}

function cmdInit(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      git: { type: 'string', multiple: true },
      scan: { type: 'string', multiple: true },
      notes: { type: 'string', multiple: true },
      'no-subagents': { type: 'boolean' },
      gmail: { type: 'boolean' },
    },
  });
  const exists = fs.existsSync(configPath());
  const cfg: Config = exists ? loadConfig() : structuredClone(DEFAULT_CONFIG);
  const repos = new Set(cfg.connectors.git.repos);
  for (const r of values.git ?? []) repos.add(path.resolve(expandHome(r)));
  for (const s of values.scan ?? []) for (const r of findRepos(s)) repos.add(r);
  cfg.connectors.git.repos = [...repos];
  if (values.notes?.length) {
    cfg.connectors.notes.dirs = [...new Set([...cfg.connectors.notes.dirs, ...values.notes.map((n) => path.resolve(expandHome(n)))])];
    cfg.connectors.notes.enabled = true;
  }
  if (values['no-subagents']) cfg.connectors['claude-sessions'].includeSubagents = false;
  if (values.gmail) cfg.connectors.gmail.enabled = true;
  saveConfig(cfg);
  const projects = path.resolve(expandHome(cfg.connectors['claude-sessions'].projectsDir));
  out(`${exists ? 'Updated' : 'Created'} ${configPath()}`);
  out(`  claude-sessions: ${fs.existsSync(projects) ? green('found') : red('missing')} ${projects}`);
  out(`  git:             ${cfg.connectors.git.repos.length} repo(s)${cfg.connectors.git.repos.map((r) => `\n                   - ${r}`).join('')}`);
  out(`  notes:           ${cfg.connectors.notes.enabled ? cfg.connectors.notes.dirs.join(', ') : 'off'}`);
  out(`  gmail:           ${cfg.connectors.gmail.enabled ? 'on (run: second-brain gmail-auth)' : 'off'}`);
  out('');
  out(`Next: ${bold('second-brain sync --limit 50')}   (indexes everything, writes notes for the 50 newest)`);
}

async function cmdSync(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      limit: { type: 'string' },
      'no-summarize': { type: 'boolean' },
      only: { type: 'string' },
      full: { type: 'boolean' },
      notify: { type: 'boolean' },
      quiet: { type: 'boolean' },
      watch: { type: 'boolean' },
      every: { type: 'string' },
    },
  });
  if (values.watch) {
    // Portable scheduler: keep running and sync every N minutes (any OS, no cron needed).
    const every = Number(values.every ?? 15);
    const rest = argv.filter((a, i) => a !== '--watch' && a !== '--every' && argv[i - 1] !== '--every');
    out(`Syncing every ${every} min. Ctrl-C to stop.`);
    for (;;) {
      try {
        await cmdSync([...rest, '--quiet']);
      } catch (e) {
        out(red(`sync failed: ${(e as Error).message}`));
      }
      await new Promise((r) => setTimeout(r, every * 60_000));
    }
  }
  const cfg = loadConfig();
  const brain = new Brain();
  const quiet = Boolean(values.quiet);
  const stamp = new Date().toISOString();
  if (quiet) out(`[${stamp}] sync`);
  const connectors = await runConnectors(brain, cfg, { only: values.only?.split(',').map((x) => x.trim()), full: values.full });
  for (const r of connectors) {
    const name = r.name.padEnd(16);
    if (r.status === 'off') out(`${dim(name + '– off')}  ${dim(r.notes[0] ?? '')}`);
    else if (r.status === 'error') out(`${name}${red('✗ ' + r.error)}`);
    else {
      const upd = r.updated ? `, ${r.updated} updated` : '';
      out(`${name}${green('✓')} ${bold(String(r.new))} new since last run${upd}  ${dim(`(${(r.ms / 1000).toFixed(1)}s)`)}`);
      for (const n of r.notes) out(`${' '.repeat(18)}${dim(n)}`);
    }
  }
  if (!values['no-summarize']) {
    const s = await summarizePending(brain, cfg.summarizer, {
      limit: values.limit ? Number(values.limit) : undefined,
      log: (m) => out(quiet ? `  ${m}` : dim(m)),
    });
    if (s.summarized || s.failed) {
      out(`${'summaries'.padEnd(16)}${s.failed ? yellow('!') : green('✓')} ${bold(String(s.summarized))} written with ${s.model}${s.failed ? `, ${s.failed} failed` : ''}  ${s.costUsd > 0 ? dim(`(est. $${s.costUsd.toFixed(4)} at API list price)`) : ''}`);
      for (const e of s.errors.slice(0, 2)) out(red(`${' '.repeat(18)}${e}`));
      if (s.stoppedForCost) out(yellow(`${' '.repeat(18)}stopped at the cost cap ($${cfg.summarizer.maxCostUsdPerRun}); next sync continues`));
    }
    if (s.remaining) out(dim(`${' '.repeat(18)}${s.remaining} record(s) waiting for summaries (already searchable; \`second-brain summarize\` continues)`));
  }
  const total = brain.counts().reduce((a, b) => a + b.total, 0);
  out(dim(`brain: ${total} records in ${dbPath()}`));
  const health = connectorHealth(brain, cfg);
  const bad = health.filter(isUnhealthy);
  if (bad.length) {
    const msg = bad.map((b) => `${b.name}: ${b.status} — ${b.detail}`).join('\n');
    out(red(bold(`\n⚠ ${bad.length} connector(s) unhealthy:\n`)) + red(msg));
    if (values.notify) notify('Second brain: connector needs attention', bad.map((b) => `${b.name} ${b.status}`).join(', '));
  }
  brain.close();
  return connectors.some((r) => r.status === 'error') ? 1 : 0;
}

async function cmdSummarize(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { limit: { type: 'string' }, ids: { type: 'string' } } });
  const cfg = loadConfig();
  const brain = new Brain();
  const s = await summarizePending(brain, cfg.summarizer, {
    limit: values.limit ? Number(values.limit) : undefined,
    ids: values.ids?.split(',').map((x) => x.trim()).filter(Boolean),
    log: (m) => out(dim(m)),
  });
  out(`${s.summarized} note(s) written, ${s.failed} failed, ${s.remaining} still waiting.${s.costUsd > 0 ? ` est. $${s.costUsd.toFixed(4)} at API list price.` : ''}`);
  for (const e of s.errors.slice(0, 3)) out(red(`  ${e}`));
  brain.close();
}

function cmdSearch(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: 'string', short: 'n' },
      source: { type: 'string', short: 's' },
      since: { type: 'string' },
      json: { type: 'boolean' },
      explain: { type: 'boolean' },
      text: { type: 'boolean' },
    },
  });
  const query = positionals.join(' ');
  if (!query) throw new Error('usage: second-brain search <words…>');
  const cfg = loadConfig();
  const brain = new Brain();
  const t0 = performance.now();
  const hits = search(brain, query, cfg.search, { limit: values.limit ? Number(values.limit) : 8, source: values.source, since: values.since });
  const ms = performance.now() - t0;
  if (values.json) out(JSON.stringify(hits, null, 2));
  else if (values.text) out(hitsToText(query, hits));
  else {
    const total = brain.counts().reduce((a, b) => a + b.total, 0);
    out(dim(`${hits.length} result(s) from ${total} records in ${ms.toFixed(1)} ms · BM25 × recency`));
    out('');
    hits.forEach((h, i) => {
      const rank = cyan(`#${i + 1}`);
      const score = values.explain
        ? `score ${h.score.toFixed(2)} = bm25 ${(-h.bm25).toFixed(2)} × recency ${h.recency.toFixed(2)} (${h.age_days.toFixed(0)} d old)`
        : `score ${h.score.toFixed(2)}`;
      out(`${rank} ${bold(h.date.slice(0, 10))} ${yellow(h.source)}  ${h.title}`);
      out(`   ${dim(score + ' · ' + h.id)}`);
      if (h.summarized && h.question) out(`   ${cyan('Q:')} ${h.question}`);
      if (h.summarized && h.summary) out(`   ${h.summary.length > 280 ? h.summary.slice(0, 279) + '…' : h.summary}`);
      if (!h.summarized) out(`   ${dim('(no note yet) ' + h.snippet.replace(/\s+/g, ' ').slice(0, 220))}`);
      const d = parseFacts(h.facts_json)?.decisions[0];
      if (d) out(`   ${green('Decision:')} ${d.decision} ${dim('— because')} ${d.reason}`);
      out(`   ${dim(h.uri)}`);
      out('');
    });
    if (!hits.length) out('No matches. Try fewer or different words.');
  }
  brain.close();
}

function cmdShow(argv: string[]): void {
  const id = argv[0];
  if (!id) throw new Error('usage: second-brain show <id>');
  const brain = new Brain();
  const r = brain.getRecord(id);
  if (!r) throw new Error(`no record ${id}`);
  out(recordToText(r, 1e9));
  brain.close();
}

function cmdStats(): void {
  const brain = new Brain();
  const rows = brain.counts();
  out(`${'SOURCE'.padEnd(17)}${'RECORDS'.padStart(8)}${'WITH NOTES'.padStart(12)}   NEWEST`);
  for (const r of rows) out(`${r.source.padEnd(17)}${String(r.total).padStart(8)}${String(r.summarized).padStart(12)}   ${r.newest?.slice(0, 16) ?? ''}`);
  const total = rows.reduce((a, b) => a + b.total, 0);
  out(dim(`${total} records · ${(fs.statSync(dbPath()).size / 1e6).toFixed(1)} MB · ${dbPath()}`));
  brain.close();
}

function cmdDoctor(): number {
  const cfg = loadConfig();
  const brain = new Brain();
  const health = connectorHealth(brain, cfg);
  out(bold('second-brain doctor') + dim(`  ${dbPath()}`));
  out('');
  out(`${'CONNECTOR'.padEnd(17)}${'STATUS'.padEnd(11)}${'LAST GOOD SYNC'.padEnd(16)}${'NEW (LAST RUN)'.padEnd(16)}${'RECORDS'.padEnd(9)}NOTES`);
  for (const h of health) {
    const paint = h.status === 'OK' ? green : h.status === 'OFF' ? dim : h.status === 'QUIET' || h.status === 'NEVER RUN' ? yellow : red;
    out(
      `${h.name.padEnd(17)}${paint(h.status.padEnd(11))}${ago(h.lastSuccess).padEnd(16)}${String(h.lastNew).padEnd(16)}${String(h.total).padEnd(9)}${dim(h.detail)}`,
    );
  }
  const pending = brain.pendingCount();
  const { backend, why } = resolveBackend(cfg.summarizer);
  let llmLine: string;
  try {
    const llm = pickLlm(cfg.summarizer);
    llmLine = llm ? `${llm.name} (${llm.model})${dim(`  · ${why}`)}` : yellow('none') + dim(`  · ${why}`);
  } catch (e) {
    llmLine = red(`${backend}: ${(e as Error).message}`);
  }
  out('');
  out(`summarizer      ${llmLine}${pending ? dim(`  · ${pending} record(s) waiting for notes`) : ''}`);
  const sched = process.platform === 'win32' ? dim('Windows: see README → Scheduling') : schedule.isInstalled() ? green(process.platform === 'darwin' ? 'launchd job installed' : 'cron job installed') : dim('not installed (second-brain schedule install, or sync --watch)');
  out(`schedule        ${sched}`);
  const fts = brain.db.prepare("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH 'a OR the OR error'").get() as { n: number };
  out(`index           ${green('FTS5 + bm25 ok')}${dim(`  · sqlite ${(brain.db.prepare('select sqlite_version() v').get() as { v: string }).v} · probe hits ${fts.n}`)}`);
  const bad = health.filter(isUnhealthy);
  if (bad.length) {
    out('');
    out(red(bold('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')));
    for (const b of bad) out(red(bold(`  ${b.name} is ${b.status}: ${b.detail}`)));
    out(red(bold('  Your second brain is not getting new data from these sources.')));
    out(red(bold('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')));
  } else out(green('\nAll connectors healthy.'));
  brain.close();
  return bad.length ? 1 : 0;
}

function cmdMcpConfig(): void {
  const node = stableNodePath();
  out(bold('Claude Code') + dim('  (user scope, every project)'));
  out(`  claude mcp add second-brain --scope user -- ${node} ${MCP_ENTRY}`);
  out(bold('Gemini CLI'));
  out(`  gemini mcp add --scope user second-brain ${node} ${MCP_ENTRY}`);
  out(bold('Codex'));
  out(`  codex mcp add second-brain -- ${node} ${MCP_ENTRY}`);
  out('');
  out(dim('Or by hand: ~/.gemini/settings.json → "mcpServers": {"second-brain": {"command": "' + node + '", "args": ["' + MCP_ENTRY + '"]}}'));
  out(dim('            ~/.codex/config.toml   → [mcp_servers.second-brain] command = "' + node + '" args = ["' + MCP_ENTRY + '"]'));
}

function cmdSchedule(argv: string[]): void {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { every: { type: 'string' } } });
  const every = Number(values.every ?? 15);
  if (!(every >= 1 && every <= 59)) throw new Error('--every must be between 1 and 59 minutes');
  const action = positionals[0] ?? 'status';
  if (action === 'print') out(schedule.printable(every));
  else if (action === 'install') out(`Installed in ${schedule.install(every)}: sync runs every ${every} min. Logs: ${path.join(dataDir(), 'logs', 'sync.log')}`);
  else if (action === 'uninstall') {
    schedule.uninstall();
    out('Removed the scheduled sync.');
  } else out(schedule.isInstalled() ? 'installed' : 'not installed (second-brain schedule install, or sync --watch)');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init':
      cmdInit(rest);
      return 0;
    case 'sync':
      return cmdSync(rest);
    case 'summarize':
      await cmdSummarize(rest);
      return 0;
    case 'search':
      cmdSearch(rest);
      return 0;
    case 'show':
      cmdShow(rest);
      return 0;
    case 'recent': {
      const { values } = parseArgs({ args: rest, options: { days: { type: 'string' }, source: { type: 'string' }, limit: { type: 'string' } } });
      const brain = new Brain();
      out(hitsToText(`last ${values.days ?? 7} days`, recent(brain, { days: values.days ? Number(values.days) : 7, source: values.source, limit: values.limit ? Number(values.limit) : 10 }), false));
      brain.close();
      return 0;
    }
    case 'stats':
      cmdStats();
      return 0;
    case 'doctor':
      return cmdDoctor();
    case 'mcp': {
      const { main: mcpMain } = await import('./mcp.ts');
      await mcpMain();
      return -1; // keep running
    }
    case 'mcp-config':
      cmdMcpConfig();
      return 0;
    case 'gmail-auth':
      await gmailAuth(out);
      return 0;
    case 'schedule':
      cmdSchedule(rest);
      return 0;
    case 'sources':
      out(SOURCES.join('\n'));
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      return 0;
    default:
      out(HELP);
      return 2;
  }
}

if (isMain(import.meta.url)) {
  // `second-brain search … | head` closes the pipe early; that's fine, not a crash.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  main()
    .then((code) => {
      if (code >= 0) process.exitCode = code;
    })
    .catch((e: Error) => {
      process.stderr.write(red(`error: ${e.message}`) + '\n');
      process.exitCode = 1;
    });
}
