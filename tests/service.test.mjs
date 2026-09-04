import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeWav, makeTonePcm } from '../src/audio.mjs';
import { WhisperService } from '../src/service.mjs';
import { WhisperServiceClient } from '../clients/node.mjs';
import { FakeWorker, silentLogger, testConfig, until } from './helpers.mjs';

test('HTTP and WebSocket contracts enforce auth, exact CORS, and explicit streaming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-http-'));
  const config = testConfig(root);
  config.allowedOrigins = ['http://localhost:3000'];
  const token = 'test-token-that-is-long-enough-for-http-only';
  const worker = new FakeWorker();
  const service = new WhisperService({ config, token, worker, tempDirectory: root, logger: silentLogger() });
  try {
    await service.start({ startWorker: false });
    let response = await fetch('http://127.0.0.1:8178/v1/health');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'AUTH_REQUIRED');

    response = await fetch('http://127.0.0.1:8178/v1/health', { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'AUTH_INVALID');

    response = await fetch('http://127.0.0.1:8178/v1/health', { headers: { Authorization: `Bearer ${token}`, Origin: 'http://evil.example' } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'ORIGIN_FORBIDDEN');

    response = await fetch('http://127.0.0.1:8178/v1/health', { headers: { Authorization: `Bearer ${token}`, Origin: 'http://localhost:3000' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const health = await response.json();
    assert.equal(health.ready, true);
    assert.equal(health.protocolVersion, '1.0.0');
    assert.equal(health.language, 'en');

    const client = new WhisperServiceClient({ token });
    const events = [];
    const session = await client.createSession({ previewMs: 1500, onEvent: (event) => events.push(event) });
    session.sendPcm16(makeTonePcm(200, 0.05));
    session.stop();
    await until(() => events.some((event) => event.type === 'session.closed'));
    assert.equal(events.find((event) => event.type === 'transcript.final').finalizationReason, 'stop');

    const text = await client.transcribeWav(encodeWav(makeTonePcm(200, 0.05)), { responseFormat: 'text' });
    assert.match(text, /^local transcript/);
    assert.equal(worker.maxConcurrent, 1);

    const fatal = once(service, 'fatal');
    worker.fail(Object.assign(new Error('worker exited'), { code: 'WORKER_FAILURE' }));
    await fatal;
    await assert.rejects(() => client.health(), (error) => error.code === 'OFFLINE');
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
