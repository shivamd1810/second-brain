// sync = run every enabled connector (only what's new since last run), then take notes on new records.
import type { Config } from './config.ts';
import { CONNECTORS } from './connectors/index.ts';
import type { Brain } from './db.ts';
import { summarizePending, type SummarizeResult } from './summarize.ts';

export interface ConnectorOutcome {
  name: string;
  status: 'ok' | 'error' | 'off';
  new: number;
  updated: number;
  notes: string[];
  error?: string;
  ms: number;
}

export async function runConnectors(
  brain: Brain,
  cfg: Config,
  opts: { only?: string[]; full?: boolean; log?: (m: string) => void } = {},
): Promise<ConnectorOutcome[]> {
  const log = opts.log ?? (() => {});
  const out: ConnectorOutcome[] = [];
  for (const c of CONNECTORS) {
    if (opts.only?.length && !opts.only.includes(c.name)) continue;
    // --full: forget where we stopped and re-read the source. Unchanged records keep their notes.
    // Gmail is skipped: its records never change, and a full re-fetch is slow.
    if (opts.full && c.name !== 'gmail') brain.setState(c.name, {});
    if (!c.enabled(cfg)) {
      out.push({ name: c.name, status: 'off', new: 0, updated: 0, notes: [c.describe(cfg)], ms: 0 });
      continue;
    }
    const started = Date.now();
    const runId = brain.startRun(c.name);
    try {
      const res = await c.run({ brain, config: cfg, log });
      brain.finishRun(runId, c.name, { status: 'ok', newCount: res.new, updatedCount: res.updated });
      out.push({ name: c.name, status: 'ok', new: res.new, updated: res.updated, notes: res.notes ?? [], ms: Date.now() - started });
    } catch (e) {
      const msg = (e as Error).message;
      brain.finishRun(runId, c.name, { status: 'error', error: msg });
      out.push({ name: c.name, status: 'error', new: 0, updated: 0, notes: [], error: msg, ms: Date.now() - started });
    }
  }
  return out;
}

export async function sync(
  brain: Brain,
  cfg: Config,
  opts: { only?: string[]; summarize?: boolean; limit?: number; log?: (m: string) => void } = {},
): Promise<{ connectors: ConnectorOutcome[]; summary: SummarizeResult | null }> {
  const connectors = await runConnectors(brain, cfg, opts);
  const summary = opts.summarize === false ? null : await summarizePending(brain, cfg.summarizer, { limit: opts.limit, log: opts.log });
  return { connectors, summary };
}
