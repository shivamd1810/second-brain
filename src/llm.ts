// The "cheap model" that takes notes. Three backends, so no single vendor login is required:
//  - claude-cli: `claude -p --model haiku`, uses your existing Claude Code login (no API key).
//  - anthropic-api: the Anthropic SDK with ANTHROPIC_API_KEY, model claude-haiku-5-5.
//  - command: any shell command that reads the prompt on stdin and prints JSON
//    (Gemini CLI, Codex, Ollama, llm, a script of your own…).
import { spawn } from 'node:child_process';
import os from 'node:os';
import { z } from 'zod';
import type { SummarizerConfig } from './config.ts';
import { onPath } from './util.ts';

export const NoteSchema = z.object({
  id: z.string(),
  summary: z.string(),
  question: z.string(),
  errors: z.array(z.string()),
  fixes: z.array(z.string()),
  commands: z.array(z.string()),
  decisions: z.array(z.object({ decision: z.string(), reason: z.string() })),
  keywords: z.array(z.string()),
});
export const NotesSchema = z.object({ notes: z.array(NoteSchema) });
export type Note = z.infer<typeof NoteSchema>;

export interface LlmResult {
  notes: Note[];
  costUsd: number;
  model: string;
}

export interface Llm {
  name: string;
  model: string;
  summarize(system: string, user: string): Promise<LlmResult>;
}

/** List prices per million tokens, prompts up to 100K tokens (Anthropic pricing, Oct 2026). */
const API_PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export function claudeCli(model: string, claudePath = 'claude'): Llm {
  // claude's --json-schema validator doesn't know the 2020-12 meta-schema id zod stamps on.
  const { $schema: _drop, ...jsonSchema } = z.toJSONSchema(NotesSchema) as Record<string, unknown>;
  const schema = JSON.stringify(jsonSchema);
  return {
    name: 'claude-cli',
    model,
    summarize(system, user) {
      const args = [
        '-p',
        '--model', model,
        '--effort', 'low',
        '--output-format', 'json',
        '--json-schema', schema,
        '--system-prompt', system,
        '--tools', '',            // no tools: it only reads the text we pipe in
        '--no-session-persistence', // don't write a transcript (it would get indexed)
        '--safe-mode',            // skip hooks, plugins, MCP servers, CLAUDE.md
        '--strict-mcp-config',
      ];
      return new Promise((resolve, reject) => {
        // Windows npm shims are .cmd files, which only start through a shell.
        const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudePath);
        const child = spawn(claudePath, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], shell });
        let out = '';
        let err = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(new Error(`could not run "${claudePath}": ${e.message}. Is Claude Code installed and logged in?`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          let res: Record<string, unknown>;
          try {
            res = JSON.parse(out);
          } catch {
            reject(new Error(`claude -p exited ${code}: ${(err || out).slice(0, 400)}`));
            return;
          }
          if (res.is_error) {
            reject(new Error(`claude -p error: ${String(res.result ?? res.subtype).slice(0, 400)}`));
            return;
          }
          const parsed = NotesSchema.safeParse(res.structured_output ?? safeJson(String(res.result ?? '')));
          if (!parsed.success) {
            reject(new Error(`model returned notes in the wrong shape: ${parsed.error.message.slice(0, 300)}`));
            return;
          }
          resolve({ notes: parsed.data.notes, costUsd: Number(res.total_cost_usd ?? 0), model: modelName(res, model) });
        });
        child.stdin.end(user);
      });
    },
  };
}

function modelName(res: Record<string, unknown>, fallback: string): string {
  const usage = res.modelUsage as Record<string, unknown> | undefined;
  return usage ? Object.keys(usage)[0] ?? fallback : fallback;
}

/** Pull the JSON out of a model's reply: tolerates ```json fences and text around it. */
export function safeJson(s: string): unknown {
  const text = s.replace(/```(?:json)?/gi, '');
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) return undefined;
  const start = Math.min(...starts);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// Weaker models drop empty fields or return a bare array; accept that.
const strs = z.array(z.string()).default([]);
const LenientNote = z.object({
  id: z.string(),
  summary: z.string().default(''),
  question: z.string().default(''),
  errors: strs,
  fixes: strs,
  commands: strs,
  decisions: z.array(z.object({ decision: z.string(), reason: z.string().default('') })).default([]),
  keywords: strs,
});
export const LenientNotes = z.union([
  z.object({ notes: z.array(LenientNote) }),
  z.array(LenientNote).transform((notes) => ({ notes })),
]);

export const JSON_INSTRUCTIONS = `Reply with ONLY one JSON object: no markdown fences, no text before or after. Shape:
{"notes":[{"id":"<the record id>","summary":"...","question":"...","errors":["..."],"fixes":["..."],"commands":["..."],"decisions":[{"decision":"...","reason":"..."}],"keywords":["..."]}]}`;

/**
 * Any command that reads a prompt on stdin and prints the model's reply on stdout.
 * Runs through your shell, e.g. `ollama run qwen2.5:7b` or `gemini -p "Answer now."`.
 */
export function commandLlm(command: string, label = command.split(/\s+/)[0] || 'command'): Llm {
  return {
    name: 'command',
    model: label,
    summarize(system, user) {
      const prompt = `${system}\n\n${JSON_INSTRUCTIONS}\n\nRecords:\n\n${user}`;
      return new Promise((resolve, reject) => {
        const child = spawn(command, { shell: true, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), 600_000);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(new Error(`could not run summarizer.command: ${e.message}`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          const parsed = LenientNotes.safeParse(safeJson(out));
          if (!parsed.success) {
            reject(new Error(`summarizer.command exited ${code} without valid JSON notes: ${(out || err).trim().slice(0, 300)}`));
            return;
          }
          resolve({ notes: parsed.data.notes, costUsd: 0, model: label });
        });
        child.stdin.on('error', () => {}); // the command may exit before reading everything
        child.stdin.end(prompt);
      });
    },
  };
}

export function anthropicApi(model: string): Llm {
  return {
    name: 'anthropic-api',
    model,
    async summarize(system, user) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
      const client = new Anthropic();
      const response = await client.messages.parse({
        model,
        max_tokens: 16000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'low', format: zodOutputFormat(NotesSchema) },
      });
      if (!response.parsed_output) throw new Error(`no parseable notes (stop_reason: ${response.stop_reason})`);
      const price = API_PRICES[model];
      const costUsd = price
        ? (response.usage.input_tokens * price.input + response.usage.output_tokens * price.output) / 1e6
        : 0;
      return { notes: response.parsed_output.notes, costUsd, model };
    },
  };
}

export type Backend = Exclude<SummarizerConfig['backend'], 'auto'>;

/** Which backend "auto" means on this machine, and why. */
export function resolveBackend(cfg: SummarizerConfig): { backend: Backend; why: string } {
  if (cfg.backend !== 'auto') return { backend: cfg.backend, why: 'set in config' };
  if (process.env.ANTHROPIC_API_KEY) return { backend: 'anthropic-api', why: 'ANTHROPIC_API_KEY is set' };
  if (process.env.SECOND_BRAIN_CLAUDE || onPath('claude')) return { backend: 'claude-cli', why: 'claude is installed' };
  if (cfg.command) return { backend: 'command', why: 'summarizer.command is set' };
  return { backend: 'none', why: 'no claude CLI, no ANTHROPIC_API_KEY and no summarizer.command; search uses raw text' };
}

export function pickLlm(cfg: SummarizerConfig): Llm | null {
  const { backend } = resolveBackend(cfg);
  if (backend === 'none') return null;
  if (backend === 'anthropic-api') return anthropicApi(cfg.apiModel);
  if (backend === 'command') {
    if (!cfg.command) throw new Error('summarizer.backend is "command" but summarizer.command is empty');
    return commandLlm(cfg.command);
  }
  return claudeCli(cfg.cliModel, process.env.SECOND_BRAIN_CLAUDE || onPath('claude') || 'claude');
}
