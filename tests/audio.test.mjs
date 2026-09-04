import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav, encodeWav, makeSilencePcm, makeTonePcm, pcmDurationMs, pcmRms, validatePcm16 } from '../src/audio.mjs';

test('PCM and WAV helpers enforce PCM16 16 kHz mono', () => {
  const pcm = makeTonePcm(200, 0.05);
  assert.equal(Math.round(pcmDurationMs(pcm)), 200);
  assert(pcmRms(pcm) > 0.04);
  assert.deepEqual(decodeWav(encodeWav(pcm)), pcm);
  assert.throws(() => validatePcm16(Buffer.alloc(3)), /PCM16/);
  const wrongRate = encodeWav(pcm);
  wrongRate.writeUInt32LE(8000, 24);
  assert.throws(() => decodeWav(wrongRate), /16 kHz/);
  assert.equal(pcmRms(makeSilencePcm(100)), 0);
});
