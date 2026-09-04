import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../src/logger.mjs';
import { defaultConfig, initializeUserFiles, loadToken, parseExactOrigin, rotateToken, servicePaths, tokenMatches, validateConfig } from '../src/config.mjs';

test('default configuration preserves the approved bounds', () => {
  const paths = servicePaths({ WHISPER_SERVICE_HOME: join(tmpdir(), 'whisper-config') });
  const config = validateConfig(defaultConfig(paths));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8178);
  assert.equal(config.speech.minSpeechMs, 160);
  assert.equal(config.speech.pauseMs, 1200);
  assert.equal(config.speech.speechRms, 0.0125);
  assert.equal(config.speech.silenceRms, 0.008);
  assert.equal(config.speech.previewMs, 2000);
  assert.equal(config.limits.maxActiveSessions, 4);
  assert.equal(config.limits.maxUtteranceMs, 10000);
});

test('configuration rejects unsafe origins and out-of-range previews', () => {
  assert.equal(parseExactOrigin('chrome-extension://abcdefghijklmnop'), 'chrome-extension://abcdefghijklmnop');
  assert.equal(parseExactOrigin('http://localhost:3000'), 'http://localhost:3000');
  for (const origin of ['*', 'https://example.com/', 'https://example.com/path', 'file:///tmp/index.html']) {
    assert.throws(() => parseExactOrigin(origin));
  }
  const config = defaultConfig(servicePaths({ WHISPER_SERVICE_HOME: join(tmpdir(), 'whisper-config') }));
  config.speech.previewMs = 1499;
  assert.throws(() => validateConfig(config), /1500/);
});

test('setup is idempotent and token rotation changes the credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-service-config-'));
  const paths = servicePaths({ WHISPER_SERVICE_HOME: root });
  try {
    await initializeUserFiles(paths, { secureCredentials: false });
    const first = await loadToken(paths);
    await initializeUserFiles(paths, { secureCredentials: false });
    assert.equal(await loadToken(paths), first);
    const second = await rotateToken(paths, { secureCredentials: false });
    assert.notEqual(second, first);
    assert(tokenMatches(second, await loadToken(paths)));
    const credentials = JSON.parse(await readFile(paths.credentials, 'utf8'));
    assert.equal(credentials.token, second);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('logger allowlist cannot leak tokens, transcript text, audio, or paths', () => {
  const output = [];
  const logger = createLogger({ log: (line) => output.push(line), error: (line) => output.push(line) });
  logger.info('safe', { token: 'secret-token', text: 'private transcript', audio: 'bytes', path: 'private.wav', sessionId: 'session' });
  assert.equal(output.length, 1);
  assert(!output[0].includes('secret-token'));
  assert(!output[0].includes('private transcript'));
  assert(!output[0].includes('private.wav'));
  assert.match(output[0], /session/);
});
