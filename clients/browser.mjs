const VERSION = '1.0.0';

export class WhisperServiceError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'WhisperServiceError';
    this.code = code;
    this.status = status;
  }
}

async function parseResponse(response) {
  if (response.ok) return response;
  let body;
  try { body = await response.json(); } catch {}
  throw new WhisperServiceError(body?.error?.code || 'HTTP_ERROR', body?.error?.message || `WhisperService returned HTTP ${response.status}.`, response.status);
}

export class StreamingSession {
  constructor({ websocket, descriptor, onEvent }) {
    this.websocket = websocket;
    this.sessionId = descriptor.sessionId;
    this.previewMs = descriptor.previewMs;
    this.listeners = new Set(onEvent ? [onEvent] : []);
    this.ready = new Promise((resolve, reject) => {
      const onOpen = () => resolve(this);
      const onError = () => reject(new WhisperServiceError('OFFLINE', 'WhisperService WebSocket could not connect.'));
      websocket.addEventListener('open', onOpen, { once: true });
      websocket.addEventListener('error', onError, { once: true });
    });
    websocket.binaryType = 'arraybuffer';
    websocket.addEventListener('message', (incoming) => {
      if (typeof incoming.data !== 'string') return;
      let payload;
      try { payload = JSON.parse(incoming.data); } catch { return; }
      for (const listener of this.listeners) listener(payload);
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendPcm16(data) {
    if (this.websocket.readyState !== 1) throw new WhisperServiceError('OFFLINE', 'The transcription session is not connected.');
    const bytes = data instanceof ArrayBuffer ? data.byteLength : data.byteLength ?? data.length;
    if (!bytes || bytes % 2) throw new WhisperServiceError('INVALID_AUDIO', 'PCM16 frames must contain a positive, even number of bytes.');
    this.websocket.send(data);
  }

  #control(type) {
    if (this.websocket.readyState !== 1) throw new WhisperServiceError('OFFLINE', 'The transcription session is not connected.');
    this.websocket.send(JSON.stringify({ version: VERSION, type }));
  }

  flush() { this.#control('flush'); }
  stop() { this.#control('stop'); }
  cancel() { this.#control('cancel'); }
  close() { this.websocket.close(); }
}

export class WhisperServiceClient {
  constructor({ token, baseUrl = 'http://127.0.0.1:8178', fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
    if (!token) throw new TypeError('A WhisperService bearer token is required.');
    if (!fetchImpl || !WebSocketImpl) throw new TypeError('fetch and WebSocket implementations are required.');
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
  }

  async #request(path, options = {}) {
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${this.token}`, ...options.headers }
      });
      return parseResponse(response);
    } catch (error) {
      if (error instanceof WhisperServiceError) throw error;
      throw new WhisperServiceError('OFFLINE', 'WhisperService is offline or unreachable.');
    }
  }

  async health() {
    return (await this.#request('/v1/health')).json();
  }

  async createSession({ previewMs, onEvent } = {}) {
    const response = await this.#request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(previewMs === undefined ? { version: VERSION } : { version: VERSION, previewMs })
    });
    const descriptor = await response.json();
    const url = new URL(descriptor.streamUrl);
    url.searchParams.set('ticket', descriptor.websocketTicket);
    const session = new StreamingSession({ websocket: new this.WebSocket(url), descriptor, onEvent });
    await session.ready;
    return session;
  }

  async cancelSession(sessionId) {
    await this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  }

  async transcribeWav(wav, { responseFormat = 'json', filename = 'audio.wav' } = {}) {
    const form = new FormData();
    const blob = wav instanceof Blob ? wav : new Blob([wav], { type: 'audio/wav' });
    form.append('file', blob, filename);
    form.append('version', VERSION);
    form.append('response_format', responseFormat);
    const response = await this.#request('/v1/audio/transcriptions', { method: 'POST', body: form, headers: responseFormat === 'text' ? { Accept: 'text/plain' } : {} });
    return responseFormat === 'text' ? response.text() : response.json();
  }
}
