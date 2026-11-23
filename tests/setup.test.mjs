import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_MODEL_ID, MODELS } from '../src/constants.mjs';
import { initializeUserFiles, loadConfig, saveConfig, servicePaths } from '../src/config.mjs';
import { cmakeConfigureArgs, parseModelArg, resolveModelId } from '../scripts/setup.mjs';

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

test('parseModelArg accepts every catalog model', () => {
  for (const id of Object.keys(MODELS)) assert.equal(parseModelArg(['--model', id]), id);
  assert.throws(() => parseModelArg(['--model', 'large-v3-q5_0']), /--model requires one of: tiny\.en, base\.en/);
});

test('cmakeConfigureArgs turns the Vulkan backend on only when the SDK is present and --cpu-only is absent', () => {
  const common = { sourceDir: 'C:\\src\\whisper.cpp', buildDir: 'C:\\build', nativeDir: 'C:\\repo\\native' };
  const gpu = cmakeConfigureArgs({ ...common, vulkanSdk: 'C:\\VulkanSDK\\1.4.363.0' });
  assert.equal(gpu.vulkan, true);
  assert.deepEqual(gpu.args, ['-S', 'C:\\repo\\native', '-B', 'C:\\build', '-DWHISPER_CPP_SOURCE_DIR=C:\\src\\whisper.cpp', '-DCMAKE_BUILD_TYPE=Release', '-DGGML_VULKAN=ON']);
  for (const options of [{ vulkanSdk: undefined }, { vulkanSdk: '' }, { vulkanSdk: 'C:\\VulkanSDK\\1.4.363.0', cpuOnly: true }]) {
    const cpu = cmakeConfigureArgs({ ...common, ...options });
    assert.equal(cpu.vulkan, false);
    assert.equal(cpu.args.at(-1), '-DGGML_VULKAN=OFF');
  }
});
