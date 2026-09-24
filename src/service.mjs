import http from 'node:http';
import { basename } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { decodeWav } from './audio.mjs';
import { tokenMatches } from './config.mjs';
import { DEFAULTS, HOST, PORT, PROTOCOL_VERSION, SERVICE_VERSION } from './constants.mjs';
import { ServiceError, errorEnvelope } from './errors.mjs';
import { originHeaders, readJson, readMultipartWav, sendJson, versioned } from './http-utils.mjs';
import { SessionManager } from './session-manager.mjs';

function bearer(request) {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

function rejectUpgrade(socket, error) {
  const status = error.status || 500;
  const body = JSON.stringify(errorEnvelope(error));
  socket.end(`HTTP/1.1 ${status} Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

export class WhisperService extends EventEmitter {
  constructor({ config, token, worker, tempDirectory, logger }) {
    super();
    this.config = config;
    this.token = token;
    this.worker = worker;
    this.logger = logger;
    this.manager = new SessionManager({ config, worker, tempDirectory, logger });
    this.http = http.createServer((request, response) => void this.#request(request, response));
    this.ws = new WebSocketServer({ noServer: true, maxPayload: DEFAULTS.maxFrameBytes });
    this.http.on('upgrade', (request, socket, head) => this.#upgrade(request, socket, head));
    this.worker.on?.('failure', (error) => void this.#workerFailure(error));
    this.started = false;
    this.closing = false;
  }

  async start({ startWorker = true, verifyAssets = true } = {}) {
    if (startWorker) await this.worker.start({ verifyAssets });
    if (!this.worker.ready) throw new ServiceError('WORKER_FAILURE', 'The native worker did not become ready.');
    this.logger.info('worker.ready', { ready: true, model: this.worker.metadata?.model, language: 'en' });
    try {
      this.http.listen({ host: HOST, port: PORT });
      await once(this.http, 'listening');
    }
    catch (error) {
      if (startWorker) await this.worker.close?.();
      throw new ServiceError('INVALID_CONFIGURATION', `Cannot bind ${HOST}:${PORT}: ${error.message}`);
    }
    this.started = true;
    this.logger.info('service.ready', { serviceVersion: SERVICE_VERSION, protocolVersion: PROTOCOL_VERSION, ready: true });
    return this;
  }

  async #request(request, response) {
    let cors = {};
    try {
      cors = originHeaders(request.headers.origin, this.config.allowedOrigins);
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { ...cors, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      const supplied = bearer(request);
      if (!supplied) throw new ServiceError('AUTH_REQUIRED', 'Authorization: Bearer <token> is required.');
      if (!tokenMatches(supplied, this.token)) throw new ServiceError('AUTH_INVALID', 'The bearer token is invalid.');
      const url = new URL(request.url, `http://${HOST}:${PORT}`);
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, versioned({
          ready: this.started && this.worker.ready && !this.closing,
          serviceVersion: SERVICE_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          model: this.worker.metadata?.model || basename(this.config.runtime.modelPath),
          language: 'en',
          activeSessions: this.manager.activeCount,
          capabilities: {
            streaming: true,
            partialTranscripts: true,
            batchWav: true,
            audio: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1 },
            previewMs: { min: DEFAULTS.previewMinMs, max: DEFAULTS.previewMaxMs, default: this.config.speech.previewMs }
          }
        }), cors);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/sessions') {
        const body = await readJson(request);
        if (body.version !== PROTOCOL_VERSION || Object.keys(body).some((key) => !['version', 'previewMs'].includes(key))) {
          throw new ServiceError('INVALID_REQUEST', `Session requests require a ${PROTOCOL_VERSION} envelope.`);
        }
        const created = this.manager.create({ previewMs: body.previewMs });
        sendJson(response, 201, versioned({
          sessionId: created.id,
          websocketTicket: created.ticket,
          ticketExpiresAt: created.ticketExpiresAt,
          streamUrl: `ws://${HOST}:${PORT}/v1/sessions/${created.id}/stream`,
          previewMs: created.previewMs
        }), cors);
        return;
      }
      const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)$/i);
      if (request.method === 'DELETE' && sessionMatch) {
        if (!this.manager.cancel(sessionMatch[1], 'delete')) throw new ServiceError('NOT_FOUND', 'The session was not found.');
        response.writeHead(204, { ...cors, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
        const { wav, responseFormat } = await readMultipartWav(request);
        const pcm = decodeWav(wav, DEFAULTS.maxUploadBytes);
        const transcript = await this.manager.transcribeWav(wav, pcm);
        if (responseFormat === 'text' || request.headers.accept === 'text/plain') {
          const body = Buffer.from(transcript.text);
          response.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
          response.end(body);
        } else {
          sendJson(response, 200, versioned({ text: transcript.text, segments: transcript.segments, language: 'en' }), cors);
        }
        return;
      }
      throw new ServiceError('NOT_FOUND', 'The requested endpoint was not found.');
    } catch (error) {
      const safe = error instanceof ServiceError ? error : new ServiceError('INTERNAL_ERROR', 'The service could not complete the request.');
      this.logger.error('request.failed', { code: safe.code });
      if (!response.headersSent) sendJson(response, safe.status, errorEnvelope(safe), cors);
      else response.destroy();
    }
  }

  #upgrade(request, socket, head) {
    try {
      originHeaders(request.headers.origin, this.config.allowedOrigins);
      const url = new URL(request.url, `http://${HOST}:${PORT}`);
      const match = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/stream$/i);
      if (!match) throw new ServiceError('NOT_FOUND', 'The WebSocket endpoint was not found.');
      this.manager.consumeTicket(match[1], url.searchParams.get('ticket'));
      this.ws.handleUpgrade(request, socket, head, (websocket) => {
        try {
          this.manager.attach(match[1], websocket);
          websocket.on('message', (data, isBinary) => {
            if (isBinary) {
              try { this.manager.acceptAudio(match[1], Buffer.from(data)); }
              catch (error) {
                if (websocket.readyState === 1) websocket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'error', ...errorEnvelope(error).error }));
              }
              return;
            }
            try {
              const control = JSON.parse(data.toString('utf8'));
              void this.manager.control(match[1], control).catch((error) => websocket.readyState === 1 && websocket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'error', ...errorEnvelope(error).error })));
            } catch {
              const error = new ServiceError('INVALID_REQUEST', 'WebSocket text frames must contain a valid control envelope.');
              if (websocket.readyState === 1) websocket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'error', ...errorEnvelope(error).error }));
            }
          });
          websocket.once('close', () => this.manager.cancel(match[1], 'disconnect'));
          websocket.once('error', () => this.manager.cancel(match[1], 'disconnect'));
        } catch (error) {
          websocket.close(1011, 'session setup failed');
        }
      });
    } catch (error) {
      rejectUpgrade(socket, error instanceof ServiceError ? error : new ServiceError('INTERNAL_ERROR', 'WebSocket upgrade failed.'));
    }
  }

  async #workerFailure(error) {
    if (this.closing) return;
    this.logger.error('worker.failure', { code: error.code || 'WORKER_FAILURE' });
    await this.close('worker_failure', { closeWorker: false });
    this.emit('fatal', error);
  }

  async close(reason = 'shutdown', { closeWorker = true } = {}) {
    if (this.closing) return;
    this.closing = true;
    await this.manager.shutdown(reason);
    await new Promise((resolve) => this.ws.close(resolve));
    if (this.http.listening) await new Promise((resolve) => this.http.close(resolve));
    if (closeWorker) await this.worker.close?.();
    this.started = false;
    this.logger.info('service.closed', { reason });
  }
}
