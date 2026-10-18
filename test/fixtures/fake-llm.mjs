// A stand-in "model" for the command backend: reads the prompt on stdin, answers like a
// sloppy small model would (markdown fence, chatter, missing fields).
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const ids = [...input.matchAll(/<record id="([^"]+)"/g)].map((m) => m[1]);
  const notes = ids.map((id) => ({ id, summary: `Local model note for ${id}`, question: 'how did we fix the flaky test?', fixes: ['pin the clock in tests'] }));
  process.stdout.write('Sure! Here are the notes:\n```json\n' + JSON.stringify({ notes }) + '\n```\n');
});
