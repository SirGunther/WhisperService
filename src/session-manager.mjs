import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS, PROTOCOL_VERSION } from './constants.mjs';
import { encodeWav, pcmDurationMs, pcmRms, validatePcm16 } from './audio.mjs';
import { ServiceError, errorEnvelope } from './errors.mjs';
import { InferenceScheduler } from './scheduler.mjs';
import { tokenMatches } from './config.mjs';

function event(type, body = {}) {
  return { version: PROTOCOL_VERSION, type, ...body };
}

function normalizeInference(value) {
  if (!value || typeof value.text !== 'string' || !Array.isArray(value.segments)) {
    throw new ServiceError('MALFORMED_INFERENCE_OUTPUT', 'The worker response did not match protocol 1.0.0.');
  }
  const segments = value.segments.map((segment) => {
    if (!segment || typeof segment.text !== 'string' || !Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.startMs < 0 || segment.endMs < segment.startMs) {
      throw new ServiceError('MALFORMED_INFERENCE_OUTPUT', 'A worker transcript segment was malformed.');
    }
    return { startMs: segment.startMs, endMs: segment.endMs, text: segment.text };
  });
  return { text: value.text.trim(), segments };
}

export class SessionManager {
  constructor({ config, worker, tempDirectory, logger, scheduler = new InferenceScheduler(), now = () => Date.now() }) {
    this.config = config;
    this.worker = worker;
    this.tempDirectory = tempDirectory;
    this.logger = logger;
    this.scheduler = scheduler;
    this.now = now;
    this.sessions = new Map();
    this.shuttingDown = false;
  }

  create({ previewMs } = {}) {
    if (this.shuttingDown) throw new ServiceError('SERVICE_NOT_READY', 'The service is shutting down.');
    if (this.sessions.size >= this.config.limits.maxActiveSessions) {
      throw new ServiceError('CAPACITY_EXCEEDED', 'The maximum number of active sessions is already in use.');
    }
    const cadence = previewMs ?? this.config.speech.previewMs;
    if (!Number.isInteger(cadence) || cadence < DEFAULTS.previewMinMs || cadence > DEFAULTS.previewMaxMs) {
      throw new ServiceError('INVALID_REQUEST', `previewMs must be an integer from ${DEFAULTS.previewMinMs} to ${DEFAULTS.previewMaxMs}.`);
    }
    const id = randomUUID();
    const ticket = randomBytes(32).toString('base64url');
    const session = {
      id,
      ticket,
      ticketExpiresAt: this.now() + DEFAULTS.ticketTtlMs,
      ticketUsed: false,
      previewMs: cadence,
      status: 'created',
      ws: null,
      utterance: this.#newUtterance(),
      pendingFinals: new Set(),
      closed: false,
      idleTimer: null,
      ticketTimer: null
    };
    session.ticketTimer = setTimeout(() => {
      if (!session.ticketUsed) this.cancel(id, 'ticket_expired');
    }, DEFAULTS.ticketTtlMs + 25);
    session.ticketTimer.unref?.();
    this.sessions.set(id, session);
    this.logger.info('session.created', { sessionId: id, activeSessions: this.sessions.size });
    return { id, ticket, ticketExpiresAt: new Date(session.ticketExpiresAt).toISOString(), previewMs: cadence };
  }

  #newUtterance() {
    return {
      id: randomUUID(),
      chunks: [],
      bytes: 0,
      durationMs: 0,
      speechMs: 0,
      silenceMs: 0,
      speechDetected: false,
      nextPreviewMs: 0,
      requestedRevision: 0,
      finalized: false
    };
  }

  consumeTicket(id, ticket) {
    const session = this.sessions.get(id);
    if (!session || session.closed || session.ticketUsed || !tokenMatches(ticket, session.ticket)) {
      throw new ServiceError('INVALID_TICKET', 'The WebSocket ticket is invalid or has already been used.');
    }
    session.ticketUsed = true;
    session.ticket = undefined;
    clearTimeout(session.ticketTimer);
    if (this.now() > session.ticketExpiresAt) {
      this.cancel(id, 'ticket_expired');
      throw new ServiceError('TICKET_EXPIRED', 'The WebSocket ticket has expired.');
    }
    return session;
  }

  attach(id, ws) {
    const session = this.sessions.get(id);
    if (!session || session.closed || !session.ticketUsed || session.ws) {
      throw new ServiceError('INVALID_TICKET', 'The session cannot accept this WebSocket connection.');
    }
    session.ws = ws;
    session.status = 'streaming';
    session.utterance.nextPreviewMs = session.previewMs;
    this.#touch(session);
    this.#emit(session, event('session.ready', {
      sessionId: session.id,
      audio: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1 },
      previewMs: session.previewMs
    }));
    this.logger.info('session.ready', { sessionId: id });
  }

  #touch(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.#emitError(session, new ServiceError('SESSION_TIMEOUT', 'The session timed out due to inactivity.'));
      this.cancel(session.id, 'timeout');
    }, this.config.limits.idleSessionMs);
    session.idleTimer.unref?.();
  }

  #emit(session, payload) {
    if (session.ws?.readyState === 1) session.ws.send(JSON.stringify(payload));
  }

  #emitError(session, error) {
    this.#emit(session, event('error', errorEnvelope(error).error));
  }

  acceptAudio(id, buffer) {
    const session = this.#streaming(id);
    this.#touch(session);
    try { validatePcm16(buffer, DEFAULTS.maxFrameBytes); }
    catch (error) { this.#emitError(session, error); return; }
    let offset = 0;
    while (offset < buffer.length && !session.closed && session.status === 'streaming') {
      const utteranceLimitBytes = this.config.limits.maxUtteranceMs * 32;
      const remainingBytes = Math.max(2, utteranceLimitBytes - session.utterance.bytes);
      const end = Math.min(buffer.length, offset + remainingBytes);
      this.#acceptAudioPart(session, buffer.subarray(offset, end));
      offset = end;
    }
  }

  #acceptAudioPart(session, buffer) {
    const utterance = session.utterance;
    if (utterance.finalized) return;
    const duration = pcmDurationMs(buffer);
    const rms = pcmRms(buffer);
    utterance.chunks.push(Buffer.from(buffer));
    utterance.bytes += buffer.length;
    utterance.durationMs += duration;
    if (rms >= this.config.speech.speechRms) {
      utterance.speechDetected = true;
      utterance.speechMs += duration;
      utterance.silenceMs = 0;
    } else if (utterance.speechDetected && rms <= this.config.speech.silenceRms) {
      utterance.silenceMs += duration;
    }
    if (utterance.speechDetected && utterance.durationMs >= utterance.nextPreviewMs) {
      utterance.nextPreviewMs += session.previewMs;
      this.#preview(session, utterance);
    }
    if (utterance.durationMs >= this.config.limits.maxUtteranceMs) {
      void this.#finalize(session, 'rollover');
    } else if (utterance.speechMs >= this.config.speech.minSpeechMs && utterance.silenceMs >= this.config.speech.pauseMs) {
      void this.#finalize(session, 'pause');
    }
  }

  async control(id, message) {
    const session = this.#streaming(id);
    this.#touch(session);
    if (!message || message.version !== PROTOCOL_VERSION || !['flush', 'stop', 'cancel'].includes(message.type) || Object.keys(message).some((key) => !['version', 'type'].includes(key))) {
      throw new ServiceError('INVALID_REQUEST', 'Control messages require version 1.0.0 and type flush, stop, or cancel.');
    }
    if (message.type === 'cancel') return this.cancel(id, 'cancel');
    const final = this.#finalize(session, message.type);
    if (message.type === 'stop') {
      session.status = 'closing';
      await final;
      await Promise.allSettled([...session.pendingFinals]);
      this.#close(session, 'stop');
      return;
    }
    await final;
  }

  #streaming(id) {
    const session = this.sessions.get(id);
    if (!session || session.closed || session.status !== 'streaming') throw new ServiceError('NOT_FOUND', 'The streaming session was not found.');
    return session;
  }

  #preview(session, utterance) {
    if (!utterance.speechDetected || utterance.speechMs < this.config.speech.minSpeechMs || utterance.finalized) return;
    const revision = ++utterance.requestedRevision;
    const snapshot = Buffer.concat(utterance.chunks, utterance.bytes);
    const key = `${session.id}:${utterance.id}`;
    void this.scheduler.enqueuePreview(key, ({ queueMs }) => this.#infer(snapshot, { session, utterance, revision, queueMs }))
      .then((result) => {
        if (!result || result.superseded || utterance.finalized || session.closed || revision !== utterance.requestedRevision || !result.text) return;
        this.#emit(session, event('transcript.partial', {
          sessionId: session.id,
          utteranceId: utterance.id,
          revision,
          text: result.text
        }));
        this.logger.info('transcript.partial', { sessionId: session.id, utteranceId: utterance.id, revision });
      })
      .catch((error) => { if (!session.closed) this.#emitError(session, error); })
      .finally(() => snapshot.fill(0));
  }

  #finalize(session, reason) {
    const utterance = session.utterance;
    if (utterance.finalized) return Promise.resolve();
    utterance.finalized = true;
    const snapshot = utterance.bytes ? Buffer.concat(utterance.chunks, utterance.bytes) : null;
    utterance.chunks.length = 0;
    utterance.bytes = 0;
    session.utterance = this.#newUtterance();
    session.utterance.nextPreviewMs = session.previewMs;
    const key = `${session.id}:${utterance.id}`;
    this.scheduler.cancelPreviews(key);
    let operation;
    if (!snapshot || !utterance.speechDetected || utterance.speechMs < this.config.speech.minSpeechMs) {
      operation = Promise.resolve().then(() => {
        if (!session.closed) this.#emit(session, event('transcript.empty', {
          sessionId: session.id,
          utteranceId: utterance.id,
          finalizationReason: reason
        }));
      });
    } else {
      operation = this.scheduler.enqueueFinal(key, ({ queueMs }) => this.#infer(snapshot, { session, utterance, revision: null, queueMs }))
        .then((result) => {
          if (session.closed) return;
          if (!result.text) {
            this.#emit(session, event('transcript.empty', { sessionId: session.id, utteranceId: utterance.id, finalizationReason: reason }));
          } else {
            this.#emit(session, event('transcript.final', {
              sessionId: session.id,
              utteranceId: utterance.id,
              text: result.text,
              segments: result.segments,
              finalizationReason: reason
            }));
          }
          this.logger.info('transcript.finalized', { sessionId: session.id, utteranceId: utterance.id, reason });
        })
        .catch((error) => { if (!session.closed) this.#emitError(session, error); })
        .finally(() => snapshot.fill(0));
    }
    session.pendingFinals.add(operation);
    operation.finally(() => session.pendingFinals.delete(operation));
    return operation;
  }

  async #infer(pcm, metadata) {
    await mkdir(this.tempDirectory, { recursive: true });
    const path = join(this.tempDirectory, `${randomUUID()}.wav`);
    const started = performance.now();
    try {
      await writeFile(path, encodeWav(pcm), { flag: 'wx' });
      const result = normalizeInference(await this.worker.transcribe(path));
      this.logger.info('inference.completed', {
        sessionId: metadata.session.id,
        utteranceId: metadata.utterance.id,
        revision: metadata.revision ?? undefined,
        queueMs: Math.round(metadata.queueMs),
        inferenceMs: Math.round(performance.now() - started),
        bytes: pcm.length
      });
      return result;
    } finally {
      try { await unlink(path); } catch {}
      pcm.fill(0);
    }
  }

  async transcribeWav(wav, pcm) {
    const pseudoSession = { id: randomUUID(), closed: false };
    const utterance = { id: randomUUID() };
    return this.scheduler.enqueueFinal(`batch:${utterance.id}`, async ({ queueMs }) => {
      await mkdir(this.tempDirectory, { recursive: true });
      const path = join(this.tempDirectory, `${randomUUID()}.wav`);
      const started = performance.now();
      try {
        await writeFile(path, wav, { flag: 'wx' });
        const result = normalizeInference(await this.worker.transcribe(path));
        this.logger.info('inference.completed', { sessionId: pseudoSession.id, utteranceId: utterance.id, queueMs: Math.round(queueMs), inferenceMs: Math.round(performance.now() - started), bytes: pcm.length });
        return result;
      } finally {
        try { await unlink(path); } catch {}
        wav.fill(0);
        pcm.fill(0);
      }
    }).finally(() => { wav.fill(0); pcm.fill(0); });
  }

  cancel(id, reason = 'cancel') {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.utterance.finalized = true;
    for (const chunk of session.utterance.chunks) chunk.fill(0);
    session.utterance.chunks.length = 0;
    session.utterance.bytes = 0;
    this.scheduler.cancelPreviews(`${session.id}:${session.utterance.id}`);
    this.#close(session, reason);
    return true;
  }

  #close(session, reason) {
    if (session.closed) return;
    session.closed = true;
    session.status = 'closed';
    clearTimeout(session.idleTimer);
    clearTimeout(session.ticketTimer);
    this.#emit(session, event('session.closed', { sessionId: session.id, reason }));
    if (session.ws?.readyState === 1) session.ws.close(1000, reason.slice(0, 123));
    session.ws = null;
    this.sessions.delete(session.id);
    this.logger.info('session.closed', { sessionId: session.id, reason, activeSessions: this.sessions.size });
  }

  async shutdown(reason = 'shutdown') {
    this.shuttingDown = true;
    for (const session of [...this.sessions.values()]) this.cancel(session.id, reason);
    await this.scheduler.close();
  }

  get activeCount() { return this.sessions.size; }
}
