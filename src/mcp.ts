#!/usr/bin/env node
// One small MCP server (stdio) in front of the index, so Claude Code, Gemini CLI and Codex
// all search the same memory. Read-only: it never writes to the brain.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.ts';
import { SOURCES } from './connectors/index.ts';
import { Brain } from './db.ts';
import { hitsToText, recordToText } from './format.ts';
import { staleWarning } from './health.ts';
import { recent, search } from './search.ts';
import { isMain } from './util.ts';

export const INSTRUCTIONS = `This server is the user's personal memory ("second brain"): their past Claude Code sessions,
git commits, notes and email, across all projects, with short notes written for each item.
Search it BEFORE answering questions about past work: earlier decisions and why they were made,
bugs fixed before and how, commands that were used, or anything the user says they did,
decided or discussed before. Answer from the results and say which record (date + source) the
answer came from. When results disagree, prefer the newer one and mention the change.`;

export function createServer(brain = new Brain(), cfg = loadConfig()): McpServer {
  const server = new McpServer({ name: 'second-brain', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'search_memory',
    {
      title: 'Search memory',
      description:
        "Search the user's personal memory (past Claude Code sessions, git commits, notes, email). " +
        'Plain-text BM25 search over short notes (summary, likely question, facts) with a small boost for newer records. ' +
        'Pass 2-6 specific keywords (project names, tools, exact error text), not a whole sentence; ' +
        'if results look weak, search again with synonyms. Returns ranked results with id, date, summary, decisions and a link to the original.',
      inputSchema: {
        query: z.string().min(1).describe('Keywords, e.g. "postgres sqlite switch" or "launchd PATH claude not found"'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8)'),
        source: z.enum(SOURCES as [string, ...string[]]).optional().describe('Only search one source'),
        since: z.string().optional().describe('Only records on/after this ISO date, e.g. 2026-09-01'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit, source, since }) => {
      const hits = search(brain, query, cfg.search, { limit: limit ?? 8, source, since });
      const warning = staleWarning(brain, cfg);
      const text = hitsToText(query, hits) + (warning ? `\n\n${warning}` : '');
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'recent_memory',
    {
      title: 'Recent memory',
      description:
        'List the newest records (sessions first), no keywords needed. Use for "what was I working on yesterday / last week?". ' +
        'For anything topic-specific, use search_memory instead.',
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe('How far back (default 7)'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 10)'),
        source: z.enum(SOURCES as [string, ...string[]]).optional().describe('Only one source'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ days, limit, source }) => {
      const hits = recent(brain, { days, limit, source });
      return { content: [{ type: 'text', text: hitsToText(`newest ${days ?? 7} days`, hits, false) }] };
    },
  );

  server.registerTool(
    'get_record',
    {
      title: 'Get record',
      description:
        'Fetch one memory record by id (from search_memory): its note plus the full original text and a link to where it came from.',
      inputSchema: {
        id: z.string().describe('Record id, e.g. cs-1a2b3c4d-0'),
        max_chars: z.number().int().min(500).max(100000).optional().describe('Truncate the original (default 20000)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, max_chars }) => {
      const r = brain.getRecord(id);
      if (!r) return { content: [{ type: 'text', text: `No record with id "${id}".` }], isError: true };
      return { content: [{ type: 'text', text: recordToText(r, max_chars ?? 20000) }] };
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('second-brain MCP server ready (stdio)');
}

if (isMain(import.meta.url)) await main();
