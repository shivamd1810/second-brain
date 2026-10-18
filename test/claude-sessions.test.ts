import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { chunkItems, claudeSessions, cleanUserText, TARGET_CHARS, type Item } from '../src/connectors/claude-sessions.ts';
import { assistant, memBrain, testConfig, tmpDir, toolResult, user } from './helpers.ts';

function setup() {
  const root = tmpDir();
  const proj = path.join(root, '-work-demo-app');
  fs.mkdirSync(proj);
  const file = path.join(proj, 'abcdef12-3456-7890-abcd-ef1234567890.jsonl');
  const cfg = testConfig((c) => {
    c.connectors['claude-sessions'].projectsDir = root;
  });
  return { root, proj, file, cfg };
}

const later = (min: number) => new Date(Date.now() + min * 60_000);

test('cleanUserText strips harness wrappers but keeps the prompt', () => {
  assert.equal(cleanUserText('<system-reminder>ignore me</system-reminder>Fix the build'), 'Fix the build');
  assert.equal(cleanUserText('<command-name>/review</command-name><command-args>pr 12</command-args>'), '/review pr 12');
  assert.equal(cleanUserText('<local-command-stdout>noise</local-command-stdout>'), '');
});

test('keeps prompts, replies, shell commands and tool errors; drops tool output and thinking', async () => {
  const { file, cfg } = setup();
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'custom-title', customTitle: 'Switch to Postgres' }),
      user('Why is the app crashing on startup?', '2026-10-01T10:00:00Z'),
      assistant([{ type: 'thinking', thinking: 'SECRET THOUGHTS' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm start' } }], '2026-10-01T10:00:05Z'),
      toolResult('Error: SQLITE_BUSY: database is locked', '2026-10-01T10:00:06Z', true),
      assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/work/demo-app/db.ts' } }], '2026-10-01T10:00:07Z'),
      toolResult('HUGE FILE CONTENT '.repeat(500), '2026-10-01T10:00:08Z'),
      assistant([{ type: 'text', text: 'SQLite locks under concurrent writes. I recommend switching to Postgres.' }], '2026-10-01T10:00:09Z'),
      JSON.stringify({ type: 'attachment', attachment: { big: 'x'.repeat(1000) } }),
      '',
    ].join('\n'),
  );
  const brain = memBrain();
  const res = await claudeSessions.run({ brain, config: cfg, log: () => {}, now: later(60) });
  assert.equal(res.new, 1);
  const rec = brain.getRecord('cs-abcdef12-0')!;
  assert.match(rec.title, /\[demo-app\] Switch to Postgres/);
  assert.match(rec.body, /USER: Why is the app crashing/);
  assert.match(rec.body, /\$ npm start/);
  assert.match(rec.body, /TOOL ERROR: Error: SQLITE_BUSY/);
  assert.match(rec.body, /ASSISTANT: SQLite locks/);
  assert.doesNotMatch(rec.body, /SECRET THOUGHTS|HUGE FILE CONTENT/);
  assert.equal(rec.date, '2026-10-01T10:00:09Z', 'dated by the last message in the chunk');
  assert.match(rec.uri, /\.jsonl#L2-L7$/);
});

test('second run reads only what was appended, and an active tail waits until idle', async () => {
  const { file, cfg } = setup();
  const brain = memBrain();
  // Two replies that together fill a chunk (each item is capped at 4,000 chars).
  const half = 'x'.repeat(TARGET_CHARS / 2);
  fs.writeFileSync(
    file,
    [user('first task', '2026-10-01T10:00:00Z'), assistant([{ type: 'text', text: half }], '2026-10-01T10:01:00Z'), assistant([{ type: 'text', text: half }], '2026-10-01T10:02:00Z'), ''].join('\n'),
  );

  // File was just written: the only chunk is the open tail, so nothing is indexed yet.
  let res = await claudeSessions.run({ brain, config: cfg, log: () => {}, now: new Date() });
  assert.equal(res.new, 0);

  // Idle for an hour: the tail is written.
  res = await claudeSessions.run({ brain, config: cfg, log: () => {}, now: later(60) });
  assert.equal(res.new, 1);

  // Nothing changed: nothing new.
  res = await claudeSessions.run({ brain, config: cfg, log: () => {}, now: later(60) });
  assert.equal(res.new, 0);
  assert.equal(res.updated, 0);

  // A new prompt after a full chunk starts chunk 1; chunk 0 is closed and unchanged.
  fs.appendFileSync(file, [user('second task: add caching', '2026-10-02T09:00:00Z'), assistant([{ type: 'text', text: 'Added Redis caching.' }], '2026-10-02T09:01:00Z'), ''].join('\n'));
  res = await claudeSessions.run({ brain, config: cfg, log: () => {}, now: later(60) });
  assert.equal(res.new, 1, 'one new chunk since last run');
  assert.equal(res.updated, 0);
  const second = brain.getRecord('cs-abcdef12-1')!;
  assert.match(second.body, /second task: add caching/);
  assert.match(second.title, /\[demo-app\] second task: add caching/, "untitled sessions are named by the prompt");
  assert.match(second.body, /Added Redis caching/);
  assert.doesNotMatch(second.body, /first task/);

  // Appending to the open chunk updates it (same id), it doesn't duplicate it.
  fs.appendFileSync(file, [assistant([{ type: 'text', text: 'Also set a TTL of 60s.' }], '2026-10-02T09:02:00Z'), ''].join('\n'));
  res = await claudeSessions.run({ brain, config: cfg, log: () => {}, now: later(60) });
  assert.equal(res.new, 0);
  assert.equal(res.updated, 1);
  assert.match(brain.getRecord('cs-abcdef12-1')!.body, /TTL of 60s/);
});

test('subagent transcripts are indexed with their parent title', async () => {
  const { proj, file, cfg } = setup();
  fs.writeFileSync(file, [JSON.stringify({ type: 'ai-title', aiTitle: 'Billing refactor' }), user('refactor billing', '2026-10-01T10:00:00Z'), ''].join('\n'));
  const subDir = path.join(proj, 'abcdef12-3456-7890-abcd-ef1234567890', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, 'agent-a1b2c3d4e5f6.jsonl'),
    [user('Find every caller of chargeCard', '2026-10-01T10:05:00Z', { isSidechain: true }), assistant([{ type: 'text', text: 'Found 3 callers.' }], '2026-10-01T10:06:00Z'), ''].join('\n'),
  );
  const brain = memBrain();
  await claudeSessions.run({ brain, config: cfg, log: () => {}, now: later(60) });
  const sub = brain.getRecord('sa-a1b2c3d4e5-0')!;
  assert.ok(sub, 'subagent record exists');
  assert.match(sub.title, /Subagent of "Billing refactor": Find every caller of chargeCard/);
  assert.equal(sub.priority, 0);

  cfg.connectors['claude-sessions'].includeSubagents = false;
  const brain2 = memBrain();
  await claudeSessions.run({ brain: brain2, config: cfg, log: () => {}, now: later(60) });
  assert.equal(brain2.getRecord('sa-a1b2c3d4e5-0'), undefined);
});

test('worktree sessions are named after their repo', async () => {
  const { projectName } = await import('../src/connectors/claude-sessions.ts');
  assert.equal(projectName('/Users/me/code/shop/.claude/worktrees/agent-a7094', 'x'), 'shop');
  assert.equal(projectName('/Users/me/code/shop', 'x'), 'shop');
});

test('chunking closes at a prompt after TARGET_CHARS and force-splits huge turns', () => {
  const mk = (i: number, text: string, isPrompt = false): Item => ({ offset: i * 100, line: i + 1, ts: null, text, isPrompt });
  const items = [mk(0, 'USER: a', true), mk(1, 'x'.repeat(TARGET_CHARS)), mk(2, 'USER: b', true), mk(3, 'y'.repeat(5000)), mk(4, 'z'.repeat(5000)), mk(5, 'w'.repeat(5000))];
  const chunks = chunkItems(items, 0);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[1].items[0].text, 'USER: b');
  assert.equal(chunks[2].carriedPrompt, 'USER: b', 'a forced split remembers the prompt in force');
});
