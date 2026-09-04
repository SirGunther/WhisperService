import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WorkerClient } from '../src/worker-client.mjs';

test('worker protocol loads once and returns a versioned structured result', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url));
  const worker = new WorkerClient({ command: process.execPath, args: [fixture], workerPath: 'unused', modelPath: 'unused', modelSha256: '0'.repeat(64), startupMs: 2_000 });
  let readyCount = 0;
  worker.on('ready', () => { readyCount += 1; });
  await worker.start({ verifyAssets: false });
  assert.equal((await worker.transcribe('ignored.wav')).text, 'fake transcript');
  assert.equal((await worker.transcribe('ignored-again.wav')).text, 'fake transcript');
  assert.equal(readyCount, 1);
  await worker.close();
});
