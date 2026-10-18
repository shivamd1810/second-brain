# second-brain

One local memory for every coding agent.

`second-brain` pulls your own data (Claude Code sessions, git history, notes, and optionally
Gmail) into **one SQLite file on your disk**. A cheap model writes a short note for every item.
**One MCP server** lets Claude Code, Gemini CLI and Codex all search the same memory.

You never write notes. It just remembers. And because the memory is a file you own, you can
switch tools whenever you like and your agent still knows everything.

- **No RAG.** No embeddings, no vector database, no chunk-tuning. Plain-text BM25 search.
- **Only new data.** Each connector remembers where it stopped and pulls only what's new.
- **Dated.** Every record has a date, and newer records get a small boost.
- **Health check.** If a source stops bringing in data, you hear about it.
- **Small.** TypeScript run directly by Node, three dependencies, one `.db` file.

The core approach comes from Nick Saraev's video on personal knowledge bases. This repo adds
the part that makes it work across every agent you use.

## Why no RAG

Most "second brain" tutorials build RAG: embed everything, store vectors, retrieve the nearest
chunks. It is a lot of moving parts, and it is hard to see why a result came back.

Pasting everything into the model doesn't work either. The model can't tell an old decision
from a new one, it gets worse at finding one detail the more text you give it, and it costs
more on every question.

This repo does the boring thing that works:

1. A cheap model turns each long, messy item into a short note: a summary, **the question you'd
   probably type to find it later**, and the hard facts (exact error messages, the fix that
   worked, commands that ran, every decision and the reason for it).
2. SQLite's built-in FTS5 index ranks notes with **BM25**, the classic keyword-ranking formula
   from the 1990s. The agent picks a few search words, gets the best few notes back in
   milliseconds, and follows the link to the full original when it needs more.
3. A small **recency boost** makes newer records win when two match equally well.

Claude Code itself works this way: it searches your code with plain text tools like grep
rather than an embeddings index.

## How it works

```
  SOURCES                     CONNECTORS (only what's new)      NOTES (cheap model)
  ~/.claude/projects/*.jsonl ─► claude-sessions  ─┐
  git repos                  ─► git              ─┼─► records ──► Claude Haiku writes:
  ~/notes/*.md               ─► notes            ─┤   (dated,      summary · question you'd type ·
  Gmail (read-only)          ─► gmail            ─┘   linked to    errors · fixes · commands ·
                                                      original)    decisions + why · keywords
                                                          │
                                                          ▼
                              ~/.second-brain/brain.db   (one SQLite file)
                              FTS5 index · bm25() × recency boost
                                                          │
                                                          ▼
                              MCP server (stdio): search_memory · recent_memory · get_record
                                     │                  │                 │
                                Claude Code         Gemini CLI          Codex
```

Everything runs on your machine except the note-taking calls, which go to Anthropic
(see [Privacy](#privacy)).

## Quick start (about 5 minutes)

The fastest way: paste [SETUP_PROMPT.md](SETUP_PROMPT.md) into Claude Code and let it do the
steps below with you. Or do them by hand.

You need **Node 22.18+**, **git**, and **Claude Code** (logged in). The notes are written with
`claude -p --model haiku`, which uses your existing Claude Code login. No API key needed.

```bash
git clone https://github.com/OWNER/second-brain ~/second-brain
cd ~/second-brain && npm install

# Point it at your repos (scan a folder, or list repos with --git)
node src/cli.ts init --scan ~/code

# Index everything, write notes for the 25 newest records
node src/cli.ts sync --limit 25

# Search
node src/cli.ts search "postgres migration"
```

Optional: `npm link` gives you a `second-brain` command, so `second-brain sync` works from
anywhere. The rest of this README uses that name.

## Connect your agents

One line each. `second-brain mcp-config` prints these with your real paths filled in.

**Claude Code**

```bash
claude mcp add second-brain --scope user -- node ~/second-brain/src/mcp.ts
```

**Gemini CLI**

```bash
gemini mcp add --scope user second-brain node ~/second-brain/src/mcp.ts
```

or in `~/.gemini/settings.json`:

```json
{ "mcpServers": { "second-brain": { "command": "node", "args": ["/Users/you/second-brain/src/mcp.ts"] } } }
```

**Codex**

```bash
codex mcp add second-brain -- node ~/second-brain/src/mcp.ts
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.second-brain]
command = "node"
args = ["/Users/you/second-brain/src/mcp.ts"]
```

Use absolute paths in JSON/TOML files (`~` is not expanded there). Then ask any of them about
your past work: *"Why did we switch the queue to SQS?"* The agent calls `search_memory`, answers
from the best matches, and tells you which record (date + source) the answer came from.

### The tools

| Tool | What it does |
|------|--------------|
| `search_memory(query, limit?, source?, since?)` | BM25 × recency search over the notes. Returns ranked results with id, date, the question, summary, decisions, fixes and a link to the original. |
| `recent_memory(days?, limit?, source?)` | Newest records, no keywords. For "what was I doing last week?". |
| `get_record(id, max_chars?)` | One record: its note plus the full original text. |

The server is read-only. If a connector has gone stale, search results end with a warning so
the agent can tell you.

## Commands

```
second-brain init [--git <repo>…] [--scan <dir>] [--notes <dir>…] [--no-subagents] [--gmail]
second-brain sync [--limit N] [--no-summarize] [--only claude-sessions,git] [--full] [--notify] [--quiet]
second-brain summarize [--limit N] [--ids a,b]   # notes for records still waiting; safe to stop and resume
second-brain search <words…> [--limit N] [--source S] [--since 2026-09-01] [--explain] [--json]
second-brain recent [--days 7] [--source S]
second-brain show <id>                   # note + full original
second-brain doctor                      # health check
second-brain stats
second-brain mcp                         # run the MCP server (what agents start)
second-brain mcp-config                  # print the registration lines
second-brain gmail-auth                  # one-time Google consent (read-only)
second-brain schedule install|uninstall|status|print [--every 15]
```

Data lives in `~/.second-brain` (override with `SECOND_BRAIN_HOME`): `config.json`, `brain.db`,
`gmail/`, `logs/`. See [config.example.json](config.example.json) for every setting.

## Connectors

Every connector is one small file in [src/connectors](src/connectors). Each run pulls only what
changed since the last run, stamps each record with the date it happened, and keeps a link back
to the original. All access is read-only.

**claude-sessions** reads `~/.claude/projects/**/*.jsonl`. It remembers a byte offset per file,
so a second run reads only the lines appended since. It keeps your prompts, Claude's replies,
the shell commands it ran, and tool errors. It drops tool output, file snapshots, attachments
and thinking. Long sessions are cut into parts of about 6,000–12,000 characters at prompt
boundaries. The newest part of a session you're still in is indexed once the file has been
quiet for 20 minutes. Subagent transcripts are included (`--no-subagents` to skip them).

> Claude Code deletes transcripts after 30 days by default. To keep them, set
> `"cleanupPeriodDays": 3650` in `~/.claude/settings.json`.

**git** runs `git log --all --no-merges` per repo in `connectors.git.repos`: message, author,
date, files touched. The first run takes the newest 500 commits per repo; after that, only
commits newer than the last one seen. Links point to GitHub when the remote is on GitHub.

**notes** indexes `.md`, `.markdown` and `.txt` files under `connectors.notes.dirs`. A file is
re-read only when its size or modification time changes.

**gmail** (optional) uses the Gmail API with the `gmail.readonly` scope only. See below.

## How ranking works

```
relevance = -bm25(notes_fts, 3.0, 4.0, 2.0, 2.0, 0.25)    -- title, question, summary, facts, raw text
recency   = 1 + 0.5 × 0.5 ^ (age_in_days / 30)
score     = relevance × recency
```

A record from today gets ×1.5, one from a month ago ×1.25, one from three months ago ×1.06. So
newer wins ties and older slowly fades, but a much better text match still beats a newer weak
one. The note fields carry most of the weight; the raw text is a low-weight fallback, which
also makes records searchable before their note is written. Tune `search.recencyBoost` and
`search.halfLifeDays` in the config. Your words are OR'ed together (BM25 rewards records that
match more of them), stemmed (`switching` finds `switched`), and `"quoted phrases"` stay phrases.

You can run the same query yourself:

```bash
sqlite3 ~/.second-brain/brain.db "
  SELECT date(r.date), round(-bm25(notes_fts, 3, 4, 2, 2, 0.25), 2) AS bm25, r.title
  FROM notes_fts JOIN records r ON r.rid = notes_fts.rowid
  WHERE notes_fts MATCH 'postgres OR migration'
  ORDER BY bm25(notes_fts, 3, 4, 2, 2, 0.25) LIMIT 5;"
```

## The notes (summarizer)

For each new record, Claude Haiku returns JSON with `summary`, `question`, `errors`, `fixes`,
`commands`, `decisions` (each with a `reason`) and `keywords`. Records are batched (up to 10
per call, about 40,000 characters), run 3 calls at a time, and each note is saved as soon as
it arrives, so a stopped run picks up where it left off.

| Backend | When | Model |
|---------|------|-------|
| `claude-cli` (default) | `claude` is installed and logged in | `claude -p --model haiku` with no tools, no session saved, hooks/plugins/MCP off |
| `anthropic-api` | `ANTHROPIC_API_KEY` is set (or `summarizer.backend = "anthropic-api"`) | `claude-haiku-5-5` via the Anthropic SDK |
| `none` | `summarizer.backend = "none"` | no notes; search uses the raw text |

Caps: `summarizer.maxRecordsPerRun` (200) and `summarizer.maxCostUsdPerRun` ($1.00) per sync.

**Cost.** Measured on real sessions: about **$0.0015 per record** at API list prices
(50 records ≈ $0.075). A first full pass over ~1,450 records is about $2. With the default
`claude-cli` backend this comes out of your Claude plan's usage instead of an API bill.

## Keep it alive

A second brain with stale data quietly gives wrong answers. `second-brain doctor` shows, per
connector, the last successful sync, how many new records the last run brought, and:

- **STALE** (loud): no successful sync for `health.staleHours` (6). Expired token, changed
  password, moved folder.
- **ERROR**: the last run failed.
- **QUIET**: running fine but nothing new for `health.quietHours[connector]` hours
  (claude-sessions 72, gmail 48; 0 turns it off).

Run it on a schedule (macOS):

```bash
second-brain schedule install      # launchd, every 15 minutes, logs in ~/.second-brain/logs
second-brain schedule uninstall
```

Each scheduled sync runs the health check and shows a macOS notification if a connector is
STALE or failing, so you hear about it the same day. On Linux, `second-brain schedule print`
gives you a cron line.

## Gmail (optional)

Takes about 10 minutes, mostly in Google Cloud Console. You do the Google sign-in yourself;
nothing here asks for your password.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick one).
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen**: user type *External*, fill in the app name and
   your email, and add yourself under *Test users*. You don't need to publish the app.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type
   **Desktop app**. Download the JSON.
5. Save it as `~/.second-brain/gmail/credentials.json`.
6. Run `second-brain gmail-auth`. Your browser opens; approve **read-only** access. A token is
   saved to `~/.second-brain/gmail/token.json` (only you can read it).
7. Turn the connector on: `second-brain init --gmail` (or set `connectors.gmail.enabled`), then
   `second-brain sync`.

The first run pulls the last `firstRunDays` (90) days, up to `maxMessagesPerRun` (300) per run,
oldest first, so later runs continue where it stopped. After that it asks Gmail only for
messages newer than the newest one already indexed. Promotions, social, spam and trash are
skipped (`connectors.gmail.query`). Quoted replies are stripped so each record is what was new
in that email. If the token expires or you revoke access, `doctor` shows gmail as STALE; run
`second-brain gmail-auth` again.

## Privacy

- Your data stays in `~/.second-brain` on your machine: never inside this repo, never uploaded
  anywhere by this code. The `.gitignore` also blocks `*.db`, `credentials.json` and `token.json`.
- **Writing notes sends each record's text to Anthropic** through your own Claude account
  (`claude -p`) or your API key. That includes session transcripts, commit messages and, if you
  turn it on, email bodies. If that's not OK for some data, exclude it (`connectors["claude-sessions"].exclude`
  takes path substrings), or set `summarizer.backend` to `"none"`.
- All connectors are read-only. Gmail uses the `gmail.readonly` scope and refuses a token with
  any other scope.
- The note-taking model runs with no tools, and its prompt treats record text as data, so text
  inside an old session or email can't make it do anything. The worst it can do is write a bad
  note.
- The MCP server only reads. It runs locally over stdio; nothing listens on a port.

## Setup time

Measured on a MacBook (Node 26, Claude Code 2.1.302) with a fresh clone and an empty data dir,
following [SETUP_PROMPT.md](SETUP_PROMPT.md) step by step with an agent driving: **116 seconds**
from the prerequisite check to the first answer from memory in Claude Code. That run indexed
1,456 records (1,378 session parts from 1,079 transcript files, 78 commits from 9 repos) in about
5 seconds, and writing the first 25 notes took about 80 seconds. A first-time viewer whose
agent stops to ask before each config change should expect 3–5 minutes. Gmail adds about 10.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `could not run "claude"` | Install Claude Code and log in, or set `ANTHROPIC_API_KEY`, or `summarizer.backend = "none"`. Under launchd/cron, `schedule install` already puts `claude` on the PATH; set `SECOND_BRAIN_CLAUDE=/path/to/claude` if yours lives elsewhere. |
| `no such module: fts5` or `node:sqlite` errors | Use Node 22.18 or newer (`node --version`). |
| Agent doesn't see the server | `claude mcp list` / `gemini mcp list`. Use absolute paths. Run `node ~/second-brain/src/mcp.ts` yourself: it should print `second-brain MCP server ready (stdio)` and wait. `npm run smoke -- your words` runs a real stdio client against it. |
| Search finds nothing | Use fewer, more specific words: a project name, a tool, an exact error. `second-brain stats` shows what's indexed. |
| My current session isn't searchable yet | The newest part of an active session is indexed after 20 quiet minutes (`connectors["claude-sessions"].idleMinutes`). |
| Notes stop at the cap | `second-brain summarize --limit 500`, or raise `summarizer.maxCostUsdPerRun`. |
| Gmail STALE | `second-brain gmail-auth` again. If it says the client is invalid, re-download `credentials.json`. |
| Changed a setting that affects parsing (e.g. `exclude`) | `second-brain sync --full` re-reads every source; records whose text didn't change keep their notes. |
| Start over | Delete `~/.second-brain/brain.db*` and run `second-brain sync`. Config and Gmail token are kept. |

## Development

```bash
npm test            # node:test, no network, fake model
npm run typecheck   # tsc --noEmit
npm run smoke -- "some words"   # real stdio MCP client against your brain
```

Node runs the `.ts` files directly (type stripping), so there is no build step.

## License

Not chosen yet.
