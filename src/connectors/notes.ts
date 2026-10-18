// Notes: a folder of markdown / text files. A file is re-read only when its mtime or size changes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.ts';
import type { RecordInput } from '../db.ts';
import type { Connector, ConnectorContext, ConnectorResult } from './types.ts';

const PART_CHARS = 12000;

interface State {
  files: Record<string, { mtimeMs: number; size: number }>;
}

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

/** Split long notes at headings (or blank lines) into parts of at most PART_CHARS. */
export function splitNote(text: string): string[] {
  if (text.length <= PART_CHARS) return [text];
  const blocks = text.split(/\n(?=#{1,3} )|\n{2,}/);
  const parts: string[] = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && cur.length + b.length + 1 > PART_CHARS) {
      parts.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + b.slice(0, PART_CHARS);
  }
  if (cur) parts.push(cur);
  return parts;
}

export function noteToRecords(file: string, text: string, mtime: Date): RecordInput[] {
  const key = crypto.createHash('sha1').update(file).digest('hex').slice(0, 10);
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const name = heading || path.basename(file);
  const parts = splitNote(text);
  return parts.map((body, i) => ({
    id: `note-${key}-${i}`,
    source: 'notes',
    title: parts.length > 1 ? `${name} (part ${i + 1})` : name,
    date: mtime.toISOString(),
    uri: file,
    body: `File: ${file}\n\n${body}`,
    meta: { file, part: i + 1 },
    priority: 1,
  }));
}

export const notesConnector: Connector = {
  name: 'notes',
  describe: (cfg) =>
    cfg.connectors.notes.dirs.length ? cfg.connectors.notes.dirs.join(', ') : 'no folders configured (connectors.notes.dirs)',
  enabled: (cfg) => cfg.connectors.notes.enabled && cfg.connectors.notes.dirs.length > 0,
  async run(ctx: ConnectorContext): Promise<ConnectorResult> {
    const cfg = ctx.config.connectors.notes;
    const state = ctx.brain.getState<State>('notes', { files: {} });
    state.files ??= {};
    let created = 0;
    let updated = 0;
    let scanned = 0;
    for (const raw of cfg.dirs) {
      const dir = path.resolve(expandHome(raw));
      if (!fs.existsSync(dir)) throw new Error(`notes folder not found: ${dir}`);
      for (const file of walk(dir, cfg.extensions)) {
        scanned++;
        const st = fs.statSync(file);
        const prev = state.files[file];
        if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
        const text = fs.readFileSync(file, 'utf8');
        ctx.brain.transaction(() => {
          for (const rec of noteToRecords(file, text, st.mtime)) {
            const res = ctx.brain.upsertRecord(rec);
            if (res === 'new') created++;
            if (res === 'updated') updated++;
          }
        });
        state.files[file] = { mtimeMs: st.mtimeMs, size: st.size };
      }
    }
    ctx.brain.setState('notes', state);
    return { new: created, updated, notes: [`${scanned} note file(s) scanned`] };
  },
};
