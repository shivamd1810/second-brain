// BM25 over the notes, times a small recency boost. No embeddings, no vector database.
//
//   relevance = -bm25(notes_fts, 3, 4, 2, 2, 0.25)     (SQLite returns lower = better)
//   recency   = 1 + boost * 0.5 ^ (age_days / half_life_days)
//   score     = relevance * recency
//
// With the defaults (boost 0.5, half-life 30 days) a record from today gets x1.5,
// one from a month ago x1.25, one from three months ago x1.06. Newer wins ties,
// older slowly fades, but a much better text match still beats a newer weak one.
import type { Brain } from './db.ts';
import type { SearchConfig } from './config.ts';

/** Column weights for bm25(): title, question, summary, facts, raw body. */
export const BM25_WEIGHTS = [3.0, 4.0, 2.0, 2.0, 0.25] as const;

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
  bm25: number;
  age_days: number;
  recency: number;
  score: number;
  snippet: string;
}

export function search(brain: Brain, query: string, cfg: SearchConfig, opts: SearchOptions = {}): SearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
  const where = ['notes_fts MATCH :q'];
  if (opts.source) where.push('r.source = :source');
  if (opts.since) where.push('r.date >= :since');
  const sql = `
    WITH hits AS (
      SELECT r.id, r.source, r.title, r.date, r.uri, r.summary, r.question, r.facts_json,
             (r.summary_hash = r.hash) AS summarized,
             bm25(notes_fts, ${BM25_WEIGHTS.join(', ')}) AS bm25,
             max(0.0, julianday('now') - julianday(r.date)) AS age_days,
             snippet(notes_fts, -1, '[', ']', ' … ', 16) AS snippet
      FROM notes_fts JOIN records r ON r.rid = notes_fts.rowid
      WHERE ${where.join(' AND ')}
    )
    SELECT *, 1.0 + :boost * pow(0.5, age_days / :half) AS recency,
           -bm25 * (1.0 + :boost * pow(0.5, age_days / :half)) AS score
    FROM hits
    ORDER BY score DESC
    LIMIT :limit`;
  const params: Record<string, string | number> = {
    q: fts,
    boost: cfg.recencyBoost,
    half: cfg.halfLifeDays,
    limit,
  };
  if (opts.source) params.source = opts.source;
  if (opts.since) params.since = opts.since;
  const rows = brain.db.prepare(sql).all(params) as unknown as (Omit<SearchHit, 'summarized'> & { summarized: number })[];
  return rows.map((r) => ({ ...r, summarized: Boolean(r.summarized) }));
}
