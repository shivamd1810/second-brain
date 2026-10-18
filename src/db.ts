// One SQLite file holds everything: records, their notes, an FTS5 index and connector state.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbPath } from './config.ts';

export interface RecordInput {
  id: string;
  source: string;
  title: string;
  /** ISO 8601. The date the thing happened, used for recency weighting. */
  date: string;
  /** Link back to the full original (file path + lines, URL, repo@sha). */
  uri: string;
  /** Cleaned original text. This is what the summarizer reads. */
  body: string;
  meta?: Record<string, unknown>;
  /** Higher is summarized first. */
  priority?: number;
}

export interface Facts {
  errors: string[];
  fixes: string[];
  commands: string[];
  decisions: { decision: string; reason: string }[];
  keywords: string[];
}

export interface StoredRecord {
  rid: number;
  id: string;
  source: string;
  title: string;
  date: string;
  uri: string;
  body: string;
  meta: string;
  priority: number;
  hash: string;
  summary: string | null;
  question: string | null;
  facts: string | null;
  facts_json: string | null;
  summary_hash: string | null;
  summary_model: string | null;
  summarized_at: string | null;
  ingested_at: string;
  updated_at: string;
}

export type UpsertResult = 'new' | 'updated' | 'unchanged';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  rid           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  date          TEXT NOT NULL,
  uri           TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  meta          TEXT NOT NULL DEFAULT '{}',
  priority      INTEGER NOT NULL DEFAULT 0,
  hash          TEXT NOT NULL,
  summary       TEXT,
  question      TEXT,
  facts         TEXT,          -- flattened facts + keywords, for search
  facts_json    TEXT,          -- structured facts
  summary_hash  TEXT,          -- hash of the body that was summarized
  summary_model TEXT,
  summarized_at TEXT,
  ingested_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_source_date ON records(source, date);
CREATE INDEX IF NOT EXISTS records_pending ON records(summary_hash, hash);

-- Plain-text index. bm25() ranks matches; external content keeps one copy of the text.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, question, summary, facts, body,
  content='records', content_rowid='rid',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
  INSERT INTO notes_fts(rowid, title, question, summary, facts, body)
  VALUES (new.rid, new.title, new.question, new.summary, new.facts, new.body);
END;
CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, question, summary, facts, body)
  VALUES ('delete', old.rid, old.title, old.question, old.summary, old.facts, old.body);
END;
CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, question, summary, facts, body)
  VALUES ('delete', old.rid, old.title, old.question, old.summary, old.facts, old.body);
  INSERT INTO notes_fts(rowid, title, question, summary, facts, body)
  VALUES (new.rid, new.title, new.question, new.summary, new.facts, new.body);
END;

CREATE TABLE IF NOT EXISTS connectors (
  name            TEXT PRIMARY KEY,
  state           TEXT NOT NULL DEFAULT '{}',
  last_run_at     TEXT,
  last_success_at TEXT,
  last_status     TEXT,
  last_error      TEXT,
  last_new        INTEGER NOT NULL DEFAULT 0,
  last_updated    INTEGER NOT NULL DEFAULT 0,
  last_new_at     TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,       -- connector name or 'summarize'
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT,
  new_count   INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  error       TEXT
);
`;

export function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class Brain {
  db: DatabaseSync;

  constructor(file: string = dbPath()) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
    if (file !== ':memory:') {
      try {
        fs.chmodSync(file, 0o600);
      } catch {}
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  upsertRecord(r: RecordInput): UpsertResult {
    const hash = sha(r.title + '\n' + r.body);
    const existing = this.db.prepare('SELECT hash FROM records WHERE id = ?').get(r.id) as
      | { hash: string }
      | undefined;
    const now = nowIso();
    const meta = JSON.stringify(r.meta ?? {});
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO records (id, source, title, date, uri, body, meta, priority, hash, ingested_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.id, r.source, r.title, r.date, r.uri, r.body, meta, r.priority ?? 0, hash, now, now);
      return 'new';
    }
    if (existing.hash === hash) return 'unchanged';
    this.db
      .prepare(
        `UPDATE records SET title = ?, date = ?, uri = ?, body = ?, meta = ?, priority = ?, hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(r.title, r.date, r.uri, r.body, meta, r.priority ?? 0, hash, now, r.id);
    return 'updated';
  }

  getRecord(id: string): StoredRecord | undefined {
    return this.db.prepare('SELECT * FROM records WHERE id = ?').get(id) as StoredRecord | undefined;
  }

  pending(limit: number): StoredRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM records WHERE summary_hash IS NULL OR summary_hash != hash
         ORDER BY priority DESC, date DESC LIMIT ?`,
      )
      .all(limit) as unknown as StoredRecord[];
  }

  /** Specific records that still need a note (for `summarize --ids`). */
  pendingByIds(ids: string[]): StoredRecord[] {
    if (!ids.length) return [];
    return this.db
      .prepare(
        `SELECT * FROM records WHERE id IN (${ids.map(() => '?').join(',')})
         AND (summary_hash IS NULL OR summary_hash != hash) ORDER BY date DESC`,
      )
      .all(...ids) as unknown as StoredRecord[];
  }

  pendingCount(): number {
    const row = this.db
      .prepare('SELECT count(*) AS n FROM records WHERE summary_hash IS NULL OR summary_hash != hash')
      .get() as { n: number };
    return row.n;
  }

  saveSummary(
    id: string,
    hash: string,
    note: { summary: string; question: string; facts: Facts },
    model: string,
  ): void {
    this.db
      .prepare(
        `UPDATE records SET summary = ?, question = ?, facts = ?, facts_json = ?, summary_hash = ?,
           summary_model = ?, summarized_at = ? WHERE id = ?`,
      )
      .run(
        note.summary,
        note.question,
        flattenFacts(note.facts),
        JSON.stringify(note.facts),
        hash,
        model,
        nowIso(),
        id,
      );
  }

  getState<T>(connector: string, fallback: T): T {
    const row = this.db.prepare('SELECT state FROM connectors WHERE name = ?').get(connector) as
      | { state: string }
      | undefined;
    return row ? (JSON.parse(row.state) as T) : fallback;
  }

  setState(connector: string, state: unknown): void {
    this.db
      .prepare(
        `INSERT INTO connectors (name, state) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET state = excluded.state`,
      )
      .run(connector, JSON.stringify(state));
  }

  startRun(kind: string): number {
    const res = this.db.prepare('INSERT INTO runs (kind, started_at) VALUES (?, ?)').run(kind, nowIso());
    return Number(res.lastInsertRowid);
  }

  finishRun(
    runId: number,
    kind: string,
    out: { status: 'ok' | 'error'; newCount?: number; updatedCount?: number; costUsd?: number; error?: string },
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, status = ?, new_count = ?, updated_count = ?, cost_usd = ?, error = ?
         WHERE id = ?`,
      )
      .run(now, out.status, out.newCount ?? 0, out.updatedCount ?? 0, out.costUsd ?? 0, out.error ?? null, runId);
    if (kind === 'summarize') return;
    this.db.prepare('INSERT INTO connectors (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(kind);
    if (out.status === 'ok') {
      this.db
        .prepare(
          `UPDATE connectors SET last_run_at = ?, last_success_at = ?, last_status = 'ok', last_error = NULL,
             last_new = ?, last_updated = ?,
             last_new_at = CASE WHEN ? > 0 THEN ? ELSE last_new_at END
           WHERE name = ?`,
        )
        .run(now, now, out.newCount ?? 0, out.updatedCount ?? 0, out.newCount ?? 0, now, kind);
    } else {
      this.db
        .prepare(
          `UPDATE connectors SET last_run_at = ?, last_status = 'error', last_error = ? WHERE name = ?`,
        )
        .run(now, out.error ?? 'unknown error', kind);
    }
  }

  connectorRows(): ConnectorRow[] {
    return this.db.prepare('SELECT * FROM connectors ORDER BY name').all() as unknown as ConnectorRow[];
  }

  counts(): { source: string; total: number; summarized: number; newest: string | null }[] {
    return this.db
      .prepare(
        `SELECT source, count(*) AS total,
           sum(CASE WHEN summary_hash = hash THEN 1 ELSE 0 END) AS summarized,
           max(date) AS newest
         FROM records GROUP BY source ORDER BY source`,
      )
      .all() as unknown as { source: string; total: number; summarized: number; newest: string | null }[];
  }
}

export interface ConnectorRow {
  name: string;
  state: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_new: number;
  last_updated: number;
  last_new_at: string | null;
}

export function flattenFacts(f: Facts): string {
  const parts: string[] = [];
  for (const e of f.errors) parts.push(`error: ${e}`);
  for (const x of f.fixes) parts.push(`fix: ${x}`);
  for (const c of f.commands) parts.push(`command: ${c}`);
  for (const d of f.decisions) parts.push(`decision: ${d.decision} because ${d.reason}`);
  if (f.keywords.length) parts.push(`keywords: ${f.keywords.join(', ')}`);
  return parts.join('\n');
}
