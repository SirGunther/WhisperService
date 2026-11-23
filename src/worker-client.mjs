import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { ServiceError } from './errors.mjs';

export async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject));
  return hash.digest('hex');
}

function decodeJson(encoded) {
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new ServiceError('MALFORMED_INFERENCE_OUTPUT', 'The worker returned malformed inference output.'); }
}

// Exit codes whisper-worker.exe uses before READY (native/whisper-worker.cpp).
const STARTUP_EXIT_MESSAGES = Object.freeze({
  2: 'Native worker rejected its arguments.',
  3: 'Native worker could not load the model on the selected device.',
  4: 'No GPU device is available and runtime.device is gpu. Run npm run configure -- device auto (or cpu) and restart.'
});

export function workerExitMessage(code, signal, { ready = false } = {}) {
  if (signal) return `Native worker exited with signal ${signal}.`;
  if (!ready && STARTUP_EXIT_MESSAGES[code]) return `${STARTUP_EXIT_MESSAGES[code]} (exit code ${code})`;
  return `Native worker exited with code ${code}.`;
}

export class WorkerClient extends EventEmitter {
  constructor({ workerPath, modelPath, modelSha256, startupMs, device = 'auto', command, args = [] }) {
    super();
    this.workerPath = workerPath;
    this.modelPath = modelPath;
    this.modelSha256 = modelSha256;
    this.startupMs = startupMs;
    this.device = device;
    this.command = command || workerPath;
    this.args = command ? args : ['--model', modelPath, '--device', device];
    this.process = null;
    this.ready = false;
    this.metadata = null;
    this.pending = new Map();
    this.expectedExit = false;
  }

  async start({ verifyAssets = true } = {}) {
    if (this.process) return this.metadata;
    if (verifyAssets) {
      try { await Promise.all([access(this.workerPath), access(this.modelPath)]); }
      catch { throw new ServiceError('INVALID_CONFIGURATION', 'The native worker or model is missing. Run npm run setup.'); }
      const actual = await sha256(this.modelPath);
      if (actual.toLowerCase() !== this.modelSha256.toLowerCase()) {
        throw new ServiceError('INVALID_CONFIGURATION', 'The model SHA-256 does not match the pinned identity.');
      }
    }
    const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.process = child;
    let stderrBytes = 0;
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#handleLine(line));
    child.once('error', (error) => this.#fail(new ServiceError('WORKER_FAILURE', `Native worker could not start: ${error.message}`)));
    child.once('exit', (code, signal) => {
      const expected = this.expectedExit;
      const wasReady = this.ready;
      this.ready = false;
      this.process = null;
      const error = new ServiceError('WORKER_FAILURE', workerExitMessage(code, signal, { ready: wasReady }));
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (!expected) this.emit('failure', error);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new ServiceError('WORKER_FAILURE', 'Native worker did not load the model before the startup timeout.');
        this.#fail(error);
        reject(error);
      }, this.startupMs);
      const onReady = (metadata) => { clearTimeout(timer); cleanup(); resolve(metadata); };
      const onFailure = (error) => { clearTimeout(timer); cleanup(); reject(error); };
      const cleanup = () => { this.off('ready', onReady); this.off('failure', onFailure); };
      this.once('ready', onReady);
      this.once('failure', onFailure);
    });
  }

  #handleLine(line) {
    const [type, id, payload, extra] = line.split(' ');
    if (type === 'READY' && id) {
      try {
        this.metadata = decodeJson(id);
        this.ready = true;
        this.emit('ready', this.metadata);
      } catch (error) { this.#fail(error); }
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (type === 'RESULT' && payload && !extra) {
      try { pending.resolve(decodeJson(payload)); } catch (error) { pending.reject(error); }
    } else if (type === 'ERROR') {
      let message = 'Native inference failed.';
      try { message = Buffer.from(extra || '', 'base64url').toString('utf8') || message; } catch {}
      pending.reject(new ServiceError(payload || 'WORKER_FAILURE', message));
    } else {
      pending.reject(new ServiceError('MALFORMED_INFERENCE_OUTPUT', 'The worker returned an unknown response.'));
    }
  }

  #fail(error) {
    if (this.process && !this.process.killed) this.process.kill();
    this.emit('failure', error);
  }

  transcribe(wavPath) {
    if (!this.ready || !this.process) return Promise.reject(new ServiceError('WORKER_FAILURE', 'Native worker is not ready.'));
    const id = randomUUID();
    const encodedPath = Buffer.from(wavPath, 'utf8').toString('base64url');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`TRANSCRIBE ${id} ${encodedPath}\n`, (error) => {
        if (error && this.pending.delete(id)) reject(new ServiceError('WORKER_FAILURE', 'Could not send work to the native worker.'));
      });
    });
  }

  async close() {
    this.expectedExit = true;
    const child = this.process;
    if (!child) return;
    child.stdin.write('QUIT\n');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(() => { if (!child.killed) child.kill(); resolve(); }, 3_000))
    ]);
  }
}
