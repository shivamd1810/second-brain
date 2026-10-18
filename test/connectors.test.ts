import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gitConnector, githubUrl, parseGitLog } from '../src/connectors/git.ts';
import { header, htmlToText, messageText, messageToRecord, stripQuoted, type GmailMessage } from '../src/connectors/gmail.ts';
import { notesConnector, splitNote } from '../src/connectors/notes.ts';
import { memBrain, testConfig, tmpDir } from './helpers.ts';

function gitRepo(): string {
  const dir = tmpDir('sb-git-');
  const g = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'd@x', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'd@x' },
      stdio: 'ignore',
    });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'db.ts'), 'sqlite');
  g('add', '.');
  g('commit', '-q', '-m', 'Use SQLite for storage', '-m', 'Simple and local.');
  return dir;
}

test('git: first run ingests history, later runs only new commits', async () => {
  const repo = gitRepo();
  const cfg = testConfig((c) => {
    c.connectors.git.repos = [repo];
  });
  const brain = memBrain();
  let res = await gitConnector.run({ brain, config: cfg, log: () => {} });
  assert.equal(res.new, 1);
  res = await gitConnector.run({ brain, config: cfg, log: () => {} });
  assert.equal(res.new, 0, 'nothing new since last run');

  fs.writeFileSync(path.join(repo, 'db.ts'), 'postgres');
  execFileSync('git', ['-C', repo, 'commit', '-qam', 'Switch to Postgres: SQLite locked under concurrent writes'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'd@x', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'd@x' },
  });
  res = await gitConnector.run({ brain, config: cfg, log: () => {} });
  assert.equal(res.new, 1);
  const rows = brain.db.prepare("SELECT title, body FROM records WHERE source = 'git' ORDER BY date").all() as { title: string; body: string }[];
  assert.match(rows[1].title, /Switch to Postgres/);
  assert.match(rows[1].body, /Files changed \(1\):\n- db\.ts/);
});

test('git: parse log output and GitHub links', () => {
  const out = '\x1eabc123\x1fDev\x1f2026-10-01T10:00:00+05:30\x1fFix bug\x1fLonger body\x1f\n\nsrc/a.ts\nsrc/b.ts\n';
  const [c] = parseGitLog(out);
  assert.deepEqual(c, { sha: 'abc123', author: 'Dev', date: '2026-10-01T10:00:00+05:30', subject: 'Fix bug', body: 'Longer body', files: ['src/a.ts', 'src/b.ts'] });
  assert.equal(githubUrl('git@github.com:me/app.git', 'abc'), 'https://github.com/me/app/commit/abc');
  assert.equal(githubUrl('https://github.com/me/app', 'abc'), 'https://github.com/me/app/commit/abc');
  assert.equal(githubUrl('https://gitlab.com/me/app.git', 'abc'), undefined);
});

test('notes: indexes markdown, re-reads only changed files', async () => {
  const dir = tmpDir('sb-notes-');
  fs.writeFileSync(path.join(dir, 'db.md'), '# Database decision\nWe chose Postgres.');
  fs.writeFileSync(path.join(dir, 'skip.png'), 'binary');
  const cfg = testConfig((c) => {
    c.connectors.notes.enabled = true;
    c.connectors.notes.dirs = [dir];
  });
  const brain = memBrain();
  let res = await notesConnector.run({ brain, config: cfg, log: () => {} });
  assert.equal(res.new, 1);
  res = await notesConnector.run({ brain, config: cfg, log: () => {} });
  assert.equal(res.new + res.updated, 0);
  fs.writeFileSync(path.join(dir, 'db.md'), '# Database decision\nWe chose Postgres, then moved to Neon.');
  fs.utimesSync(path.join(dir, 'db.md'), new Date(), new Date(Date.now() + 5000));
  res = await notesConnector.run({ brain, config: cfg, log: () => {} });
  assert.equal(res.updated, 1);
  const rec = brain.db.prepare("SELECT title FROM records WHERE source = 'notes'").get() as { title: string };
  assert.equal(rec.title, 'Database decision');
  assert.equal(splitNote('a\n\n'.repeat(10000)).every((p) => p.length <= 12000), true);
});

test('gmail: message parsing (plain, html, quoted replies)', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const m: GmailMessage = {
    id: '18f00',
    threadId: '18e00',
    internalDate: String(Date.parse('2026-10-05T08:00:00Z')),
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'Subject', value: 'Invoice API keys rotated' },
        { name: 'From', value: 'Ops Team <ops@example.com>' },
        { name: 'To', value: 'me@example.com' },
        { name: 'Date', value: 'Sun, 5 Oct 2026 08:00:00 +0000' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64('We rotated the keys.\n\nOn Sat, Oct 4, 2026 Bob wrote:\n> old stuff') } },
        { mimeType: 'text/html', body: { data: b64('<p>ignored</p>') } },
      ],
    },
  };
  assert.equal(header(m, 'subject'), 'Invoice API keys rotated');
  assert.equal(messageText(m), 'We rotated the keys.');
  const rec = messageToRecord(m);
  assert.equal(rec.id, 'gm-18f00');
  assert.equal(rec.date, '2026-10-05T08:00:00.000Z');
  assert.equal(rec.uri, 'https://mail.google.com/mail/u/0/#all/18e00');
  assert.match(rec.title, /\[email\] Invoice API keys rotated \(from Ops Team\)/);
  assert.equal(htmlToText('<style>x{}</style><p>Hi&nbsp;there</p><br>Bye'), 'Hi there\n\nBye');
  assert.equal(stripQuoted('new\n> quoted\nmore'), 'new\nmore');
});
