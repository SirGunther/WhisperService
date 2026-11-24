#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { decodeWav } from '../src/audio.mjs';
import { loadConfig, loadToken, servicePaths } from '../src/config.mjs';
import { DEFAULTS } from '../src/constants.mjs';
import { createLogger } from '../src/logger.mjs';
import { WhisperService } from '../src/service.mjs';
import { WorkerClient } from '../src/worker-client.mjs';
import { WhisperServiceClient } from '../clients/node.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultFixture = join(root, 'tests', 'fixtures', 'english.wav');
// The sentence scripts/create-smoke-fixture.ps1 synthesizes into the default fixture.
export const DEFAULT_FIXTURE_TEXT = 'The quick brown fox jumps over the lazy dog.';
// A longer fixture for timing one full utterance: distinct words, because some models collapse repeated speech.
export const utteranceFixture = join(root, 'tests', 'fixtures', 'english-utterance.wav');
export const UTTERANCE_FIXTURE_TEXT = 'The quick brown fox jumps over the lazy dog. Please call Stella and ask her to bring these things with her from the store.';
const SYNTHESIZED_FIXTURES = Object.freeze({ [defaultFixture]: DEFAULT_FIXTURE_TEXT, [utteranceFixture]: UTTERANCE_FIXTURE_TEXT });

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code}.`)));
  });
}

export async function ensureFixture(path) {
  try { await access(path); }
  catch {
    const text = SYNTHESIZED_FIXTURES[path];
    if (!text) throw new Error(`Smoke WAV does not exist: ${path}`);
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'create-smoke-fixture.ps1'), '-Path', path, '-Text', text]);
  }
}

async function streamOnce(client, pcm) {
  const events = [];
  let resolveClosed;
  const closed = new Promise((resolvePromise) => { resolveClosed = resolvePromise; });
  const session = await client.createSession({ onEvent: (event) => {
    events.push(event);
    if (event.type === 'session.closed') resolveClosed();
  } });
  for (let offset = 0; offset < pcm.length; offset += 32_000) session.sendPcm16(pcm.subarray(offset, Math.min(offset + 32_000, pcm.length)));
  session.stop();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Smoke session timed out.')), 120_000))]);
  const finals = events.filter((event) => event.type === 'transcript.final');
  if (!finals.length || finals.every((event) => !event.text.trim())) throw new Error('The real worker returned no usable final transcript.');
  return finals.map((event) => event.text).join(' ').trim();
}

async function main() {
  const wavPath = process.argv[2] ? resolve(process.argv[2]) : defaultFixture;
  await ensureFixture(wavPath);
  const wav = await readFile(wavPath);
  const pcm = decodeWav(wav);
  const paths = servicePaths();
  const config = await loadConfig(paths);
  const token = await loadToken(paths);
  const worker = new WorkerClient({ workerPath: config.runtime.workerPath, modelPath: config.runtime.modelPath, modelSha256: config.runtime.modelSha256, startupMs: DEFAULTS.workerStartupMs });
  let modelInitializations = 0;
  worker.on('ready', () => { modelInitializations += 1; });
  const service = new WhisperService({ config, token, worker, tempDirectory: paths.temp, logger: createLogger() });
  try {
    await service.start();
    const client = new WhisperServiceClient({ token });
    const first = await streamOnce(client, pcm);
    const second = await streamOnce(client, pcm);
    if (modelInitializations !== 1) throw new Error(`Expected one model initialization, observed ${modelInitializations}.`);
    console.log(JSON.stringify({ ok: true, sessions: 2, modelInitializations, firstCharacters: first.length, secondCharacters: second.length }));
  } finally {
    await service.close('smoke_complete');
    pcm.fill(0);
    wav.fill(0);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Smoke test failed: ${error.message}`);
    process.exitCode = 1;
  });
}
