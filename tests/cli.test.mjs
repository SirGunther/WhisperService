import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeUserFiles, servicePaths } from '../src/config.mjs';
import { main } from '../src/cli.mjs';

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

test('configure model rejects an uninstalled model and leaves config.json byte-identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-cli-model-missing-'));
  try {
    await withHome(root, async () => {
      const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
      await initializeUserFiles(paths, { secureCredentials: false });
      const before = await readFile(paths.config, 'utf8');
      await assert.rejects(() => main(['configure', 'model', 'small.en']));
      const after = await readFile(paths.config, 'utf8');
      assert.equal(after, before);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configure model rejects an unknown id and lists the valid ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-cli-model-unknown-'));
  try {
    await withHome(root, async () => {
      const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
      await initializeUserFiles(paths, { secureCredentials: false });
      await assert.rejects(() => main(['configure', 'model', 'huge.en']), /Valid ids: tiny\.en, base\.en, small\.en, medium\.en, large-v1, large-v2, large-v3, large-v3-turbo/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configure model with no id prints usage including the new line and sets exit code 2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-cli-model-usage-'));
  const capture = captureLogs();
  try {
    await withHome(root, async () => {
      const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
      await initializeUserFiles(paths, { secureCredentials: false });
      process.exitCode = undefined;
      await main(['configure', 'model']);
      assert.equal(process.exitCode, 2);
      assert(capture.lines.some((line) => line.includes('configure model <tiny.en|base.en|small.en|medium.en|large-v1|large-v2|large-v3|large-v3-turbo>')));
      assert(capture.lines.some((line) => line.includes('configure device <auto|cpu|gpu>')));
    });
  } finally {
    capture.restore();
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

test('configure device saves each valid device and keeps the rest of the configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-cli-device-'));
  const capture = captureLogs();
  try {
    await withHome(root, async () => {
      const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
      await initializeUserFiles(paths, { secureCredentials: false });
      const before = JSON.parse(await readFile(paths.config, 'utf8'));
      for (const device of ['gpu', 'cpu', 'auto']) {
        await main(['configure', 'device', device]);
        const after = JSON.parse(await readFile(paths.config, 'utf8'));
        assert.equal(after.runtime.device, device);
        assert.deepEqual({ ...after, runtime: { ...after.runtime, device: before.runtime.device } }, before);
      }
      assert(capture.lines.some((line) => line.includes('Device set to gpu. Restart WhisperService to apply it.')));
    });
  } finally {
    capture.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('configure device rejects an unknown device and leaves config.json byte-identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-cli-device-bad-'));
  try {
    await withHome(root, async () => {
      const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
      await initializeUserFiles(paths, { secureCredentials: false });
      const before = await readFile(paths.config, 'utf8');
      await assert.rejects(() => main(['configure', 'device', 'cuda']), /runtime\.device must be one of: auto, cpu, gpu/);
      assert.equal(await readFile(paths.config, 'utf8'), before);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
