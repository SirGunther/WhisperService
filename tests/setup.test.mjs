import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_MODEL_ID, MODELS } from '../src/constants.mjs';
import { initializeUserFiles, loadConfig, saveConfig, servicePaths } from '../src/config.mjs';
import { parseModelArg, resolveModelId } from '../scripts/setup.mjs';

test('parseModelArg resolves a known id and rejects an unknown id or a missing value', () => {
  assert.equal(parseModelArg([]), undefined);
  assert.equal(parseModelArg(['--config-only']), undefined);
  assert.equal(parseModelArg(['--model', 'small.en']), 'small.en');
  assert.throws(() => parseModelArg(['--model', 'nope']), /--model requires one of/);
  assert.throws(() => parseModelArg(['--model']), /--model requires one of/);
});

test('resolveModelId prefers an explicit id without reading the configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-service-setup-explicit-'));
  try {
    const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
    await initializeUserFiles(paths, { secureCredentials: false });
    const before = await readFile(paths.config);
    assert.equal(await resolveModelId('small.en', paths), 'small.en');
    assert.deepEqual(await readFile(paths.config), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resolveModelId with no explicit id resolves base.en for a new temporary home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-service-setup-new-home-'));
  try {
    const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
    await initializeUserFiles(paths, { secureCredentials: false });
    assert.equal(await resolveModelId(undefined, paths), DEFAULT_MODEL_ID);
    assert.equal(DEFAULT_MODEL_ID, 'base.en');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resolveModelId with no explicit id resolves the configuration selecting small.en and leaves config.json byte-identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-service-setup-selected-'));
  try {
    const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
    await initializeUserFiles(paths, { secureCredentials: false });
    const config = await loadConfig(paths);
    config.runtime.modelPath = join(paths.models, MODELS['small.en'].file);
    config.runtime.modelSha256 = MODELS['small.en'].sha256;
    await saveConfig(config, paths);
    const before = await readFile(paths.config);
    assert.equal(await resolveModelId(undefined, paths), 'small.en');
    assert.deepEqual(await readFile(paths.config), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
