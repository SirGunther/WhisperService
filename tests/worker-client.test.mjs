import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WorkerClient, workerExitMessage } from '../src/worker-client.mjs';

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

test('the native worker is started with the configured device, defaulting to auto', () => {
  const options = { workerPath: 'worker.exe', modelPath: 'model.bin', modelSha256: '0'.repeat(64), startupMs: 1_000 };
  assert.deepEqual(new WorkerClient(options).args, ['--model', 'model.bin', '--device', 'auto']);
  assert.deepEqual(new WorkerClient({ ...options, device: 'gpu' }).args, ['--model', 'model.bin', '--device', 'gpu']);
  assert.deepEqual(new WorkerClient({ ...options, device: 'cpu' }).args, ['--model', 'model.bin', '--device', 'cpu']);
});

test('a worker that exits with code 4 before READY fails startup with an explicit no-GPU message', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url));
  const worker = new WorkerClient({ command: process.execPath, args: [fixture, '--exit-code', '4'], workerPath: 'unused', modelPath: 'unused', modelSha256: '0'.repeat(64), startupMs: 2_000 });
  await assert.rejects(() => worker.start({ verifyAssets: false }), (error) => error.code === 'WORKER_FAILURE' && /No GPU device is available/.test(error.message) && /configure -- device/.test(error.message));
  assert.equal(worker.ready, false);
});

test('worker exit messages explain startup codes and stay generic after READY', () => {
  assert.match(workerExitMessage(3, null), /could not load the model on the selected device/);
  assert.match(workerExitMessage(2, null), /rejected its arguments/);
  assert.equal(workerExitMessage(4, null, { ready: true }), 'Native worker exited with code 4.');
  assert.equal(workerExitMessage(9, null), 'Native worker exited with code 9.');
  assert.equal(workerExitMessage(null, 'SIGTERM'), 'Native worker exited with signal SIGTERM.');
});
