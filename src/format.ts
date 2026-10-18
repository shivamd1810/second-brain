// Text renderings shared by the CLI and the MCP server.
import type { Facts, StoredRecord } from './db.ts';
import type { SearchHit } from './search.ts';

export function parseFacts(json: string | null): Facts | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Facts;
  } catch {
    return null;
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n - 1) + '…';
}

export function factLines(f: Facts | null, max = 3): string[] {
  if (!f) return [];
  const lines: string[] = [];
  for (const d of f.decisions.slice(0, max)) lines.push(`Decision: ${clip(d.decision, 160)} — because ${clip(d.reason, 160)}`);
  for (const e of f.errors.slice(0, max)) lines.push(`Error: ${clip(e, 200)}`);
  for (const x of f.fixes.slice(0, max)) lines.push(`Fix: ${clip(x, 200)}`);
  for (const c of f.commands.slice(0, 2)) lines.push(`Command: ${clip(c, 160)}`);
  return lines;
}

/** Search results as plain text for an agent: enough to answer, plus where it came from. */
export function hitsToText(query: string, hits: SearchHit[]): string {
  if (!hits.length)
    return `No matches for "${query}". Try different or fewer keywords (synonyms, a project name, an exact error message).`;
  const out = [`${hits.length} match(es) for "${query}", ranked by BM25 × recency (newer wins ties):`, ''];
  hits.forEach((h, i) => {
    out.push(`${i + 1}. ${h.date.slice(0, 10)} [${h.source}] ${h.title}`);
    out.push(`   id: ${h.id} · score ${h.score.toFixed(2)} (bm25 ${(-h.bm25).toFixed(2)} × recency ${h.recency.toFixed(2)})`);
    if (h.summarized) {
      if (h.question) out.push(`   Q: ${clip(h.question, 200)}`);
      if (h.summary) out.push(`   Summary: ${clip(h.summary, 600)}`);
      for (const l of factLines(parseFacts(h.facts_json))) out.push(`   ${l}`);
    } else {
      out.push(`   (no note yet) ${clip(h.snippet, 300)}`);
    }
    out.push(`   Source: ${h.uri}`);
    out.push('');
  });
  out.push('Call get_record(id) for the full original. If two results disagree, the newer one is usually current.');
  return out.join('\n');
}

export function recordToText(r: StoredRecord, maxChars = 20000): string {
  const f = parseFacts(r.facts_json);
  const out = [
    `${r.title}`,
    `id: ${r.id} · source: ${r.source} · date: ${r.date}`,
    `Source: ${r.uri}`,
    '',
  ];
  if (r.summary) {
    out.push(`Summary: ${r.summary}`);
    if (r.question) out.push(`Question: ${r.question}`);
    if (f) {
      if (f.decisions.length) out.push('Decisions:', ...f.decisions.map((d) => `  - ${d.decision} — because ${d.reason}`));
      if (f.errors.length) out.push('Errors:', ...f.errors.map((e) => `  - ${e}`));
      if (f.fixes.length) out.push('Fixes:', ...f.fixes.map((e) => `  - ${e}`));
      if (f.commands.length) out.push('Commands:', ...f.commands.map((e) => `  - ${e}`));
      if (f.keywords.length) out.push(`Keywords: ${f.keywords.join(', ')}`);
    }
    out.push(`(note by ${r.summary_model} at ${r.summarized_at})`, '');
  } else out.push('(no note yet: run `second-brain sync`)', '');
  const body = r.body.length > maxChars ? r.body.slice(0, maxChars) + `\n[… ${r.body.length - maxChars} more chars; open the source above]` : r.body;
  out.push('--- original ---', body);
  return out.join('\n');
}
