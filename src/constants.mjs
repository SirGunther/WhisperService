export const PROTOCOL_VERSION = '1.0.0';
export const SERVICE_VERSION = '1.0.0';
export const HOST = '127.0.0.1';
export const PORT = 8178;
export const SAMPLE_RATE = 16_000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;
export const DEFAULT_MODEL_ID = 'base.en';
const MODEL_SOURCE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

function pinnedModel(id, sha256) {
  const file = `ggml-${id}.bin`;
  return Object.freeze({ file, sha256, url: `${MODEL_SOURCE}/${file}` });
}

// SHA-256 values are the Git LFS object ids published for each file in ggerganov/whisper.cpp.
export const MODELS = Object.freeze({
  'tiny.en': pinnedModel('tiny.en', '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f'),
  'base.en': pinnedModel('base.en', 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002'),
  'small.en': pinnedModel('small.en', 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d'),
  'medium.en': pinnedModel('medium.en', 'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356'),
  'large-v1': pinnedModel('large-v1', '7d99f41a10525d0206bddadd86760181fa920438b6b33237e3118ff6c83bb53d'),
  'large-v2': pinnedModel('large-v2', '9a423fe4d40c82774b6af34115b8b935f34152246eb19e80e376071d3f999487'),
  'large-v3': pinnedModel('large-v3', '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2'),
  'large-v3-turbo': pinnedModel('large-v3-turbo', '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69')
});
export const DEVICES = Object.freeze(['auto', 'cpu', 'gpu']);
export const DEFAULT_DEVICE = 'auto';
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
