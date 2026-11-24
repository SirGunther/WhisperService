import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig, modelIdForConfig, saveConfig } from './config.mjs';
import { MODELS } from './constants.mjs';
import { ServiceError } from './errors.mjs';
import { sha256 } from './worker-client.mjs';

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

export function modelEntry(modelId, catalog = MODELS) {
  const entry = catalog[modelId];
  if (!entry) throw new ServiceError('INVALID_CONFIGURATION', `Unknown model ${modelId}. Valid ids: ${Object.keys(catalog).join(', ')}.`);
  return entry;
}

// Downloads a catalog model into modelsDir and verifies it against its pinned SHA-256. A file that is already
// installed is only verified. Returns true when it downloaded, false when a verified copy was already there.
export async function installModel(modelsDir, modelId, { catalog = MODELS, fetchImpl = fetch, onProgress } = {}) {
  const entry = modelEntry(modelId, catalog);
  const modelPath = join(modelsDir, entry.file);
  if (await exists(modelPath)) {
    if ((await sha256(modelPath)).toLowerCase() === entry.sha256.toLowerCase()) return false;
    throw new ServiceError('INVALID_CONFIGURATION', `${modelPath} does not match the pinned SHA-256 for ${modelId}. Delete it and try again.`);
  }
  await mkdir(modelsDir, { recursive: true });
  const response = await fetchImpl(entry.url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new ServiceError('INVALID_CONFIGURATION', `Downloading ${modelId} failed with HTTP ${response.status}.`);
  const total = Number(response.headers.get('content-length')) || null;
  const temporary = `${modelPath}.download`;
  const hash = createHash('sha256');
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, encoding, callback) {
          hash.update(chunk);
          received += chunk.length;
          onProgress?.({ received, total });
          callback(null, chunk);
        }
      }),
      createWriteStream(temporary, { flags: 'wx' })
    );
    const actual = hash.digest('hex');
    if (actual !== entry.sha256.toLowerCase()) throw new ServiceError('INVALID_CONFIGURATION', `The ${modelId} download does not match its pinned SHA-256 (received ${actual}).`);
    await rename(temporary, modelPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return true;
}

export function progressPrinter(stream = process.stdout) {
  let lastPercent = -1;
  return ({ received, total }) => {
    if (!stream.isTTY) return;
    const megabytes = (bytes) => Math.round(bytes / 1_048_576).toLocaleString('en-US');
    if (total) {
      const percent = Math.floor((received / total) * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      stream.write(`\r  ${megabytes(received)} of ${megabytes(total)} MB (${percent}%)`);
    } else {
      stream.write(`\r  ${megabytes(received)} MB`);
    }
  };
}

// Makes sure the model WhisperService is about to run is installed, switching to requestedId first when one is
// given. A switch is saved, so a plain start afterwards keeps using it. Nothing is saved if the download fails.
export async function prepareModel(paths, requestedId, { install = installModel, log = console.log } = {}) {
  const config = await loadConfig(paths);
  const currentId = modelIdForConfig(config);
  const modelId = requestedId ?? currentId;
  const entry = modelEntry(modelId);
  const modelPath = join(paths.models, entry.file);
  const switching = modelId !== currentId;
  const missing = !(await exists(modelPath));
  if (switching || missing) {
    if (missing) log(`${modelId} is not installed yet. Downloading and verifying it...`);
    const printer = progressPrinter();
    const downloaded = await install(paths.models, modelId, { onProgress: printer });
    if (downloaded && process.stdout.isTTY) process.stdout.write('\n');
    if (downloaded) log(`${modelId} downloaded and verified.`);
  }
  if (!switching) return { config, modelId, switched: false };
  const updated = { ...config, runtime: { ...config.runtime, modelPath, modelSha256: entry.sha256 } };
  await saveConfig(updated, paths);
  log(`Switched to ${modelId}. A plain npm start will keep using it.`);
  return { config: updated, modelId, switched: true };
}
