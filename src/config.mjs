import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULTS, HOST, MODEL_FILE, MODEL_SHA256, PORT, PROTOCOL_VERSION, WHISPER_CPP_TAG } from './constants.mjs';
import { ServiceError } from './errors.mjs';

export function servicePaths(env = process.env) {
  const root = resolve(env.WHISPER_SERVICE_HOME || join(env.LOCALAPPDATA || '', 'WhisperService'));
  if (!env.WHISPER_SERVICE_HOME && !env.LOCALAPPDATA) {
    throw new ServiceError('INVALID_CONFIGURATION', 'LOCALAPPDATA is unavailable; set WHISPER_SERVICE_HOME explicitly.');
  }
  return Object.freeze({
    root,
    config: join(root, 'config.json'),
    credentials: join(root, 'credentials.json'),
    runtime: join(root, 'runtime'),
    source: join(root, 'source', 'whisper.cpp'),
    build: join(root, 'build'),
    temp: join(root, 'temp'),
    worker: join(root, 'runtime', 'whisper-worker.exe'),
    model: join(root, 'models', MODEL_FILE)
  });
}

export function defaultConfig(paths = servicePaths()) {
  return {
    version: PROTOCOL_VERSION,
    host: HOST,
    port: PORT,
    language: 'en',
    allowedOrigins: [],
    limits: {
      maxActiveSessions: DEFAULTS.maxActiveSessions,
      maxUtteranceMs: DEFAULTS.maxUtteranceMs,
      idleSessionMs: DEFAULTS.idleSessionMs
    },
    speech: {
      minSpeechMs: DEFAULTS.minSpeechMs,
      pauseMs: DEFAULTS.pauseMs,
      speechRms: DEFAULTS.speechRms,
      silenceRms: DEFAULTS.silenceRms,
      previewMs: DEFAULTS.previewMs
    },
    runtime: {
      workerPath: paths.worker,
      modelPath: paths.model,
      modelSha256: MODEL_SHA256,
      whisperCppTag: WHISPER_CPP_TAG
    }
  };
}

export function parseExactOrigin(value) {
  if (typeof value !== 'string' || value === '*' || value.endsWith('/')) {
    throw new ServiceError('INVALID_CONFIGURATION', 'Origins must be exact and cannot use wildcards or trailing slashes.');
  }
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new ServiceError('INVALID_CONFIGURATION', 'Origins must be absolute URLs.'); }
  if (!['http:', 'https:', 'chrome-extension:', 'moz-extension:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new ServiceError('INVALID_CONFIGURATION', 'Origins must use HTTP(S) or a browser-extension scheme and contain no path, credentials, query, or fragment.');
  }
  const normalized = ['chrome-extension:', 'moz-extension:'].includes(parsed.protocol)
    ? `${parsed.protocol}//${parsed.host}`
    : parsed.origin;
  if (normalized !== value) throw new ServiceError('INVALID_CONFIGURATION', `Origin must use its exact normalized form: ${normalized}`);
  return normalized;
}

function exactInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ServiceError('INVALID_CONFIGURATION', `${name} must be an integer from ${min} to ${max}.`);
  }
}

function finiteNumber(value, min, max, name) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ServiceError('INVALID_CONFIGURATION', `${name} must be from ${min} to ${max}.`);
  }
}

export function validateConfig(config) {
  if (!config || config.version !== PROTOCOL_VERSION) {
    throw new ServiceError('INVALID_CONFIGURATION', `Configuration version must be ${PROTOCOL_VERSION}.`);
  }
  if (config.host !== HOST || config.port !== PORT || config.language !== 'en') {
    throw new ServiceError('INVALID_CONFIGURATION', `v1 must use ${HOST}:${PORT} and English.`);
  }
  if (!Array.isArray(config.allowedOrigins)) {
    throw new ServiceError('INVALID_CONFIGURATION', 'allowedOrigins must contain exact, absolute origins and cannot contain wildcards.');
  }
  for (const value of config.allowedOrigins) parseExactOrigin(value);
  if (new Set(config.allowedOrigins).size !== config.allowedOrigins.length) {
    throw new ServiceError('INVALID_CONFIGURATION', 'allowedOrigins cannot contain duplicates.');
  }
  exactInteger(config.limits?.maxActiveSessions, 1, 4, 'limits.maxActiveSessions');
  exactInteger(config.limits?.maxUtteranceMs, 1_000, 10_000, 'limits.maxUtteranceMs');
  exactInteger(config.limits?.idleSessionMs, 15_000, 600_000, 'limits.idleSessionMs');
  exactInteger(config.speech?.minSpeechMs, 40, 2_000, 'speech.minSpeechMs');
  exactInteger(config.speech?.pauseMs, 250, 5_000, 'speech.pauseMs');
  exactInteger(config.speech?.previewMs, DEFAULTS.previewMinMs, DEFAULTS.previewMaxMs, 'speech.previewMs');
  finiteNumber(config.speech?.speechRms, 0.001, 1, 'speech.speechRms');
  finiteNumber(config.speech?.silenceRms, 0, 1, 'speech.silenceRms');
  if (config.speech.silenceRms >= config.speech.speechRms) {
    throw new ServiceError('INVALID_CONFIGURATION', 'speech.silenceRms must be lower than speech.speechRms.');
  }
  if (!config.runtime?.workerPath || !config.runtime?.modelPath || config.runtime?.modelSha256?.toLowerCase() !== MODEL_SHA256 || config.runtime?.whisperCppTag !== WHISPER_CPP_TAG) {
    throw new ServiceError('INVALID_CONFIGURATION', 'Runtime paths and model SHA-256 are required.');
  }
  return config;
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  try { await chmod(path, 0o600); } catch {}
}

export async function hardenCredentials(path, env = process.env) {
  if (process.platform !== 'win32') return;
  const user = env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
  if (!user) throw new ServiceError('INVALID_CONFIGURATION', 'Cannot determine the Windows user for credential permissions.');
  try {
    await promisify(execFile)('icacls.exe', [path, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true });
  } catch {
    throw new ServiceError('INVALID_CONFIGURATION', 'Could not restrict the credentials file to the current Windows user.');
  }
}

export async function initializeUserFiles(paths = servicePaths(), { secureCredentials = true } = {}) {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.runtime, { recursive: true }),
    mkdir(paths.temp, { recursive: true }),
    mkdir(resolve(paths.model, '..'), { recursive: true })
  ]);
  try { await readFile(paths.config); } catch { await atomicJson(paths.config, defaultConfig(paths)); }
  try { await readFile(paths.credentials); } catch {
    await atomicJson(paths.credentials, { version: PROTOCOL_VERSION, token: randomBytes(32).toString('base64url') });
  }
  if (secureCredentials) await hardenCredentials(paths.credentials);
  return paths;
}

export async function loadConfig(paths = servicePaths()) {
  let raw;
  try { raw = await readFile(paths.config, 'utf8'); }
  catch { throw new ServiceError('INVALID_CONFIGURATION', `Configuration is missing. Run npm run setup first.`); }
  try { return validateConfig(JSON.parse(raw)); }
  catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('INVALID_CONFIGURATION', 'Configuration is not valid JSON.');
  }
}

export async function loadToken(paths = servicePaths()) {
  try {
    const value = JSON.parse(await readFile(paths.credentials, 'utf8'));
    if (value.version !== PROTOCOL_VERSION || typeof value.token !== 'string' || value.token.length < 43) throw new Error();
    return value.token;
  } catch {
    throw new ServiceError('INVALID_CONFIGURATION', 'Credentials are missing or invalid. Run npm run setup first.');
  }
}

export async function saveConfig(config, paths = servicePaths()) {
  validateConfig(config);
  await atomicJson(paths.config, config);
}

export async function rotateToken(paths = servicePaths(), { secureCredentials = true } = {}) {
  const token = randomBytes(32).toString('base64url');
  await atomicJson(paths.credentials, { version: PROTOCOL_VERSION, token });
  if (secureCredentials) await hardenCredentials(paths.credentials);
  return token;
}

export function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const left = createHash('sha256').update(candidate).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}
