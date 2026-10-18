// BM25 over the notes, times a small recency boost. No embeddings, no vector database.
//
//   relevance = -bm25(notes_fts, 3, 4, 2, 2) + 0.25 * -bm25(raw_fts)   (SQLite: lower = better)
//               notes: title, question, summary, facts      raw: the cleaned original text
//   recency   = 1 + boost * 0.5 ^ (age_days / half_life_days)
//   score     = relevance * recency
//
// With the defaults (boost 0.5, half-life 30 days) a record from today gets x1.5,
// one from a month ago x1.25, one from three months ago x1.06. Newer wins ties,
// older slowly fades, but a much better text match still beats a newer weak one.
import type { Brain } from './db.ts';
import type { SearchConfig } from './config.ts';

/** Column weights for bm25(notes_fts): title, question, summary, facts. */
export const BM25_WEIGHTS = [3.0, 4.0, 2.0, 2.0] as const;
/** How much a raw-text match counts next to a note match. */
export const RAW_WEIGHT = 0.25;

const STOPWORDS = new Set(
  `a an and are as at be been but by can could did do does doing done for from had has have how i if in into is it
   its me my of on or our so than that the their them then there these they this to was we were what when where
   which while who why will with would you your about after again all also any because before being both did
   each few more most other over same should some such only own just very ever us via vs
   remember remind recall tell know find search show please last ago`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Turn whatever the agent typed into a safe FTS5 query.
 * Words are OR'ed (BM25 rewards records matching more of them); "quoted phrases" stay phrases.
 */
export function toFtsQuery(input: string): string {
  const parts: string[] = [];
  const rest = input.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const words = phrase.match(/[\p{L}\p{N}_]+/gu);
    if (words?.length) parts.push(`"${words.join(' ')}"`);
    return ' ';
  });
  const seen = new Set<string>();
  for (const raw of rest.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const w = raw.toLowerCase();
    if (w.length < 2 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    parts.push(`"${w}"`);
  }
  return parts.join(' OR ');
}

export interface SearchOptions {
  limit?: number;
  source?: string;
  /** ISO date; only records on or after it. */
  since?: string;
}

export interface SearchHit {
  id: string;
  source: string;
  title: string;
  date: string;
  uri: string;
  summary: string | null;
  question: string | null;
  facts_json: string | null;
  summarized: boolean;
  /** Combined relevance as a bm25()-style negative number (kept for compatibility). */
  bm25: number;
  /** Relevance from the note fields and from the raw text, before weighting. */
  notes_rel: number;
  raw_rel: number;
  age_days: number;
  recency: number;
  score: number;
  snippet: string;
}

export function search(brain: Brain, query: string, cfg: SearchConfig, opts: SearchOptions = {}): SearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
  const where: string[] = [];
  if (opts.source) where.push('r.source = :source');
  if (opts.since) where.push('r.date >= :since');
  const sql = `
    WITH n AS (SELECT rowid AS rid, -bm25(notes_fts, ${BM25_WEIGHTS.join(', ')}) AS rel FROM notes_fts WHERE notes_fts MATCH :q),
         b AS (SELECT rowid AS rid, -bm25(raw_fts) AS rel FROM raw_fts WHERE raw_fts MATCH :q),
         u AS (SELECT rid, sum(nrel) AS notes_rel, sum(brel) AS raw_rel
               FROM (SELECT rid, rel AS nrel, 0.0 AS brel FROM n UNION ALL SELECT rid, 0.0, rel FROM b)
               GROUP BY rid),
         hits AS (
           SELECT r.rid, r.id, r.source, r.title, r.date, r.uri, r.summary, r.question, r.facts_json,
                  (r.summary_hash = r.hash) AS summarized, u.notes_rel, u.raw_rel,
                  u.notes_rel + :raw * u.raw_rel AS relevance,
                  max(0.0, julianday('now') - julianday(r.date)) AS age_days
           FROM u JOIN records r ON r.rid = u.rid
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         )
    SELECT *, -relevance AS bm25, 1.0 + :boost * pow(0.5, age_days / :half) AS recency,
           relevance * (1.0 + :boost * pow(0.5, age_days / :half)) AS score
    FROM hits
    ORDER BY score DESC
    LIMIT :limit`;
  const params: Record<string, string | number> = {
    q: fts,
    raw: RAW_WEIGHT,
    boost: cfg.recencyBoost,
    half: cfg.halfLifeDays,
    limit,
  };
  if (opts.source) params.source = opts.source;
  if (opts.since) params.since = opts.since;
  type Row = Omit<SearchHit, 'summarized' | 'snippet'> & { rid: number; summarized: number };
  const rows = brain.db.prepare(sql).all(params) as unknown as Row[];
  // Snippets only for the few hits we return: from the note if it matched there, else the raw text.
  const noteSnip = brain.db.prepare("SELECT snippet(notes_fts, -1, '[', ']', ' … ', 16) AS s FROM notes_fts WHERE notes_fts MATCH ? AND rowid = ?");
  const rawSnip = brain.db.prepare("SELECT snippet(raw_fts, 0, '[', ']', ' … ', 16) AS s FROM raw_fts WHERE raw_fts MATCH ? AND rowid = ?");
  return rows.map(({ rid, ...r }) => {
    const snip = (r.notes_rel > 0 ? noteSnip : rawSnip).get(fts, rid) as { s: string } | undefined;
    return { ...r, summarized: Boolean(r.summarized), snippet: snip?.s ?? '' };
  });
}

/** Newest records first, no keywords: for "what was I working on last week?" questions. */
export function recent(brain: Brain, opts: { days?: number; limit?: number; source?: string } = {}): SearchHit[] {
  const days = Math.max(1, Math.min(opts.days ?? 7, 365));
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const where = ["julianday(r.date) >= julianday('now') - :days"];
  if (opts.source) where.push('r.source = :source');
  const params: Record<string, string | number> = { days, limit };
  if (opts.source) params.source = opts.source;
  const rows = brain.db
    .prepare(
      `SELECT r.id, r.source, r.title, r.date, r.uri, r.summary, r.question, r.facts_json,
              (r.summary_hash = r.hash) AS summarized, 0.0 AS bm25, 0.0 AS notes_rel, 0.0 AS raw_rel,
              max(0.0, julianday('now') - julianday(r.date)) AS age_days, 1.0 AS recency, 0.0 AS score,
              substr(r.body, 1, 300) AS snippet
       FROM records r WHERE ${where.join(' AND ')}
       ORDER BY r.priority DESC, r.date DESC LIMIT :limit`,
    )
    .all(params) as unknown as (Omit<SearchHit, 'summarized'> & { summarized: number })[];
  return rows.map((r) => ({ ...r, summarized: Boolean(r.summarized) }));
}
