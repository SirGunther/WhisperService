import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MODELS } from '../src/constants.mjs';
import { createLogger } from '../src/logger.mjs';
import { defaultConfig, deviceForConfig, initializeUserFiles, loadToken, modelIdForConfig, parseExactOrigin, rotateToken, selectModel, servicePaths, tokenMatches, validateConfig } from '../src/config.mjs';

test('default configuration preserves the approved bounds', () => {
  const paths = servicePaths({ WHISPER_SERVICE_HOME: join(tmpdir(), 'whisper-config') });
  const config = validateConfig(defaultConfig(paths));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8178);
  assert.equal(config.speech.minSpeechMs, 160);
  assert.equal(config.speech.pauseMs, 1200);
  assert.equal(config.speech.speechRms, 0.0125);
  assert.equal(config.speech.silenceRms, 0.008);
  assert.equal(config.speech.previewMs, 2000);
  assert.equal(config.limits.maxActiveSessions, 4);
  assert.equal(config.limits.maxUtteranceMs, 10000);
});

test('configuration rejects unsafe origins and out-of-range previews', () => {
  assert.equal(parseExactOrigin('chrome-extension://abcdefghijklmnop'), 'chrome-extension://abcdefghijklmnop');
  assert.equal(parseExactOrigin('http://localhost:3000'), 'http://localhost:3000');
  for (const origin of ['*', 'https://example.com/', 'https://example.com/path', 'file:///tmp/index.html']) {
    assert.throws(() => parseExactOrigin(origin));
  }
  const config = defaultConfig(servicePaths({ WHISPER_SERVICE_HOME: join(tmpdir(), 'whisper-config') }));
  config.speech.previewMs = 1499;
  assert.throws(() => validateConfig(config), /1500/);
});

test('setup is idempotent and token rotation changes the credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-service-config-'));
  const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
  try {
    await initializeUserFiles(paths, { secureCredentials: false });
    const first = await loadToken(paths);
    await initializeUserFiles(paths, { secureCredentials: false });
    assert.equal(await loadToken(paths), first);
    const second = await rotateToken(paths, { secureCredentials: false });
    assert.notEqual(second, first);
    assert(tokenMatches(second, await loadToken(paths)));
    const credentials = JSON.parse(await readFile(paths.credentials, 'utf8'));
    assert.equal(credentials.token, second);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('validateConfig accepts the default model and small.en, and modelIdForConfig resolves both', () => {
  const paths = servicePaths({ WHISPER_SERVICE_HOME: join(tmpdir(), 'whisper-config-model') });
  const base = defaultConfig(paths);
  assert.equal(validateConfig(base), base);
  assert.equal(modelIdForConfig(base), 'base.en');

  const small = defaultConfig(paths);
  small.runtime.modelPath = join(paths.models, MODELS['small.en'].file);
  small.runtime.modelSha256 = MODELS['small.en'].sha256;
  assert.equal(validateConfig(small), small);
  assert.equal(modelIdForConfig(small), 'small.en');
});

test('validateConfig rejects a mismatched file/hash pair and an unknown hash', () => {
  const paths = servicePaths({ WHISPER_SERVICE_HOME: join(tmpdir(), 'whisper-config-model-bad') });
  const mismatched = defaultConfig(paths);
  mismatched.runtime.modelSha256 = MODELS['small.en'].sha256;
  assert.throws(() => validateConfig(mismatched), /INVALID_CONFIGURATION|known, correctly pinned/);

  const unknown = defaultConfig(paths);
  unknown.runtime.modelSha256 = 'f'.repeat(64);
  assert.throws(() => validateConfig(unknown), /known, correctly pinned/);
});

test('selectModel returns an updated configuration for an installed, verified file and leaves the input unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-service-select-model-'));
  try {
    const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
    const modelFile = join(paths.models, 'test-model.bin');
    await mkdir(paths.models, { recursive: true });
    await writeFile(modelFile, 'fixture-model-bytes');
    const digest = createHash('sha256').update('fixture-model-bytes').digest('hex');
    const catalog = { 'test.model': { file: 'test-model.bin', sha256: digest, url: 'https://example.invalid/test-model.bin' } };

    const original = defaultConfig(paths);
    const snapshot = JSON.stringify(original);
    const updated = await selectModel(original, 'test.model', paths, catalog);

    assert.equal(updated.runtime.modelPath, modelFile);
    assert.equal(updated.runtime.modelSha256, digest);
    assert.equal(JSON.stringify(original), snapshot);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('selectModel rejects a missing file, a hash mismatch, and an unknown id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-service-select-model-bad-'));
  try {
    const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
    await mkdir(paths.models, { recursive: true });
    const config = defaultConfig(paths);
    const catalog = { 'test.model': { file: 'test-model.bin', sha256: 'a'.repeat(64), url: 'https://example.invalid/test-model.bin' } };

    await assert.rejects(() => selectModel(config, 'test.model', paths, catalog), /npm run setup -- --model/);

    await writeFile(join(paths.models, 'test-model.bin'), 'wrong-bytes');
    await assert.rejects(() => selectModel(config, 'test.model', paths, catalog), /npm run setup -- --model/);

    await assert.rejects(() => selectModel(config, 'unknown.id', paths, catalog), /Valid ids: test\.model/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('logger allowlist cannot leak tokens, transcript text, audio, or paths', () => {
  const output = [];
  const logger = createLogger({ log: (line) => output.push(line), error: (line) => output.push(line) });
  logger.info('safe', { token: 'secret-token', text: 'private transcript', audio: 'bytes', path: 'private.wav', sessionId: 'session' });
  assert.equal(output.length, 1);
  assert(!output[0].includes('secret-token'));
  assert(!output[0].includes('private transcript'));
  assert(!output[0].includes('private.wav'));
  assert.match(output[0], /session/);
});

test('the catalog pins every full-size English-capable model by file name, SHA-256 and source URL', () => {
  assert.deepEqual(Object.keys(MODELS), ['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v1', 'large-v2', 'large-v3', 'large-v3-turbo']);
  for (const [id, entry] of Object.entries(MODELS)) {
    assert.equal(entry.file, `ggml-${id}.bin`);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.url, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin`);
    assert(Object.isFrozen(entry));
  }
  assert.equal(new Set(Object.values(MODELS).map((entry) => entry.sha256)).size, Object.keys(MODELS).length);
  assert.equal(MODELS['base.en'].sha256, 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002');
  assert.equal(MODELS['small.en'].sha256, 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d');
});

test('validateConfig resolves every catalog model from its file and hash', () => {
  const paths = servicePaths({ WHISPER_SERVICE_HOME: join(tmpdir(), 'whisper-config-catalog') });
  for (const [id, entry] of Object.entries(MODELS)) {
    const config = defaultConfig(paths);
    config.runtime.modelPath = join(paths.models, entry.file);
    config.runtime.modelSha256 = entry.sha256;
    assert.equal(modelIdForConfig(validateConfig(config)), id);
  }
});

test('runtime.device defaults to auto, accepts auto, cpu and gpu, and rejects anything else', () => {
  const paths = servicePaths({ WHISPER_SERVICE_HOME: join(tmpdir(), 'whisper-config-device') });
  const config = defaultConfig(paths);
  assert.equal(config.runtime.device, 'auto');
  for (const device of ['auto', 'cpu', 'gpu']) {
    config.runtime.device = device;
    assert.equal(deviceForConfig(validateConfig(config)), device);
  }
  for (const device of ['cuda', 'GPU', '', null, 1]) {
    config.runtime.device = device;
    assert.throws(() => validateConfig(config), /runtime\.device must be one of: auto, cpu, gpu/);
  }
});

test('a configuration written before runtime.device existed stays valid and means auto', () => {
  const paths = servicePaths({ WHISPER_SERVICE_HOME: join(tmpdir(), 'whisper-config-legacy') });
  const legacy = defaultConfig(paths);
  delete legacy.runtime.device;
  assert.equal(validateConfig(legacy), legacy);
  assert.equal(deviceForConfig(legacy), 'auto');
  assert.equal('device' in legacy.runtime, false);
});
