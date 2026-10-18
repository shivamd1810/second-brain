# Setup prompt

Copy everything in the box below and paste it into your coding agent: Claude Code, Gemini CLI
or Codex. (With Claude Code the cheap note-taking model runs through your existing login; with
the others you pick a model in step 1.) The basic version (your Claude Code sessions + git history) takes about
five minutes. Gmail is an optional extra step at the end.

Before you paste: if you cloned a fork, change the `git clone` URL in step 2.

```text
Install "second-brain" for me: a local memory that indexes my Claude Code sessions and git
history into one SQLite file on my disk, and lets my coding agents search it over MCP.
Repo: https://github.com/OWNER/second-brain

Go step by step and show me the important output of each step. Never change a config file
outside ~/.second-brain without asking me first. Never enter passwords or tokens for me.

1. Check prerequisites and stop if one fails (tell me how to fix it):
   - `node --version` is 22.18 or newer
   - `git --version` works
   - A cheap model for the notes. Check `claude -p "reply with ok" --model haiku` prints ok
     (uses my Claude Code login). If I don't use Claude Code: tell me the other options from the
     README's "The notes" section (ANTHROPIC_API_KEY, or summarizer.backend = "command" with my
     own CLI such as Gemini CLI, Codex or Ollama) and set the one I pick in
     ~/.second-brain/config.json after step 3. Without any model, search still works on raw text.

2. Clone and install (skip the clone if ~/second-brain already exists):
   git clone https://github.com/OWNER/second-brain ~/second-brain
   cd ~/second-brain && npm install

3. Find my git repos: look for folders that contain a .git directory, at most 3 levels deep,
   under whichever of these exist: ~/code ~/projects ~/workspace ~/dev ~/src ~/Developer ~/GitHub.
   Show me the list. Then run, from ~/second-brain:
   node src/cli.ts init --scan <each folder that had repos>
   (use --git <path> for any single repo I name, and --no-subagents if I say so)

4. First sync:
   node src/cli.ts sync --limit 25
   It indexes all my sessions and commits locally (seconds), then Claude Haiku writes notes for
   the 25 newest records (one to two minutes). Show me the "N new since last run" lines.

5. Try a search. Pick a project name from the sync output and run:
   node src/cli.ts search <project name> <a topic from that project>
   Show me the top 3 results.

6. Connect my agents. Run `node src/cli.ts mcp-config`. It prints one line per agent.
   For each agent CLI I actually have installed (check `claude`, `gemini`, `codex`), show me its
   line and ask me before running it. After adding, `claude mcp list` (or `gemini mcp list`)
   should show second-brain as connected.

7. Tell me how to use it: in any connected agent, ask a question about my past work, for
   example "what did we decide about X last week?". The agent calls search_memory.

8. Offer these extras, one by one. Do each only if I say yes:
   a. Keep my Claude Code sessions: Claude Code deletes them after 30 days. Set
      "cleanupPeriodDays": 3650 in ~/.claude/settings.json (merge, don't overwrite the file).
   b. Keep it fresh automatically, every 15 minutes: on macOS or Linux,
      `node src/cli.ts schedule install` (launchd job / one crontab line; notifies me if a source
      breaks). On Windows, show me the command from `node src/cli.ts schedule print` and the
      README's Windows steps. Anywhere: `node src/cli.ts sync --watch` in a spare terminal.
   c. Notes for everything else: `node src/cli.ts summarize --limit 500`. It uses my Claude
      plan's usage (about $0.0015 per record at API list prices) and can be stopped and resumed.
   d. Gmail (read-only, about 10 more minutes, needs a Google Cloud OAuth client):
      walk me through the "Gmail (optional)" section of ~/second-brain/README.md.
      I will do the Google sign-in myself.

Finish with `node src/cli.ts doctor` and show me the result.
```

## What the prompt does, in order

| Step | Command | Time (measured on a Mac, Oct 2026) |
|------|---------|------------------------------------|
| 2 | `git clone` + `npm install` | a few seconds (longer on a cold npm cache) |
| 3 | `init --scan <your code folder>` | 1 s |
| 4 | `sync --limit 25` (~1,000 transcript files indexed in seconds, then 25 notes) | ~85 s |
| 6 | `claude mcp add …` | seconds |
| 7 | first question in Claude Code | 10–20 s |

See README → "Setup time" for the full measured run including the agent's own thinking time.
