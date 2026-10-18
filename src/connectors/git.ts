// Git history: message, author, date and files touched for each commit. Read-only (`git log`).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config.ts';
import type { RecordInput } from '../db.ts';
import type { Connector, ConnectorContext, ConnectorResult } from './types.ts';

interface RepoState {
  /** Newest commit date seen (ISO). */
  lastDate?: string;
}

interface State {
  repos: Record<string, RepoState>;
}

export interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: string[];
}

const RS = '\x1e';
const US = '\x1f';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function parseGitLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const part of out.split(RS)) {
    if (!part.trim()) continue;
    const [sha, author, date, subject, body, rest = ''] = part.split(US);
    commits.push({
      sha: sha.trim(),
      author,
      date,
      subject,
      body: body.trim(),
      files: rest.split('\n').map((f) => f.trim()).filter(Boolean),
    });
  }
  return commits;
}

export function githubUrl(remote: string, sha: string): string | undefined {
  const m = remote.trim().match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/commit/${sha}` : undefined;
}

export function commitToRecord(repo: string, c: Commit, remote: string): RecordInput {
  const name = path.basename(repo);
  const files = c.files.slice(0, 60);
  const body = [
    `Repo: ${repo}`,
    `Commit: ${c.sha}`,
    `Author: ${c.author}`,
    `Date: ${c.date}`,
    '',
    c.subject,
    c.body ? '\n' + c.body : '',
    '',
    `Files changed (${c.files.length}):`,
    ...files.map((f) => `- ${f}`),
    c.files.length > files.length ? `- … and ${c.files.length - files.length} more` : '',
  ]
    .filter((l) => l !== undefined)
    .join('\n')
    .trim();
  const url = githubUrl(remote, c.sha);
  return {
    id: `git-${name}-${c.sha.slice(0, 10)}`,
    source: 'git',
    title: `[${name}] ${c.subject}`,
    date: new Date(c.date).toISOString(),
    uri: url ?? `git:${repo}@${c.sha}`,
    body,
    meta: { repo, sha: c.sha, author: c.author, files: c.files.length, url },
    priority: 0,
  };
}

export const gitConnector: Connector = {
  name: 'git',
  describe: (cfg) =>
    cfg.connectors.git.repos.length ? `${cfg.connectors.git.repos.length} repo(s)` : 'no repos configured (connectors.git.repos)',
  enabled: (cfg) => cfg.connectors.git.enabled && cfg.connectors.git.repos.length > 0,
  async run(ctx: ConnectorContext): Promise<ConnectorResult> {
    const cfg = ctx.config.connectors.git;
    const state = ctx.brain.getState<State>('git', { repos: {} });
    let created = 0;
    let updated = 0;
    const notes: string[] = [];
    const problems: string[] = [];
    for (const raw of cfg.repos) {
      const repo = path.resolve(expandHome(raw));
      if (!fs.existsSync(repo)) {
        problems.push(`${raw}: not found`);
        continue;
      }
      const rs = state.repos[repo] ?? {};
      const args = ['log', '--all', '--no-merges', `--format=${RS}%H${US}%an${US}%aI${US}%s${US}%b${US}`, '--name-only'];
      if (rs.lastDate) {
        // Re-read a day of overlap; ids dedupe, so only truly new commits count.
        const since = new Date(new Date(rs.lastDate).getTime() - 86_400_000).toISOString();
        args.push(`--since=${since}`);
      } else args.push(`-n`, String(cfg.maxCommitsFirstRun));
      let out: string;
      try {
        out = git(repo, args);
      } catch (e) {
        problems.push(`${raw}: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
      let remote = '';
      try {
        remote = git(repo, ['config', '--get', 'remote.origin.url']);
      } catch {}
      const commits = parseGitLog(out);
      let repoNew = 0;
      ctx.brain.transaction(() => {
        for (const c of commits) {
          const res = ctx.brain.upsertRecord(commitToRecord(repo, c, remote));
          if (res === 'new') repoNew++;
          if (res === 'updated') updated++;
          if (!rs.lastDate || Date.parse(c.date) > Date.parse(rs.lastDate)) rs.lastDate = c.date;
        }
      });
      created += repoNew;
      state.repos[repo] = rs;
      notes.push(`${path.basename(repo)}: ${repoNew} new commit(s)`);
    }
    ctx.brain.setState('git', state);
    if (problems.length && problems.length === cfg.repos.length) throw new Error(problems.join('; '));
    return { new: created, updated, notes: [...notes, ...problems.map((p) => `problem: ${p}`)] };
  },
};
