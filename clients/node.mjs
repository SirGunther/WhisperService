import WebSocket from 'ws';
import { WhisperServiceClient as BrowserClient, WhisperServiceError, StreamingSession } from './browser.mjs';

export { WhisperServiceError, StreamingSession };

export class WhisperServiceClient extends BrowserClient {
  constructor(options = {}) {
    super({ ...options, fetchImpl: options.fetchImpl || globalThis.fetch, WebSocketImpl: options.WebSocketImpl || WebSocket });
  }
}
