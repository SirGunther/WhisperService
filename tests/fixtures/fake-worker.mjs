import { createInterface } from 'node:readline';

const ready = Buffer.from(JSON.stringify({ protocolVersion: '1.0.0', model: 'ggml-base.en.bin', language: 'en' })).toString('base64url');
console.log(`READY ${ready}`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line === 'QUIT') process.exit(0);
  const [operation, id] = line.split(' ');
  if (operation !== 'TRANSCRIBE') {
    console.log(`ERROR ${id || 'unknown'} INVALID_REQUEST ${Buffer.from('bad command').toString('base64url')}`);
    continue;
  }
  const result = Buffer.from(JSON.stringify({ text: 'fake transcript', segments: [{ startMs: 0, endMs: 100, text: 'fake transcript' }] })).toString('base64url');
  console.log(`RESULT ${id} ${result}`);
}
