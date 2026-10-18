import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { Brain } from '../src/db.ts';

export function tmpDir(prefix = 'sb-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(patch: (c: Config) => void = () => {}): Config {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.summarizer.backend = 'none';
  patch(cfg);
  return cfg;
}

export function memBrain(): Brain {
  return new Brain(':memory:');
}

export const user = (text: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890', cwd: '/work/demo-app', gitBranch: 'main', timestamp: ts, message: { role: 'user', content: text }, ...extra });

export const assistant = (blocks: unknown[], ts: string) =>
  JSON.stringify({ type: 'assistant', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890', cwd: '/work/demo-app', timestamp: ts, message: { role: 'assistant', content: blocks } });

export const toolResult = (content: string, ts: string, isError = false) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content, is_error: isError }] } });
