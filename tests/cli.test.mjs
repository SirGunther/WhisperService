import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeUserFiles, servicePaths } from '../src/config.mjs';
import { MODELS } from '../src/constants.mjs';
import { main, readyLine, usageText } from '../src/cli.mjs';

function withHome(root, run) {
  const original = process.env.WHISPER_SERVICE_HOME;
  process.env.WHISPER_SERVICE_HOME = root;
  return run().finally(() => {
    if (original === undefined) delete process.env.WHISPER_SERVICE_HOME;
    else process.env.WHISPER_SERVICE_HOME = original;
  });
}

function captureLogs() {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  return { lines, restore: () => { console.log = originalLog; console.error = originalError; } };
}

async function inHome(prefix, run) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const capture = captureLogs();
  try {
    await withHome(root, async () => {
      const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
      await initializeUserFiles(paths, { secureCredentials: false });
      process.exitCode = undefined;
      await run({ paths, lines: capture.lines });
    });
  } finally {
    capture.restore();
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  }
}

const refuseDownload = async () => { throw new Error('Downloading small.en failed with HTTP 503.'); };
const noDownload = async () => { throw new Error('must not download'); };

test('configure model leaves config.json byte-identical when the model cannot be installed', () => inHome('whisper-cli-model-missing-', async ({ paths }) => {
  const before = await readFile(paths.config, 'utf8');
  await assert.rejects(() => main(['configure', 'model', 'small.en'], { install: refuseDownload }), /HTTP 503/);
  assert.equal(await readFile(paths.config, 'utf8'), before);
}));

test('configure model rejects an unknown id, lists the valid ids, and downloads nothing', () => inHome('whisper-cli-model-unknown-', async () => {
  await assert.rejects(() => main(['configure', 'model', 'huge.en'], { install: noDownload }), /Valid ids: tiny\.en, base\.en, small\.en, medium\.en, large-v1, large-v2, large-v3, large-v3-turbo/);
}));

test('configure model switches without starting the service', () => inHome('whisper-cli-model-switch-', async ({ paths, lines }) => {
  await main(['configure', 'model', 'large-v3-turbo'], { install: async () => false });
  const saved = JSON.parse(await readFile(paths.config, 'utf8'));
  assert.equal(saved.runtime.modelSha256, MODELS['large-v3-turbo'].sha256);
  assert(lines.includes('Switched to large-v3-turbo. A plain npm start will keep using it.'));
  assert(lines.includes('Restart WhisperService to load it.'));
}));

test('serve with a model that cannot be installed fails before starting and keeps the configuration', () => inHome('whisper-cli-serve-fail-', async ({ paths }) => {
  const before = await readFile(paths.config, 'utf8');
  await assert.rejects(() => main(['serve', 'large-v3'], { install: async () => { throw new Error('Downloading large-v3 failed with HTTP 503.'); } }), /HTTP 503/);
  assert.equal(await readFile(paths.config, 'utf8'), before);
}));

test('serve with more than one argument prints usage and sets exit code 2 without starting', () => inHome('whisper-cli-serve-args-', async ({ lines }) => {
  await main(['serve', 'large-v3', 'small.en'], { install: noDownload });
  assert.equal(process.exitCode, 2);
  assert(lines.some((line) => line.includes('serve [model]')));
}));

test('the device command is gone: configure device prints usage and sets exit code 2', () => inHome('whisper-cli-device-gone-', async ({ paths }) => {
  const before = await readFile(paths.config, 'utf8');
  await main(['configure', 'device', 'gpu'], { install: noDownload });
  assert.equal(process.exitCode, 2);
  assert.equal(await readFile(paths.config, 'utf8'), before);
}));

test('usage shows serve [model], configure model and every model id, and no device setting', () => {
  const text = usageText();
  assert.match(text, /serve \[model\]/);
  assert.match(text, /configure model <model>/);
  assert.match(text, /Models: tiny\.en, base\.en, small\.en, medium\.en, large-v1, large-v2, large-v3, large-v3-turbo/);
  assert.doesNotMatch(text, /device/);
});

test('the ready line names the model and where it runs', () => {
  assert.equal(readyLine('large-v3-turbo', { device: 'gpu', deviceName: 'Vulkan0 NVIDIA GeForce GTX 1080 Ti' }), 'WhisperService is ready: large-v3-turbo on the GPU (Vulkan0 NVIDIA GeForce GTX 1080 Ti), at http://127.0.0.1:8178. Press Ctrl+C to stop.');
  assert.equal(readyLine('base.en', { device: 'cpu', deviceName: 'CPU' }), 'WhisperService is ready: base.en on the CPU, at http://127.0.0.1:8178. Press Ctrl+C to stop.');
  // A worker built before device reporting existed is CPU-only.
  assert.equal(readyLine('base.en', { model: 'ggml-base.en.bin' }), 'WhisperService is ready: base.en on the CPU, at http://127.0.0.1:8178. Press Ctrl+C to stop.');
});
