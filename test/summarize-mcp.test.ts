import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Llm, Note } from '../src/llm.ts';
import { createServer } from '../src/mcp.ts';
import { search } from '../src/search.ts';
import { makeBatches, summarizePending } from '../src/summarize.ts';
import { memBrain, testConfig } from './helpers.ts';

function fakeLlm(opts: { skip?: string[]; cost?: number } = {}): Llm & { calls: number } {
  const llm = {
    name: 'fake',
    model: 'fake-haiku',
    calls: 0,
    async summarize(_system: string, user: string) {
      llm.calls++;
      const ids = [...user.matchAll(/<record id="([^"]+)"/g)].map((m) => m[1]).filter((id) => !opts.skip?.includes(id));
      const notes: Note[] = ids.map((id) => ({
        id,
        summary: `Summary of ${id}: moved the queue from RabbitMQ to SQS.`,
        question: 'why did we move off rabbitmq?',
        errors: ['AMQP connection reset'],
        fixes: ['retry with backoff'],
        commands: ['aws sqs create-queue'],
        decisions: [{ decision: 'Use SQS instead of RabbitMQ', reason: 'no broker to run' }],
        keywords: ['message queue', 'aws'],
      }));
      return { notes, costUsd: opts.cost ?? 0.001, model: 'fake-haiku' };
    },
  };
  return llm;
}

function seed(n: number) {
  const brain = memBrain();
  for (let i = 0; i < n; i++)
    brain.upsertRecord({ id: `r${i}`, source: 'notes', title: `Record ${i}`, date: new Date(Date.now() - i * 3_600_000).toISOString(), uri: `r${i}`, body: `body ${i}` });
  return brain;
}

test('summarizer writes notes, newest first, and is resumable', async () => {
  const brain = seed(5);
  const cfg = testConfig();
  const llm = fakeLlm({ skip: ['r1'] });
  const res = await summarizePending(brain, cfg.summarizer, { llm, limit: 3 });
  assert.equal(res.summarized, 2, 'r0 and r2 written');
  assert.equal(res.failed, 1, 'r1 missing from the model output stays pending');
  assert.equal(brain.pendingCount(), 3);
  assert.equal(brain.getRecord('r4')!.summary, null, 'outside the limit');

  // The note itself is searchable: words only in the question / facts find the record.
  const hits = search(brain, 'rabbitmq', cfg.search);
  assert.deepEqual(hits.map((h) => h.id).sort(), ['r0', 'r2']);
  assert.equal(search(brain, 'AMQP backoff', cfg.search).length, 2);

  const again = await summarizePending(brain, cfg.summarizer, { llm: fakeLlm(), limit: 10 });
  assert.equal(again.summarized, 3);
  assert.equal(brain.pendingCount(), 0);
});

test('summarizer stops at the cost cap', async () => {
  const brain = seed(30);
  const cfg = testConfig((c) => {
    c.summarizer.maxCostUsdPerRun = 0.05;
    c.summarizer.concurrency = 1;
  });
  const llm = fakeLlm({ cost: 0.05 });
  const res = await summarizePending(brain, cfg.summarizer, { llm, limit: 30 });
  assert.equal(llm.calls, 1);
  assert.equal(res.stoppedForCost, true);
  assert.equal(res.summarized, 10);
});

test('batches respect the character budget', () => {
  const brain = seed(25);
  const batches = makeBatches(brain.pending(25), 1000);
  assert.ok(batches.every((b) => b.length <= 10));
  assert.equal(batches.flat().length, 25);
});

test('MCP server: an agent can list tools, search and fetch a record', async () => {
  const brain = seed(3);
  const cfg = testConfig();
  await summarizePending(brain, cfg.summarizer, { llm: fakeLlm() });
  const server = createServer(brain, cfg);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientT);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['get_record', 'recent_memory', 'search_memory']);
  assert.match(client.getInstructions() ?? '', /personal memory/);

  const res = await client.callTool({ name: 'search_memory', arguments: { query: 'rabbitmq sqs', limit: 2 } });
  const text = (res.content as { type: string; text: string }[])[0].text;
  assert.match(text, /2 match\(es\)/);
  assert.match(text, /Decision: Use SQS instead of RabbitMQ — because no broker to run/);
  assert.match(text, /id: r0/, 'newest first');

  const rec0 = await client.callTool({ name: 'recent_memory', arguments: { days: 1 } });
  assert.match((rec0.content as { text: string }[])[0].text, /3 record\(s\)[\s\S]*1\. .*Record 0/);

  const rec = await client.callTool({ name: 'get_record', arguments: { id: 'r0' } });
  assert.match((rec.content as { text: string }[])[0].text, /--- original ---\nbody 0/);
  const missing = await client.callTool({ name: 'get_record', arguments: { id: 'nope' } });
  assert.equal(missing.isError, true);
  await client.close();
});
