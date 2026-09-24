export const PROTOCOL_VERSION = '1.0.0';
export const SERVICE_VERSION = '1.0.0';
export const HOST = '127.0.0.1';
export const PORT = 8178;
export const SAMPLE_RATE = 16_000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;
export const DEFAULT_MODEL_ID = 'base.en';
export const MODELS = Object.freeze({
  'base.en': Object.freeze({
    file: 'ggml-base.en.bin',
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'
  }),
  'small.en': Object.freeze({
    file: 'ggml-small.en.bin',
    sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin'
  })
});
export const WHISPER_CPP_TAG = 'v1.9.1';

export const DEFAULTS = Object.freeze({
  maxActiveSessions: 4,
  maxUtteranceMs: 10_000,
  minSpeechMs: 160,
  pauseMs: 1_200,
  speechRms: 0.0125,
  silenceRms: 0.008,
  previewMs: 2_000,
  previewMinMs: 1_500,
  previewMaxMs: 3_000,
  ticketTtlMs: 15_000,
  idleSessionMs: 120_000,
  workerStartupMs: 120_000,
  maxFrameBytes: 64_000,
  maxUploadBytes: 20 * 1024 * 1024
});
