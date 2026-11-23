#!/usr/bin/env node
// Runs each installed model on each device through the native worker directly (no HTTP server, no port),
// so it can run while the live service is up. Reports how long a full-length utterance takes and how
// accurate the transcript is, and whether that fits dictation's real-time budget.
import { randomUUID } from 'node:crypto';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeWav, encodeWav } from '../src/audio.mjs';
import { loadConfig, servicePaths } from '../src/config.mjs';
import { BITS_PER_SAMPLE, CHANNELS, DEFAULTS, DEVICES, MODELS, SAMPLE_RATE } from '../src/constants.mjs';
import { WorkerClient, sha256 } from '../src/worker-client.mjs';
import { UTTERANCE_FIXTURE_TEXT, ensureFixture, utteranceFixture } from './smoke.mjs';

// One inference never sees more audio than a full utterance (limits.maxUtteranceMs upper bound).
export const CLIP_MS = 10_000;
// A preview inference is due every previewMs (default 2,000 ms); slower than that and previews fall behind.
export const PREVIEW_CADENCE_MS = DEFAULTS.previewMs;
// SaySlate waits this long after Stop for the final transcript (SaySlate whisperServiceClient.js SETTLEMENT_TIMEOUT_MS).
export const SAYSLATE_STOP_WINDOW_MS = 4_000;
// After Stop the final can queue behind one in-flight preview, so two full-utterance inferences share the window.
const INFERENCES_IN_STOP_WINDOW = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
const DEFAULT_RUNS = 3;
const BASELINE_ROW = Object.freeze({ model: 'base.en', device: 'cpu' });

export function parseArgs(argv) {
  const options = { models: null, devices: null, worker: null, runs: DEFAULT_RUNS, json: false, wav: null, expect: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${argument} requires a value.`);
      index += 1;
      return next;
    };
    if (argument === '--models') options.models = value().split(',').filter(Boolean);
    else if (argument === '--devices') options.devices = value().split(',').filter(Boolean);
    else if (argument === '--worker') options.worker = resolve(value());
    else if (argument === '--runs') options.runs = Number(value());
    else if (argument === '--expect') options.expect = value();
    else if (argument === '--json') options.json = true;
    else if (!argument.startsWith('--') && !options.wav) options.wav = resolve(argument);
    else throw new Error(`Unknown argument ${argument}.`);
  }
  for (const model of options.models || []) {
    if (!MODELS[model]) throw new Error(`Unknown model ${model}. Valid models: ${Object.keys(MODELS).join(', ')}.`);
  }
  for (const device of options.devices || []) {
    if (!DEVICES.includes(device)) throw new Error(`Unknown device ${device}. Valid devices: ${DEVICES.join(', ')}.`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) throw new Error('--runs must be an integer from 1 to 20.');
  return options;
}

// Default: every installed model on the GPU, plus base.en on the CPU as the reference.
export function buildMatrix({ models, devices, installed }) {
  const catalogOrder = Object.keys(MODELS);
  const chosen = (models || installed).slice().sort((left, right) => catalogOrder.indexOf(left) - catalogOrder.indexOf(right));
  const rows = [];
  if (!models && !devices) rows.push({ ...BASELINE_ROW });
  for (const model of chosen) {
    for (const device of devices || ['gpu']) rows.push({ model, device });
  }
  return rows;
}

function words(text) {
  return text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
}

export function wordErrorRate(reference, hypothesis) {
  const expected = words(reference);
  const actual = words(hypothesis);
  if (expected.length === 0) return actual.length === 0 ? 0 : 1;
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let row = 1; row <= expected.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= actual.length; column += 1) {
      const substitution = previous[column - 1] + (expected[row - 1] === actual[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[actual.length] / expected.length;
}

export function verdict(medianMs) {
  if (medianMs <= Math.min(PREVIEW_CADENCE_MS, SAYSLATE_STOP_WINDOW_MS / INFERENCES_IN_STOP_WINDOW)) return 'keeps up';
  if (medianMs <= SAYSLATE_STOP_WINDOW_MS) return 'tight';
  return 'too slow';
}

// Pads the recording with trailing silence so every model is timed on one full-length utterance. The speech is
// never repeated: medium.en collapses a repeated sentence into one copy on CPU and GPU alike.
export function buildClip(pcm, clipMs = CLIP_MS) {
  const limitBytes = (clipMs / 1_000) * BYTES_PER_SECOND;
  return pcm.length < limitBytes ? Buffer.concat([pcm, Buffer.alloc(limitBytes - pcm.length)]) : pcm;
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

export async function installedModels(modelsDir) {
  const ids = [];
  for (const [id, entry] of Object.entries(MODELS)) if (await exists(join(modelsDir, entry.file))) ids.push(id);
  return ids;
}

export async function runRow(row, { modelsDir, workerPath, clipPath, clipMs, runs, expected, hashCache = new Map(), hashFile = sha256, createWorker = (options) => new WorkerClient(options) }) {
  const entry = MODELS[row.model];
  const result = { ...row, status: 'failed', ranOn: null, deviceName: null, loadMs: null, firstMs: null, medianMs: null, stateMs: null, rtf: null, wer: null, text: null, verdict: null, reason: null };
  const modelPath = join(modelsDir, entry.file);
  if (!(await exists(modelPath))) {
    result.reason = `not installed: npm run setup -- --model ${row.model} --skip-build`;
    return result;
  }
  if (!hashCache.has(row.model)) hashCache.set(row.model, (await hashFile(modelPath)).toLowerCase() === entry.sha256);
  if (!hashCache.get(row.model)) {
    result.reason = `${entry.file} does not match its pinned SHA-256: npm run setup -- --model ${row.model} --skip-build`;
    return result;
  }
  const worker = createWorker({ workerPath, modelPath, modelSha256: entry.sha256, device: row.device, startupMs: DEFAULTS.workerStartupMs });
  try {
    const started = performance.now();
    const metadata = await worker.start({ verifyAssets: false });
    result.loadMs = Math.round(performance.now() - started);
    result.ranOn = metadata?.device || 'unknown';
    result.deviceName = metadata?.deviceName || null;
    let timed = performance.now();
    let output = await worker.transcribe(clipPath);
    result.firstMs = Math.round(performance.now() - timed);
    const totals = [];
    const states = [];
    for (let run = 0; run < runs; run += 1) {
      timed = performance.now();
      output = await worker.transcribe(clipPath);
      totals.push(performance.now() - timed);
      if (Number.isFinite(output?.timing?.stateMs)) states.push(output.timing.stateMs);
    }
    result.medianMs = Math.round(median(totals));
    result.stateMs = states.length ? Math.round(median(states)) : null;
    result.rtf = Number((result.medianMs / clipMs).toFixed(3));
    result.text = typeof output?.text === 'string' ? output.text.trim() : '';
    result.wer = expected ? Number(wordErrorRate(expected, result.text).toFixed(3)) : null;
    result.verdict = verdict(result.medianMs);
    result.status = 'ok';
  } catch (error) {
    result.reason = error.message;
  } finally {
    await worker.close();
  }
  return result;
}

export function formatTable(results) {
  const cell = (value, suffix = '') => (value === null || value === undefined ? '—' : `${value}${suffix}`);
  const lines = [
    '| Model | Asked | Ran on | Load | First job | Clip (median) | State setup | RTF | WER | Verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const row of results) {
    const ranOn = row.deviceName ? `${row.ranOn} (${row.deviceName})` : cell(row.ranOn);
    const outcome = row.status === 'ok' ? row.verdict : `failed: ${row.reason}`;
    lines.push(`| ${row.model} | ${row.device} | ${ranOn} | ${cell(row.loadMs, ' ms')} | ${cell(row.firstMs, ' ms')} | ${cell(row.medianMs, ' ms')} | ${cell(row.stateMs, ' ms')} | ${cell(row.rtf)} | ${row.wer === null ? '—' : `${(row.wer * 100).toFixed(1)}%`} | ${outcome} |`);
  }
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const paths = servicePaths();
  const config = await loadConfig(paths);
  const workerPath = options.worker || config.runtime.workerPath;
  const wavPath = options.wav || utteranceFixture;
  await ensureFixture(wavPath);
  const recording = decodeWav(await readFile(wavPath));
  const clip = options.wav ? recording : buildClip(recording);
  const clipMs = Math.round((clip.length / BYTES_PER_SECOND) * 1_000);
  const expected = options.wav ? options.expect : UTTERANCE_FIXTURE_TEXT;
  const clipPath = join(tmpdir(), `whisper-smoke-models-${randomUUID()}.wav`);
  await writeFile(clipPath, encodeWav(clip));
  const rows = buildMatrix({ models: options.models, devices: options.devices, installed: await installedModels(paths.models) });
  const hashCache = new Map();
  const results = [];
  try {
    if (!options.json) console.log(`Worker ${workerPath}\nClip ${clipMs} ms, ${options.runs} timed run(s) per row after one warm-up job.\n`);
    for (const row of rows) {
      const result = await runRow(row, { modelsDir: paths.models, workerPath, clipPath, clipMs, runs: options.runs, expected, hashCache });
      results.push(result);
      if (!options.json) console.log(`${row.model} on ${row.device}: ${result.status === 'ok' ? `${result.medianMs} ms, ${result.verdict}` : `failed: ${result.reason}`}`);
    }
  } finally {
    await rm(clipPath, { force: true });
  }
  if (options.json) {
    console.log(JSON.stringify({ workerPath, clipMs, runs: options.runs, results }, null, 2));
  } else {
    console.log(`\n${formatTable(results)}\n`);
    console.log(`keeps up: at most ${Math.min(PREVIEW_CADENCE_MS, SAYSLATE_STOP_WINDOW_MS / INFERENCES_IN_STOP_WINDOW)} ms per full utterance; tight: at most ${SAYSLATE_STOP_WINDOW_MS} ms (SaySlate's Stop window).`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Model smoke matrix failed: ${error.message}`);
    process.exitCode = 1;
  });
}
