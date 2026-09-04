import Busboy from 'busboy';
import { DEFAULTS, PROTOCOL_VERSION } from './constants.mjs';
import { ServiceError } from './errors.mjs';

export function originHeaders(origin, allowedOrigins) {
  if (!origin) return {};
  if (!allowedOrigins.includes(origin)) throw new ServiceError('ORIGIN_FORBIDDEN', 'The browser origin is not registered.');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'false',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  };
}

export function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...headers });
  response.end(body);
}

export async function readJson(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ServiceError('INVALID_REQUEST', 'The request body is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError('INVALID_REQUEST', 'The request body must be valid JSON.'); }
}

export function readMultipartWav(request) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({ headers: request.headers, limits: { files: 1, fileSize: DEFAULTS.maxUploadBytes, fields: 4, parts: 5 } });
    } catch {
      reject(new ServiceError('INVALID_REQUEST', 'Content-Type must be multipart/form-data with a boundary.'));
      return;
    }
    let chunks = [];
    let sawFile = false;
    let overflow = false;
    let responseFormat = 'json';
    let version;
    parser.on('file', (name, stream, info) => {
      if (name !== 'file' || sawFile) { stream.resume(); return; }
      sawFile = true;
      if (!['audio/wav', 'audio/wave', 'audio/x-wav', 'application/octet-stream'].includes(info.mimeType)) {
        stream.resume();
        reject(new ServiceError('INVALID_AUDIO', 'The multipart file must be WAV audio.'));
        return;
      }
      stream.on('limit', () => { overflow = true; });
      stream.on('data', (chunk) => chunks.push(chunk));
    });
    parser.on('field', (name, value) => {
      if (name === 'response_format') responseFormat = value;
      if (name === 'version') version = value;
    });
    parser.once('error', () => reject(new ServiceError('INVALID_REQUEST', 'The multipart request is malformed.')));
    parser.once('finish', () => {
      if (!sawFile || !chunks.length) return reject(new ServiceError('INVALID_AUDIO', 'A multipart field named file is required.'));
      if (overflow) return reject(new ServiceError('INVALID_AUDIO', 'The WAV upload exceeds the size limit.'));
      if (version !== PROTOCOL_VERSION) return reject(new ServiceError('INVALID_REQUEST', `Multipart requests require version ${PROTOCOL_VERSION}.`));
      if (!['json', 'text'].includes(responseFormat)) return reject(new ServiceError('INVALID_REQUEST', 'response_format must be json or text.'));
      const wav = Buffer.concat(chunks);
      chunks = [];
      resolve({ wav, responseFormat });
    });
    request.pipe(parser);
  });
}

export function versioned(body) {
  return { version: PROTOCOL_VERSION, ...body };
}
