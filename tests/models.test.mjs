import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeUserFiles, servicePaths } from '../src/config.mjs';
import { MODELS } from '../src/constants.mjs';
import { installModel, modelEntry, prepareModel, progressPrinter } from '../src/models.mjs';

const BYTES = Buffer.from('pretend model weights');
const DIGEST = createHash('sha256').update(BYTES).digest('hex');
const CATALOG = Object.freeze({ 'test.model': Object.freeze({ file: 'ggml-test.model.bin', sha256: DIGEST, url: 'https://example.invalid/ggml-test.model.bin' }) });

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return typeof response === 'function' ? response() : response; };
  return { calls, fetchImpl };
}

async function withDir(prefix, run) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('installModel downloads a missing model, verifies it, reports progress and leaves no partial file', () => withDir('whisper-models-download-', async (dir) => {
  const { calls, fetchImpl } = fakeFetch(() => new Response(BYTES, { headers: { 'content-length': String(BYTES.length) } }));
  const progress = [];
  assert.equal(await installModel(dir, 'test.model', { catalog: CATALOG, fetchImpl, onProgress: (value) => progress.push(value) }), true);
  assert.deepEqual(calls, ['https://example.invalid/ggml-test.model.bin']);
  assert.deepEqual(await readFile(join(dir, 'ggml-test.model.bin')), BYTES);
  assert.equal(await exists(join(dir, 'ggml-test.model.bin.download')), false);
  assert.deepEqual(progress.at(-1), { received: BYTES.length, total: BYTES.length });
}));

test('installModel only verifies a model that is already installed', () => withDir('whisper-models-present-', async (dir) => {
  await writeFile(join(dir, 'ggml-test.model.bin'), BYTES);
  const { calls, fetchImpl } = fakeFetch(() => { throw new Error('must not download'); });
  assert.equal(await installModel(dir, 'test.model', { catalog: CATALOG, fetchImpl }), false);
  assert.equal(calls.length, 0);
}));

test('installModel refuses an installed file that does not match its pinned hash and leaves it alone', () => withDir('whisper-models-corrupt-', async (dir) => {
  await writeFile(join(dir, 'ggml-test.model.bin'), 'damaged');
  const { calls, fetchImpl } = fakeFetch(() => { throw new Error('must not download'); });
  await assert.rejects(() => installModel(dir, 'test.model', { catalog: CATALOG, fetchImpl }), /does not match the pinned SHA-256 for test\.model\. Delete it and try again/);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(join(dir, 'ggml-test.model.bin'), 'utf8'), 'damaged');
}));

test('installModel discards a download whose bytes do not match the pinned hash', () => withDir('whisper-models-mismatch-', async (dir) => {
  const { fetchImpl } = fakeFetch(() => new Response('tampered bytes'));
  await assert.rejects(() => installModel(dir, 'test.model', { catalog: CATALOG, fetchImpl }), /download does not match its pinned SHA-256/);
  assert.equal(await exists(join(dir, 'ggml-test.model.bin')), false);
  assert.equal(await exists(join(dir, 'ggml-test.model.bin.download')), false);
}));

test('installModel reports an HTTP failure and writes nothing', () => withDir('whisper-models-http-', async (dir) => {
  const { fetchImpl } = fakeFetch(() => new Response(null, { status: 404 }));
  await assert.rejects(() => installModel(dir, 'test.model', { catalog: CATALOG, fetchImpl }), /Downloading test\.model failed with HTTP 404/);
  assert.equal(await exists(join(dir, 'ggml-test.model.bin')), false);
}));

test('an unknown model id is rejected with the list of valid ids', async () => {
  assert.throws(() => modelEntry('huge.en'), /Unknown model huge\.en\. Valid ids: tiny\.en, base\.en, small\.en, medium\.en, large-v1, large-v2, large-v3, large-v3-turbo\./);
  await assert.rejects(() => installModel(tmpdir(), 'nope', { catalog: CATALOG, fetchImpl: () => { throw new Error('must not download'); } }), /Valid ids: test\.model/);
});

test('progressPrinter writes one line per whole percent to a terminal and nothing to a pipe', () => {
  const written = [];
  const terminal = progressPrinter({ isTTY: true, write: (text) => written.push(text) });
  for (const received of [0, 5, 6, 10]) terminal({ received, total: 10 });
  assert.deepEqual(written.map((line) => line.trim()), ['0 of 0 MB (0%)', '0 of 0 MB (50%)', '0 of 0 MB (60%)', '0 of 0 MB (100%)']);
  const piped = [];
  progressPrinter({ isTTY: false, write: (text) => piped.push(text) })({ received: 1, total: 2 });
  assert.equal(piped.length, 0);
});

async function serviceHome(prefix, run) {
  return withDir(prefix, async (root) => {
    const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
    await initializeUserFiles(paths, { secureCredentials: false });
    await mkdir(paths.models, { recursive: true });
    const install = async (dir, id) => { install.calls.push([dir, id]); return install.result(id); };
    install.calls = [];
    install.result = () => true;
    const lines = [];
    return run({ paths, install, lines, log: (line) => lines.push(line) });
  });
}

test('a plain start with the configured model installed changes nothing and downloads nothing', () => serviceHome('whisper-prepare-plain-', async ({ paths, install, log }) => {
  await writeFile(join(paths.models, MODELS['base.en'].file), 'present');
  const before = await readFile(paths.config, 'utf8');
  const result = await prepareModel(paths, undefined, { install, log });
  assert.equal(result.modelId, 'base.en');
  assert.equal(result.switched, false);
  assert.equal(install.calls.length, 0);
  assert.equal(await readFile(paths.config, 'utf8'), before);
}));

test('a plain start downloads the configured model when its file is missing, without rewriting the configuration', () => serviceHome('whisper-prepare-missing-', async ({ paths, install, lines, log }) => {
  const before = await readFile(paths.config, 'utf8');
  const result = await prepareModel(paths, undefined, { install, log });
  assert.deepEqual(install.calls, [[paths.models, 'base.en']]);
  assert.equal(result.switched, false);
  assert(lines.some((line) => line === 'base.en is not installed yet. Downloading and verifying it...'));
  assert(lines.some((line) => line === 'base.en downloaded and verified.'));
  assert.equal(await readFile(paths.config, 'utf8'), before);
}));

test('starting with another model installs it if needed and saves it as the model for later starts', () => serviceHome('whisper-prepare-switch-', async ({ paths, install, lines, log }) => {
  const result = await prepareModel(paths, 'large-v3-turbo', { install, log });
  assert.deepEqual(install.calls, [[paths.models, 'large-v3-turbo']]);
  assert.equal(result.switched, true);
  assert.equal(result.modelId, 'large-v3-turbo');
  const saved = JSON.parse(await readFile(paths.config, 'utf8'));
  assert.equal(saved.runtime.modelPath, join(paths.models, 'ggml-large-v3-turbo.bin'));
  assert.equal(saved.runtime.modelSha256, MODELS['large-v3-turbo'].sha256);
  assert.deepEqual(result.config, saved);
  assert(lines.includes('Switched to large-v3-turbo. A plain npm start will keep using it.'));
}));

test('switching to an installed model verifies it but does not report a download', () => serviceHome('whisper-prepare-installed-', async ({ paths, install, lines, log }) => {
  await writeFile(join(paths.models, MODELS['small.en'].file), 'present');
  install.result = () => false;
  await prepareModel(paths, 'small.en', { install, log });
  assert.deepEqual(install.calls, [[paths.models, 'small.en']]);
  assert.equal(lines.some((line) => /Downloading|downloaded/.test(line)), false);
  assert.equal(JSON.parse(await readFile(paths.config, 'utf8')).runtime.modelSha256, MODELS['small.en'].sha256);
}));

test('a failed download leaves the configuration byte-identical and surfaces the error', () => serviceHome('whisper-prepare-fail-', async ({ paths, install, log }) => {
  install.result = () => { throw new Error('Downloading large-v3 failed with HTTP 503.'); };
  const before = await readFile(paths.config, 'utf8');
  await assert.rejects(() => prepareModel(paths, 'large-v3', { install, log }), /HTTP 503/);
  assert.equal(await readFile(paths.config, 'utf8'), before);
}));

test('an unknown model leaves the configuration byte-identical and downloads nothing', () => serviceHome('whisper-prepare-unknown-', async ({ paths, install, log }) => {
  const before = await readFile(paths.config, 'utf8');
  await assert.rejects(() => prepareModel(paths, 'huge.en', { install, log }), /Valid ids: tiny\.en/);
  assert.equal(install.calls.length, 0);
  assert.equal(await readFile(paths.config, 'utf8'), before);
}));
