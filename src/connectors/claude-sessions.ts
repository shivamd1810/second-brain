// Claude Code sessions: ~/.claude/projects/**/*.jsonl, already plain text on disk.
// Each run reads only the bytes appended since the last run, keeps the human prompts,
// the assistant's replies, the shell commands it ran and any tool errors, and drops
// the rest (tool output, file snapshots, attachments, thinking).
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.ts';
import type { RecordInput } from '../db.ts';
import type { Connector, ConnectorContext, ConnectorResult } from './types.ts';

/** A chunk closes at the next human prompt once it has this much text... */
export const TARGET_CHARS = 6000;
/** ...and is force-split at an item boundary beyond this. */
export const MAX_CHARS = 12000;
const MAX_ITEM_CHARS = 4000;

export interface FileState {
  size: number;
  mtimeMs: number;
  /** Byte offset where the open (not yet final) chunk starts. */
  offset: number;
  /** 1-based line number at `offset`. */
  line: number;
  /** Index of the open chunk. */
  chunk: number;
  /** True when the open tail has not been written yet (file was still active). */
  tailPending: boolean;
  title?: string;
  aiTitle?: string;
  sessionId?: string;
  cwd?: string;
  branch?: string;
  /** The human prompt in force at `offset`, for chunks that start mid-turn. */
  prompt?: string;
}

interface State {
  files: Record<string, FileState>;
}

export interface Item {
  offset: number;
  line: number;
  ts: string | null;
  text: string;
  isPrompt: boolean;
}

export interface Chunk {
  index: number;
  offset: number;
  line: number;
  endLine: number;
  items: Item[];
  chars: number;
  /** Prompt in force when the chunk started (if it starts mid-turn). */
  carriedPrompt?: string;
}

const DROP_BLOCKS = [
  'system-reminder',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'task-notification',
  'command-message',
  'user-prompt-submit-hook',
  'widget_context_hint',
  'ide_opened_file',
  'ide_selection',
];

export function cleanUserText(text: string): string {
  let t = text;
  for (const tag of DROP_BLOCKS) t = t.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'g'), '');
  t = t.replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1');
  t = t.replace(/<command-args>([\s\S]*?)<\/command-args>/g, ' $1');
  t = t.replace(/<\/?pasted_content[^>]*>/g, '');
  t = t.replace(/\[Request interrupted by user[^\]]*\]/g, '');
  return t.trim();
}

function cap(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n) + ' […]';
}

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown>; is_error?: boolean; content?: unknown };

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join(' ');
  return '';
}

/** Pull the searchable items out of one transcript line. Mutates `meta` for titles etc. */
export function lineItems(
  o: Record<string, unknown>,
  meta: Partial<FileState>,
  subagent = false,
): { text: string; isPrompt: boolean }[] {
  const type = o.type as string;
  if (type === 'custom-title' && typeof o.customTitle === 'string') meta.title = o.customTitle;
  if (type === 'ai-title' && typeof o.aiTitle === 'string') meta.aiTitle = o.aiTitle;
  if (type === 'summary' && typeof o.summary === 'string' && !meta.aiTitle) meta.aiTitle = o.summary;
  if (type !== 'user' && type !== 'assistant') return [];
  // Subagent transcripts are all "sidechain"; in a main session those lines are subagent noise.
  if (o.isMeta || o.isCompactSummary || (o.isSidechain && !subagent)) return [];
  if (typeof o.sessionId === 'string' && !meta.sessionId) meta.sessionId = o.sessionId;
  if (typeof o.cwd === 'string') meta.cwd = o.cwd;
  if (typeof o.gitBranch === 'string' && o.gitBranch) meta.branch = o.gitBranch;

  const content = (o.message as { content?: unknown } | undefined)?.content;
  const out: { text: string; isPrompt: boolean }[] = [];
  if (type === 'user') {
    const texts: string[] = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content as Block[]) {
        if (b.type === 'text' && b.text) texts.push(b.text);
        if (b.type === 'tool_result' && b.is_error) {
          const err = toolResultText(b.content).trim();
          if (err) out.push({ text: `TOOL ERROR: ${cap(err, 600)}`, isPrompt: false });
        }
      }
    }
    const prompt = cleanUserText(texts.join('\n'));
    if (prompt) out.unshift({ text: `USER: ${cap(prompt, MAX_ITEM_CHARS)}`, isPrompt: true });
    return out;
  }
  if (Array.isArray(content)) {
    for (const b of content as Block[]) {
      if (b.type === 'text' && b.text?.trim()) out.push({ text: `ASSISTANT: ${cap(b.text.trim(), MAX_ITEM_CHARS)}`, isPrompt: false });
      if (b.type === 'tool_use') {
        const input = b.input ?? {};
        if (b.name === 'Bash' && typeof input.command === 'string')
          out.push({ text: `$ ${cap(input.command, 300)}`, isPrompt: false });
        else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name ?? '') && typeof input.file_path === 'string')
          out.push({ text: `(${b.name?.toLowerCase()} ${input.file_path})`, isPrompt: false });
      }
    }
  }
  return out;
}

/**
 * Parse the complete lines in `buf` (which starts at byte `offset`, line `line` of the file)
 * into items. Returns the items and how many bytes were consumed (up to the last newline).
 */
export function parseItems(
  buf: Buffer,
  offset: number,
  line: number,
  meta: Partial<FileState>,
  subagent = false,
): { items: Item[]; consumed: number } {
  const items: Item[] = [];
  let pos = 0;
  let lineNo = line;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const raw = buf.toString('utf8', pos, nl);
    const lineOffset = offset + pos;
    pos = nl + 1;
    const thisLine = lineNo++;
    if (!raw.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    const ts = typeof o.timestamp === 'string' ? o.timestamp : null;
    for (const it of lineItems(o, meta, subagent)) items.push({ offset: lineOffset, line: thisLine, ts, ...it });
  }
  return { items, consumed: pos };
}

/** Group items into chunks: close at a human prompt once TARGET_CHARS is reached, force-split past MAX_CHARS. */
export function chunkItems(items: Item[], firstIndex: number, carriedPrompt?: string): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let prompt = carriedPrompt;
  for (const it of items) {
    const len = it.text.length + 2;
    const closeAtPrompt = cur && it.isPrompt && cur.chars >= TARGET_CHARS;
    const forceSplit = cur && cur.chars > 0 && cur.chars + len > MAX_CHARS;
    if (!cur || closeAtPrompt || forceSplit) {
      if (cur) chunks.push(cur);
      cur = {
        index: firstIndex + chunks.length,
        offset: it.offset,
        line: it.line,
        endLine: it.line,
        items: [],
        chars: 0,
        carriedPrompt: it.isPrompt ? undefined : prompt,
      };
    }
    cur.items.push(it);
    cur.chars += len;
    cur.endLine = it.line;
    if (it.isPrompt) prompt = it.text;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function projectName(cwd: string | undefined, dirName: string): string {
  // Worktrees live in <repo>/.claude/worktrees/<name>: name the repo, not the worktree.
  if (cwd) return path.basename(cwd.split(`${path.sep}.claude${path.sep}worktrees${path.sep}`)[0]);
  return dirName.replace(/^-/, '').split('-').slice(-1)[0] || dirName;
}

function firstPrompt(chunk: Chunk): string | undefined {
  const p = chunk.items.find((i) => i.isPrompt)?.text ?? chunk.carriedPrompt;
  return p?.replace(/^USER:\s*/, '').replace(/\s+/g, ' ').trim();
}

export function chunkToRecord(
  chunk: Chunk,
  file: string,
  meta: Partial<FileState>,
  opts: { subagent: boolean; parentTitle?: string; dirName: string; fileMtime: Date },
): RecordInput {
  const sessionId = meta.sessionId ?? path.basename(file, '.jsonl');
  const project = projectName(meta.cwd, opts.dirName);
  const sessionTitle = meta.title || meta.aiTitle;
  const prompt = firstPrompt(chunk) ?? '';
  let title: string;
  let id: string;
  if (opts.subagent) {
    const agent = path.basename(file, '.jsonl').replace(/^agent-/, '');
    id = `sa-${agent.slice(0, 10)}-${chunk.index}`;
    title = `Subagent${opts.parentTitle ? ` of "${opts.parentTitle}"` : ''}: ${cap(prompt, 90)}`;
  } else {
    id = `cs-${sessionId.slice(0, 8)}-${chunk.index}`;
    // Long sessions drift: later parts also carry their own first prompt.
    if (!sessionTitle) title = cap(prompt, 100);
    else if (chunk.index === 0) title = sessionTitle;
    else title = `${sessionTitle} (part ${chunk.index + 1})${prompt ? `: ${cap(prompt, 70)}` : ''}`;
  }
  const lastTs = [...chunk.items].reverse().find((i) => i.ts)?.ts;
  const header = [
    `Project: ${meta.cwd ?? project}`,
    meta.branch ? `Branch: ${meta.branch}` : '',
    sessionTitle ? `Session: ${sessionTitle}` : '',
    opts.parentTitle ? `Parent session: ${opts.parentTitle}` : '',
    chunk.carriedPrompt ? `(continuing) ${cap(chunk.carriedPrompt, 400)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    id,
    source: 'claude-sessions',
    title: `[${project}] ${title}`,
    date: lastTs ?? opts.fileMtime.toISOString(),
    uri: `${file}#L${chunk.line}-L${chunk.endLine}`,
    body: header + '\n\n' + chunk.items.map((i) => i.text).join('\n\n'),
    meta: { sessionId, cwd: meta.cwd, branch: meta.branch, file, lines: [chunk.line, chunk.endLine], subagent: opts.subagent, part: chunk.index + 1 },
    priority: opts.subagent ? 0 : 1,
  };
}

export function listSessionFiles(root: string, includeSubagents: boolean, exclude: string[]): string[] {
  if (!fs.existsSync(root)) return [];
  const files = (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.jsonl'))
    .filter((f) => includeSubagents || !f.includes(`${path.sep}subagents${path.sep}`))
    .map((f) => path.join(root, f))
    .filter((f) => !exclude.some((x) => x && f.includes(x)));
  // Main sessions first so subagents can name their parent.
  const isSub = (f: string) => f.includes(`${path.sep}subagents${path.sep}`);
  return files.sort((a, b) => Number(isSub(a)) - Number(isSub(b)) || a.localeCompare(b));
}

export const claudeSessions: Connector = {
  name: 'claude-sessions',
  describe: (cfg) => `Claude Code transcripts in ${cfg.connectors['claude-sessions'].projectsDir}`,
  enabled: (cfg) => cfg.connectors['claude-sessions'].enabled,
  async run(ctx: ConnectorContext): Promise<ConnectorResult> {
    const cfg = ctx.config.connectors['claude-sessions'];
    const root = path.resolve(expandHome(cfg.projectsDir));
    if (!fs.existsSync(root)) throw new Error(`projects dir not found: ${root}`);
    const now = (ctx.now ?? new Date()).getTime();
    const state = ctx.brain.getState<State>('claude-sessions', { files: {} });
    state.files ??= {};
    const files = listSessionFiles(root, cfg.includeSubagents, cfg.exclude);
    let created = 0;
    let updated = 0;
    let touched = 0;
    let waiting = 0;
    const titles = new Map<string, string>(); // sessionId -> title, for subagents

    for (const file of files) {
      const rel = path.relative(root, file);
      const subagent = rel.includes(`${path.sep}subagents${path.sep}`);
      const st = fs.statSync(file);
      const idle = now - st.mtimeMs >= cfg.idleMinutes * 60_000;
      let fsState = state.files[rel];
      if (fsState && !subagent && fsState.sessionId) titles.set(fsState.sessionId, fsState.title || fsState.aiTitle || '');
      const unchanged = fsState && fsState.size === st.size && fsState.mtimeMs === st.mtimeMs;
      if (unchanged && !(fsState.tailPending && idle)) continue;
      if (!fsState || st.size < fsState.offset) {
        fsState = { size: 0, mtimeMs: 0, offset: 0, line: 1, chunk: 0, tailPending: false };
      }
      touched++;

      const fd = fs.openSync(file, 'r');
      const len = st.size - fsState.offset;
      const buf = Buffer.alloc(Math.max(0, len));
      if (len > 0) fs.readSync(fd, buf, 0, len, fsState.offset);
      fs.closeSync(fd);

      const meta: Partial<FileState> = { ...fsState };
      const { items } = parseItems(buf, fsState.offset, fsState.line, meta, subagent);
      const chunks = chunkItems(items, fsState.chunk, fsState.prompt);
      const dirName = rel.split(path.sep)[0];
      let parentTitle: string | undefined;
      if (subagent) {
        const parentId = rel.split(path.sep)[1];
        parentTitle = titles.get(parentId) || undefined;
      }

      const ctxOpts = { subagent, parentTitle, dirName, fileMtime: st.mtime };
      ctx.brain.transaction(() => {
        chunks.forEach((chunk, i) => {
          const isTail = i === chunks.length - 1;
          if (isTail && !idle) return;
          const res = ctx.brain.upsertRecord(chunkToRecord(chunk, file, meta, ctxOpts));
          if (res === 'new') created++;
          if (res === 'updated') updated++;
        });
      });

      // The last chunk stays open: next run re-reads from its start so it can keep growing.
      const tail = chunks[chunks.length - 1];
      state.files[rel] = {
        ...meta,
        size: st.size,
        mtimeMs: st.mtimeMs,
        offset: tail ? tail.offset : fsState.offset + buf.lastIndexOf(0x0a) + 1,
        line: tail ? tail.line : fsState.line + countNewlines(buf),
        chunk: tail ? tail.index : fsState.chunk,
        tailPending: Boolean(tail) && !idle,
        prompt: tail ? tail.carriedPrompt : fsState.prompt,
      };
      if (state.files[rel].tailPending) waiting++;
      if (!subagent && meta.sessionId) titles.set(meta.sessionId, meta.title || meta.aiTitle || '');
      ctx.brain.setState('claude-sessions', state);
    }
    // Forget files Claude Code has cleaned up; their records stay in the brain.
    const live = new Set(files.map((f) => path.relative(root, f)));
    for (const rel of Object.keys(state.files)) if (!live.has(rel)) delete state.files[rel];
    ctx.brain.setState('claude-sessions', state);

    const main = files.filter((f) => !f.includes(`${path.sep}subagents${path.sep}`)).length;
    return {
      new: created,
      updated,
      notes: [
        `${files.length} session files on disk (${main} sessions, ${files.length - main} subagent transcripts)`,
        `${touched} changed since last run`,
        ...(waiting ? [`${waiting} still active; their latest part is indexed once idle ${cfg.idleMinutes} min`] : []),
      ],
    };
  },
};

function countNewlines(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) n++;
  return n;
}
