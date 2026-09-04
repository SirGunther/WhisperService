import { BITS_PER_SAMPLE, CHANNELS, SAMPLE_RATE } from './constants.mjs';
import { ServiceError } from './errors.mjs';

export function validatePcm16(buffer, maxBytes = Infinity) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length % 2 !== 0 || buffer.length > maxBytes) {
    throw new ServiceError('INVALID_AUDIO', 'Audio frames must be non-empty PCM16 little-endian data within the size limit.');
  }
  return buffer;
}
export function pcmDurationMs(buffer) {
  return (buffer.length / 2 / SAMPLE_RATE) * 1_000;
}

export function pcmRms(buffer) {
  validatePcm16(buffer);
  let sum = 0;
  const samples = buffer.length / 2;
  for (let offset = 0; offset < buffer.length; offset += 2) {
    const normalized = buffer.readInt16LE(offset) / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples);
}

export function encodeWav(pcm) {
  validatePcm16(pcm);
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function decodeWav(wav, maxBytes = Infinity) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.length > maxBytes || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new ServiceError('INVALID_AUDIO', 'Upload must be a valid WAV file.');
  }
  let offset = 12;
  let format;
  let pcm;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) throw new ServiceError('INVALID_AUDIO', 'WAV chunk length is invalid.');
    if (id === 'fmt ' && size >= 16) {
      format = {
        encoding: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14)
      };
    } else if (id === 'data') {
      pcm = wav.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  if (!format || format.encoding !== 1 || format.channels !== CHANNELS || format.sampleRate !== SAMPLE_RATE || format.bits !== BITS_PER_SAMPLE || !pcm?.length || pcm.length % 2) {
    throw new ServiceError('INVALID_AUDIO', 'WAV must contain PCM16 little-endian, 16 kHz, mono audio.');
  }
  return Buffer.from(pcm);
}

export function makeTonePcm(durationMs, rms = 0.05, frequency = 440) {
  const count = Math.round((durationMs / 1_000) * SAMPLE_RATE);
  const output = Buffer.alloc(count * 2);
  const amplitude = Math.min(0.9, rms * Math.SQRT2) * 32767;
  for (let index = 0; index < count; index += 1) {
    output.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE)), index * 2);
  }
  return output;
}

export function makeSilencePcm(durationMs) {
  return Buffer.alloc(Math.round((durationMs / 1_000) * SAMPLE_RATE) * 2);
}
