// How fast is search on your brain? Times N runs three ways:
//   1. search() inside one process (the query itself)
//   2. a search_memory call over MCP stdio (what an agent waits for, server already running)
//   3. the whole `second-brain search` command (includes starting Node)
//
//   node scripts/bench-search.ts [--runs 20] ["query one" "query two" …]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.ts';
import { Brain } from '../src/db.ts';
import { search } from '../src/search.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: 'string' } } });
const runs = Number(values.runs ?? 20);
const queries = positionals.length ? positionals : ['error fix', 'database migration', 'deploy failed', 'why did we decide'];
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function stats(ms: number[]): string {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `median ${at(0.5).toFixed(1)} ms · p95 ${at(0.95).toFixed(1)} ms · min ${s[0].toFixed(1)} ms`;
}

const cfg = loadConfig();
const brain = new Brain();
const total = brain.counts().reduce((a, b) => a + b.total, 0);
console.log(`${runs} runs each · ${total} records · queries: ${queries.map((q) => `"${q}"`).join(', ')}\n`);

const inproc: number[] = [];
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  search(brain, queries[i % queries.length], cfg.search, { limit: 8 });
  inproc.push(performance.now() - t);
}
brain.close();
console.log(`search() in-process           ${stats(inproc)}`);

const client = new Client({ name: 'bench', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'mcp.ts')], env: { ...process.env } as Record<string, string>, stderr: 'ignore' }),
);
const mcp: number[] = [];
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  await client.callTool({ name: 'search_memory', arguments: { query: queries[i % queries.length], limit: 8 } });
  mcp.push(performance.now() - t);
}
await client.close();
console.log(`MCP search_memory call        ${stats(mcp)}`);

const cli: number[] = [];
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'src', 'cli.ts'), 'search', queries[i % queries.length]], { stdio: 'ignore' });
  cli.push(performance.now() - t);
}
console.log(`second-brain search (CLI)     ${stats(cli)}   (includes starting Node)`);
