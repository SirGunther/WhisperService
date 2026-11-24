import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeTonePcm } from '../src/audio.mjs';
import { MODELS } from '../src/constants.mjs';
import { WorkerClient } from '../src/worker-client.mjs';
import { CLIP_MS, buildClip, buildMatrix, formatTable, installedModels, parseArgs, runRow, verdict, wordErrorRate } from '../scripts/smoke-models.mjs';

const fakeWorker = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url));

test('parseArgs reads models, devices, worker, runs, json, a WAV path and expected text', () => {
  const options = parseArgs(['--models', 'medium.en,large-v3-turbo', '--devices', 'cpu,gpu', '--runs', '5', '--json', 'clip.wav', '--expect', 'hello there']);
  assert.deepEqual(options.models, ['medium.en', 'large-v3-turbo']);
  assert.deepEqual(options.devices, ['cpu', 'gpu']);
  assert.equal(options.runs, 5);
  assert.equal(options.json, true);
  assert.match(options.wav, /clip\.wav$/);
  assert.equal(options.expect, 'hello there');
  assert.deepEqual(parseArgs([]), { models: null, devices: null, worker: null, runs: 3, json: false, wav: null, expect: null });
});

test('parseArgs rejects unknown models, unknown devices, bad run counts, missing values and stray flags', () => {
  assert.throws(() => parseArgs(['--models', 'large-v4']), /Unknown model large-v4/);
  assert.throws(() => parseArgs(['--devices', 'cuda']), /Unknown device cuda/);
  assert.throws(() => parseArgs(['--runs', '0']), /--runs must be an integer from 1 to 20/);
  assert.throws(() => parseArgs(['--runs', '2.5']), /--runs/);
  assert.throws(() => parseArgs(['--models']), /--models requires a value/);
  assert.throws(() => parseArgs(['--models', '--json']), /--models requires a value/);
  assert.throws(() => parseArgs(['--fast']), /Unknown argument --fast/);
});

test('the default matrix runs every installed model once on auto, in catalog order, so it works on a machine without a GPU', () => {
  assert.deepEqual(buildMatrix({ models: null, devices: null, installed: ['large-v3', 'base.en', 'tiny.en'] }), [
    { model: 'tiny.en', device: 'auto' },
    { model: 'base.en', device: 'auto' },
    { model: 'large-v3', device: 'auto' }
  ]);
  assert.deepEqual(buildMatrix({ models: null, devices: null, installed: [] }), []);
});

test('explicit models and devices replace the default matrix', () => {
  assert.deepEqual(buildMatrix({ models: ['large-v3-turbo', 'small.en'], devices: ['cpu', 'gpu'], installed: [] }), [
    { model: 'small.en', device: 'cpu' },
    { model: 'small.en', device: 'gpu' },
    { model: 'large-v3-turbo', device: 'cpu' },
    { model: 'large-v3-turbo', device: 'gpu' }
  ]);
  assert.deepEqual(buildMatrix({ models: ['medium.en'], devices: null, installed: ['base.en'] }), [{ model: 'medium.en', device: 'auto' }]);
  assert.deepEqual(buildMatrix({ models: null, devices: ['cpu'], installed: ['base.en', 'small.en'] }), [
    { model: 'base.en', device: 'cpu' },
    { model: 'small.en', device: 'cpu' }
  ]);
});

test('wordErrorRate ignores case and punctuation and counts substitutions, insertions and deletions', () => {
  const reference = 'The quick brown fox jumps over the lazy dog.';
  assert.equal(wordErrorRate(reference, ' the QUICK brown fox, jumps over the lazy dog'), 0);
  assert.equal(wordErrorRate(reference, 'The quick brown fox jumped over the lazy dog.'), 1 / 9);
  assert.equal(wordErrorRate(reference, 'The quick fox jumps over the lazy dog.'), 1 / 9);
  assert.equal(wordErrorRate(reference, 'The quick brown fox jumps over the very lazy dog.'), 1 / 9);
  assert.equal(wordErrorRate(reference, ''), 1);
  assert.equal(wordErrorRate('', ''), 0);
});

test('verdict keeps up at 2,000 ms, is tight up to SaySlate\'s 4,000 ms Stop window, and too slow beyond it', () => {
  assert.equal(verdict(350), 'keeps up');
  assert.equal(verdict(2_000), 'keeps up');
  assert.equal(verdict(2_001), 'tight');
  assert.equal(verdict(4_000), 'tight');
  assert.equal(verdict(4_001), 'too slow');
});

test('buildClip pads a short recording with silence to exactly one full utterance and never repeats or cuts speech', () => {
  const fullBytes = (CLIP_MS / 1_000) * 32_000;
  const speech = makeTonePcm(7_500);
  const clip = buildClip(speech);
  assert.equal(clip.length, fullBytes);
  assert.deepEqual(clip.subarray(0, speech.length), speech);
  assert(clip.subarray(speech.length).every((byte) => byte === 0));
  const long = makeTonePcm(12_000);
  assert.equal(buildClip(long), long);
});

test('runRow reports a missing model and a hash mismatch as failed rows without starting a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-smoke-models-'));
  try {
    const modelsDir = join(root, 'models');
    await mkdir(modelsDir, { recursive: true });
    let started = 0;
    const createWorker = () => { started += 1; throw new Error('must not start'); };
    const missing = await runRow({ model: 'medium.en', device: 'gpu' }, { modelsDir, workerPath: 'unused', clipPath: 'unused', clipMs: 10_000, runs: 1, expected: null, createWorker });
    assert.equal(missing.status, 'failed');
    assert.equal(missing.reason, 'not installed: npm run setup -- --model medium.en --skip-build');

    await writeFile(join(modelsDir, MODELS['tiny.en'].file), 'not the real model');
    const corrupt = await runRow({ model: 'tiny.en', device: 'gpu' }, { modelsDir, workerPath: 'unused', clipPath: 'unused', clipMs: 10_000, runs: 1, expected: null, createWorker });
    assert.equal(corrupt.status, 'failed');
    assert.match(corrupt.reason, /does not match its pinned SHA-256/);
    assert.equal(started, 0);
    assert.deepEqual(await installedModels(modelsDir), ['tiny.en']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runRow times a working worker, and a failing worker becomes a failed row instead of stopping the run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-smoke-models-run-'));
  try {
    const modelsDir = join(root, 'models');
    await mkdir(modelsDir, { recursive: true });
    await writeFile(join(modelsDir, MODELS['base.en'].file), 'stand-in bytes');
    const hashFile = async () => MODELS['base.en'].sha256;
    const fake = (extra = []) => (options) => new WorkerClient({ ...options, command: process.execPath, args: [fakeWorker, ...extra], startupMs: 2_000 });
    const context = { modelsDir, workerPath: 'unused', clipPath: 'unused.wav', clipMs: 10_000, runs: 2, expected: 'fake transcript', hashFile };

    const ok = await runRow({ model: 'base.en', device: 'cpu' }, { ...context, createWorker: fake() });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.ranOn, 'unknown');
    assert.equal(ok.wer, 0);
    assert.equal(ok.text, 'fake transcript');
    assert.equal(ok.verdict, 'keeps up');
    assert(Number.isInteger(ok.loadMs) && Number.isInteger(ok.firstMs) && Number.isInteger(ok.medianMs));
    assert.equal(ok.stateMs, null);

    const failed = await runRow({ model: 'base.en', device: 'gpu' }, { ...context, createWorker: fake(['--exit-code', '4']) });
    assert.equal(failed.status, 'failed');
    assert.match(failed.reason, /No GPU device is available/);

    const table = formatTable([ok, failed]);
    assert.match(table, /\| base\.en \| cpu \| unknown \|/);
    assert.match(table, /failed: No GPU device is available/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
