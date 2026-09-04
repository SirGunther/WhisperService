import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeSilencePcm, makeTonePcm } from '../src/audio.mjs';
import { SessionManager } from '../src/session-manager.mjs';
import { FakeSocket, FakeWorker, silentLogger, testConfig, until } from './helpers.mjs';

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'whisper-session-'));
  const worker = new FakeWorker(options);
  const manager = new SessionManager({ config: testConfig(root), worker, tempDirectory: root, logger: silentLogger() });
  return { root, worker, manager, close: async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

function connected(manager, options) {
  const created = manager.create(options);
  manager.consumeTicket(created.id, created.ticket);
  const ws = new FakeSocket();
  manager.attach(created.id, ws);
  return { ...created, ws };
}

test('one-time tickets, capacity, and cancellation are explicit', async () => {
  const state = await fixture();
  try {
    const sessions = Array.from({ length: 4 }, () => connected(state.manager));
    assert.throws(() => state.manager.create(), (error) => error.code === 'CAPACITY_EXCEEDED');
    assert.throws(() => state.manager.consumeTicket(sessions[0].id, sessions[0].ticket), (error) => error.code === 'INVALID_TICKET');
    state.manager.cancel(sessions[0].id, 'cancel');
    assert.equal(sessions[0].ws.events.some((item) => item.type.startsWith('transcript.')), false);
    assert.equal(sessions[0].ws.events.at(-1).type, 'session.closed');
  } finally { await state.close(); }
});

test('expired tickets and idle sessions close without a transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-expiry-'));
  const config = testConfig(root);
  config.limits.idleSessionMs = 20;
  let now = 0;
  const manager = new SessionManager({ config, worker: new FakeWorker(), tempDirectory: root, logger: silentLogger(), now: () => now });
  try {
    const expired = manager.create();
    now = 16_000;
    assert.throws(() => manager.consumeTicket(expired.id, expired.ticket), (error) => error.code === 'TICKET_EXPIRED');
    const active = connected(manager);
    await until(() => active.ws.events.some((item) => item.type === 'session.closed'));
    assert.equal(active.ws.events.find((item) => item.type === 'error').code, 'SESSION_TIMEOUT');
    assert.equal(active.ws.events.some((item) => item.type.startsWith('transcript.')), false);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('preview cadence, pause finalization, and cleanup work together', async () => {
  const state = await fixture({ delayMs: 10 });
  try {
    const session = connected(state.manager, { previewMs: 1500 });
    state.manager.acceptAudio(session.id, makeTonePcm(1600, 0.05));
    await until(() => session.ws.events.some((item) => item.type === 'transcript.partial'));
    state.manager.acceptAudio(session.id, makeSilencePcm(1200));
    await until(() => session.ws.events.some((item) => item.type === 'transcript.final'));
    const partial = session.ws.events.find((item) => item.type === 'transcript.partial');
    const final = session.ws.events.find((item) => item.type === 'transcript.final');
    assert.equal(partial.utteranceId, final.utteranceId);
    assert.equal(final.finalizationReason, 'pause');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert((await readdir(state.root)).every((name) => !name.endsWith('.wav')));
  } finally { await state.close(); }
});

test('stop is immediate, empty audio is explicit, and ten seconds rolls over', async () => {
  const state = await fixture();
  try {
    const stopped = connected(state.manager);
    state.manager.acceptAudio(stopped.id, makeTonePcm(200, 0.05));
    await state.manager.control(stopped.id, { version: '1.0.0', type: 'stop' });
    assert.equal(stopped.ws.events.find((item) => item.type === 'transcript.final').finalizationReason, 'stop');
    assert.equal(stopped.ws.events.at(-1).type, 'session.closed');

    const empty = connected(state.manager);
    state.manager.acceptAudio(empty.id, makeSilencePcm(200));
    await state.manager.control(empty.id, { version: '1.0.0', type: 'flush' });
    assert.equal(empty.ws.events.find((item) => item.type === 'transcript.empty').finalizationReason, 'flush');

    const rollover = connected(state.manager, { previewMs: 3000 });
    for (let index = 0; index < 5; index += 1) state.manager.acceptAudio(rollover.id, makeTonePcm(2000, 0.05));
    await until(() => rollover.ws.events.some((item) => item.type === 'transcript.final' && item.finalizationReason === 'rollover'));
  } finally { await state.close(); }
});

test('rollover splits a frame at the exact ten-second boundary', async () => {
  const state = await fixture();
  try {
    const session = connected(state.manager, { previewMs: 3000 });
    state.manager.acceptAudio(session.id, makeTonePcm(1500, 0.05));
    for (let index = 0; index < 4; index += 1) state.manager.acceptAudio(session.id, makeTonePcm(2000, 0.05));
    state.manager.acceptAudio(session.id, makeTonePcm(2000, 0.05));
    await until(() => session.ws.events.some((item) => item.type === 'transcript.final' && item.finalizationReason === 'rollover'));
    assert(state.worker.calls.some((call) => call.bytes === 320_000));
    await state.manager.control(session.id, { version: '1.0.0', type: 'stop' });
  } finally { await state.close(); }
});

test('concurrent sessions are isolated while inference is globally serialized', async () => {
  const state = await fixture({ delayMs: 20 });
  try {
    const first = connected(state.manager);
    const second = connected(state.manager);
    const left = makeTonePcm(200, 0.05, 220); left.writeInt16LE(111, 0);
    const right = makeTonePcm(200, 0.05, 880); right.writeInt16LE(222, 0);
    state.manager.acceptAudio(first.id, left);
    state.manager.acceptAudio(second.id, right);
    await Promise.all([
      state.manager.control(first.id, { version: '1.0.0', type: 'flush' }),
      state.manager.control(second.id, { version: '1.0.0', type: 'flush' })
    ]);
    const firstFinal = first.ws.events.find((item) => item.type === 'transcript.final');
    const secondFinal = second.ws.events.find((item) => item.type === 'transcript.final');
    assert.match(firstFinal.text, /111$/);
    assert.match(secondFinal.text, /222$/);
    assert.notEqual(firstFinal.sessionId, secondFinal.sessionId);
    assert.notEqual(firstFinal.utteranceId, secondFinal.utteranceId);
    assert.equal(state.worker.maxConcurrent, 1);
  } finally { await state.close(); }
});

test('a final suppresses an in-flight stale preview', async () => {
  const state = await fixture({ delayMs: 50 });
  try {
    const session = connected(state.manager, { previewMs: 1500 });
    state.manager.acceptAudio(session.id, makeTonePcm(1600, 0.05));
    state.manager.acceptAudio(session.id, makeTonePcm(1400, 0.05));
    await state.manager.control(session.id, { version: '1.0.0', type: 'stop' });
    assert.equal(session.ws.events.some((item) => item.type === 'transcript.partial'), false);
    assert.equal(session.ws.events.filter((item) => item.type === 'transcript.final').length, 1);
  } finally { await state.close(); }
});

test('malformed audio and malformed inference produce stable errors and clean temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-errors-'));
  const worker = new FakeWorker();
  worker.transcribe = async () => ({ unexpected: true });
  const manager = new SessionManager({ config: testConfig(root), worker, tempDirectory: root, logger: silentLogger() });
  try {
    const session = connected(manager);
    manager.acceptAudio(session.id, Buffer.alloc(3));
    assert.equal(session.ws.events.find((item) => item.type === 'error').code, 'INVALID_AUDIO');
    manager.acceptAudio(session.id, makeTonePcm(200, 0.05));
    await manager.control(session.id, { version: '1.0.0', type: 'stop' });
    assert.equal(session.ws.events.find((item) => item.type === 'error' && item.code === 'MALFORMED_INFERENCE_OUTPUT').code, 'MALFORMED_INFERENCE_OUTPUT');
    assert((await readdir(root)).every((name) => !name.endsWith('.wav')));
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
