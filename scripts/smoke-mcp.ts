// Smoke test: start the real MCP server over stdio (exactly how an agent does) and query your brain.
//   node scripts/smoke-mcp.ts "your search words"
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const query = process.argv.slice(2).join(' ') || 'error fix';
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, '..', 'src', 'mcp.ts')],
  env: { ...process.env } as Record<string, string>,
  stderr: 'ignore',
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
const t0 = performance.now();
await client.connect(transport);
const tools = await client.listTools();
console.log(`connected in ${(performance.now() - t0).toFixed(0)} ms · tools: ${tools.tools.map((t) => t.name).join(', ')}`);
const t1 = performance.now();
const res = await client.callTool({ name: 'search_memory', arguments: { query, limit: 3 } });
const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
console.log(`search_memory("${query}") answered in ${(performance.now() - t1).toFixed(0)} ms\n`);
console.log(text);
await client.close();
if (!text || res.isError) process.exit(1);
