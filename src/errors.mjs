import { PROTOCOL_VERSION } from './constants.mjs';

export const ERROR_STATUS = Object.freeze({
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  ORIGIN_FORBIDDEN: 403,
  NOT_FOUND: 404,
  CAPACITY_EXCEEDED: 429,
  INVALID_AUDIO: 400,
  INVALID_CONFIGURATION: 400,
  INVALID_REQUEST: 400,
  INVALID_TICKET: 401,
  TICKET_EXPIRED: 401,
  SESSION_TIMEOUT: 408,
  WORKER_FAILURE: 503,
  MALFORMED_INFERENCE_OUTPUT: 502,
  SERVICE_NOT_READY: 503,
  INTERNAL_ERROR: 500
});

export class ServiceError extends Error {
  constructor(code, message, details = undefined, status = ERROR_STATUS[code] ?? 500) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}
export function errorEnvelope(error) {
  const safe = error instanceof ServiceError
    ? error
    : new ServiceError('INTERNAL_ERROR', 'The service could not complete the request.');
  return {
    version: PROTOCOL_VERSION,
    error: {
      code: safe.code,
      message: safe.message,
      ...(safe.details === undefined ? {} : { details: safe.details })
    }
  };
}
