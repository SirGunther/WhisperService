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
      await assert.rejects(() => main(['configure', 'model', 'tiny.en']), /base\.en|small\.en/);
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
      assert(capture.lines.some((line) => line.includes('configure model <base.en|small.en>')));
    });
  } finally {
    capture.restore();
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  }
});
