// The "cheap model" that takes notes. Two backends:
//  - claude-cli: `claude -p --model haiku`, uses your existing Claude Code login (no API key).
//  - anthropic-api: the Anthropic SDK with ANTHROPIC_API_KEY, model claude-haiku-5-5.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { z } from 'zod';
import type { SummarizerConfig } from './config.ts';

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
        const child = spawn(claudePath, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
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

function safeJson(s: string): unknown {
  const m = s.match(/\{[\s\S]*\}/);
  try {
    return m ? JSON.parse(m[0]) : undefined;
  } catch {
    return undefined;
  }
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

export function pickLlm(cfg: SummarizerConfig): Llm | null {
  const backend = cfg.backend === 'auto' ? (process.env.ANTHROPIC_API_KEY ? 'anthropic-api' : 'claude-cli') : cfg.backend;
  if (backend === 'none') return null;
  if (backend === 'anthropic-api') return anthropicApi(cfg.apiModel);
  return claudeCli(cfg.cliModel, process.env.SECOND_BRAIN_CLAUDE || 'claude');
}
