import { readFile } from 'node:fs/promises';
import { decodeWav } from '../src/audio.mjs';
import { defaultConfig, servicePaths } from '../src/config.mjs';

export function testConfig(root) {
  const config = defaultConfig(servicePaths({ WHISPER_SERVICE_HOME: root }));
  config.limits.idleSessionMs = 60_000;
  return config;
}

export class FakeWorker {
  constructor({ delayMs = 1, text = 'local transcript' } = {}) {
    this.delayMs = delayMs;
    this.text = text;
    this.ready = true;
    this.metadata = { model: 'ggml-base.en.bin', language: 'en', protocolVersion: '1.0.0' };
    this.calls = [];
    this.concurrent = 0;
    this.maxConcurrent = 0;
    this.listeners = new Map();
  }
  on(name, listener) { this.listeners.set(name, listener); }
  once(name, listener) { this.listeners.set(name, listener); }
  fail(error = new Error('worker failed')) { this.ready = false; this.listeners.get('failure')?.(error); }
  async start() { return this.metadata; }
  async close() { this.ready = false; }
  async transcribe(path) {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    const pcm = decodeWav(await readFile(path));
    const marker = pcm.readInt16LE(0);
    this.calls.push({ marker, bytes: pcm.length });
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.concurrent -= 1;
    return { text: `${this.text} ${marker}`, segments: [{ startMs: 0, endMs: Math.round(pcm.length / 32), text: `${this.text} ${marker}` }] };
  }
}

export class FakeSocket {
  constructor() { this.readyState = 1; this.events = []; this.closeCode = null; }
  send(value) { this.events.push(JSON.parse(value)); }
  close(code) { this.closeCode = code; this.readyState = 3; }
}

export function silentLogger() {
  return { info() {}, error() {} };
}

export async function until(predicate, timeoutMs = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
