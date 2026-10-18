import assert from 'node:assert/strict';
import { test } from 'node:test';
import { search, toFtsQuery } from '../src/search.ts';
import { memBrain, testConfig } from './helpers.ts';

test('toFtsQuery drops stopwords, quotes terms and keeps phrases', () => {
  assert.equal(toFtsQuery('Why did we switch the database to Postgres?'), '"switch" OR "database" OR "postgres"');
  assert.equal(toFtsQuery('"connection refused" docker'), '"connection refused" OR "docker"');
  assert.equal(toFtsQuery('what is the'), '');
  // FTS5 syntax characters can't break the query
  assert.equal(toFtsQuery('foo* AND (bar OR "baz'), '"foo" OR "bar" OR "baz"');
});

test('BM25 ranks better text matches higher; recency breaks ties', () => {
  const brain = memBrain();
  const cfg = testConfig();
  const day = 86_400_000;
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
  const add = (id: string, title: string, body: string, daysAgo: number) =>
    brain.upsertRecord({ id, source: 'notes', title, date: iso(daysAgo), uri: id, body });

  add('march', 'Database choice', 'We use SQLite for the app database.', 200);
  add('june', 'Database choice', 'We use Postgres for the app database.', 2);
  add('other', 'Lunch', 'Pizza on Friday.', 1);

  const hits = search(brain, 'app database', cfg.search);
  assert.deepEqual(hits.map((h) => h.id), ['june', 'march'], 'same text match: newer first, unrelated record excluded');
  assert.ok(hits[0].recency > hits[1].recency);
  assert.ok(Math.abs(hits[0].score - -hits[0].bm25 * hits[0].recency) < 1e-9, 'score = relevance × recency');

  // A strong old match still beats a weak new one.
  add('old-strong', 'Postgres connection pooling with pgbouncer', 'pgbouncer pooling postgres pgbouncer', 300);
  add('new-weak', 'Weekly notes', 'Mentioned pooling once.', 0);
  const pool = search(brain, 'pgbouncer pooling', cfg.search);
  assert.equal(pool[0].id, 'old-strong');
});

test('search filters by source and since', () => {
  const brain = memBrain();
  const cfg = testConfig();
  brain.upsertRecord({ id: 'a', source: 'git', title: 'fix launchd PATH', date: '2026-01-01T00:00:00Z', uri: 'a', body: 'launchd' });
  brain.upsertRecord({ id: 'b', source: 'notes', title: 'launchd notes', date: '2026-06-01T00:00:00Z', uri: 'b', body: 'launchd' });
  assert.deepEqual(search(brain, 'launchd', cfg.search, { source: 'git' }).map((h) => h.id), ['a']);
  assert.deepEqual(search(brain, 'launchd', cfg.search, { since: '2026-03-01' }).map((h) => h.id), ['b']);
});

test('updating a record re-indexes it and marks it for a new note', () => {
  const brain = memBrain();
  const cfg = testConfig();
  const rec = { id: 'x', source: 'notes', title: 'Plan', date: new Date().toISOString(), uri: 'x', body: 'use redis' };
  assert.equal(brain.upsertRecord(rec), 'new');
  assert.equal(brain.upsertRecord(rec), 'unchanged');
  brain.saveSummary('x', brain.getRecord('x')!.hash, { summary: 's', question: 'q', facts: { errors: [], fixes: [], commands: [], decisions: [], keywords: [] } }, 'm');
  assert.equal(brain.pendingCount(), 0);
  assert.equal(brain.upsertRecord({ ...rec, body: 'use valkey instead' }), 'updated');
  assert.equal(brain.pendingCount(), 1);
  assert.equal(search(brain, 'redis', cfg.search).length, 0);
  assert.equal(search(brain, 'valkey', cfg.search).length, 1);
});

test('doctor: a connector that never succeeded is STALE; a healthy one is OK', async () => {
  const { connectorHealth } = await import('../src/health.ts');
  const brain = memBrain();
  const cfg = testConfig((c) => {
    c.connectors.gmail.enabled = true;
  });
  const ok = brain.startRun('claude-sessions');
  brain.finishRun(ok, 'claude-sessions', { status: 'ok', newCount: 3 });
  const bad = brain.startRun('gmail');
  brain.finishRun(bad, 'gmail', { status: 'error', error: 'token revoked' });
  const h = Object.fromEntries(connectorHealth(brain, cfg).map((x) => [x.name, x]));
  assert.equal(h['claude-sessions'].status, 'OK');
  assert.equal(h.gmail.status, 'STALE');
  assert.match(h.gmail.detail, /never synced successfully \(last error: token revoked\)/);
  assert.equal(h.notes.status, 'OFF');
  // A long silence after a good run is STALE too.
  const later = Date.now() + 7 * 3_600_000;
  assert.equal(Object.fromEntries(connectorHealth(brain, cfg, later).map((x) => [x.name, x]))['claude-sessions'].status, 'STALE');
});

test('a word that is everywhere in raw transcripts still counts in the notes', () => {
  // "acme" appears in the raw text of most records, so raw-text BM25 gives it ~zero weight.
  // The note index has its own word statistics, so the record whose note is about it wins.
  const brain = memBrain();
  const cfg = testConfig();
  const now = new Date().toISOString();
  for (let i = 0; i < 20; i++)
    brain.upsertRecord({ id: `noise${i}`, source: 'notes', title: `Keep notes ${i}`, date: now, uri: 'x', body: `acme acme acme skills report ${i}` });
  brain.upsertRecord({ id: 'decision', source: 'notes', title: 'Skill storage', date: now, uri: 'x', body: 'long transcript' });
  const facts = { errors: [], fixes: [], commands: [], decisions: [{ decision: 'Keep the Acme skills in one GitHub repo', reason: 'zips had no history' }], keywords: ['acme skills'] };
  brain.saveSummary('decision', brain.getRecord('decision')!.hash, { summary: 'Where the Acme skills live.', question: 'where do we keep the acme skills?', facts }, 'm');
  const hits = search(brain, 'where do we keep the acme skills', cfg.search);
  assert.equal(hits[0].id, 'decision');
  assert.ok(hits[0].notes_rel > 0, 'won on the note, not the raw text');
});
