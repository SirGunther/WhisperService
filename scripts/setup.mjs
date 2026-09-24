#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeUserFiles, loadConfig, modelIdForConfig, servicePaths } from '../src/config.mjs';
import { MODELS, WHISPER_CPP_TAG } from '../src/constants.mjs';

const WHISPER_CPP_COMMIT = 'f049fff95a089aa9969deb009cdd4892b3e74916';
const REPOSITORY_URL = 'https://github.com/ggml-org/whisper.cpp.git';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', windowsHide: true, ...options.spawn });
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(`${command} exited with code ${code}.`)));
  });
}

async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } }), new Transform({ transform(chunk, encoding, callback) { callback(); } }));
  return hash.digest('hex');
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function findCmake() {
  try { await run('cmake', ['--version'], { capture: true }); return 'cmake'; } catch {}
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (await exists(vswhere)) {
    try {
      const installation = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { capture: true });
      const bundled = join(installation, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe');
      if (await exists(bundled)) return bundled;
    } catch {}
  }
  const standalone = join(process.env.ProgramFiles || 'C:\\Program Files', 'CMake', 'bin', 'cmake.exe');
  if (await exists(standalone)) return standalone;
  throw new Error('CMake 3.20+ is required to build whisper-worker.exe and was not found. Install CMake or the Visual Studio CMake component, open a fresh terminal, and rerun setup.');
}

async function provisionSource(paths) {
  if (!(await exists(join(paths.source, '.git')))) {
    await mkdir(dirname(paths.source), { recursive: true });
    await run('git', ['clone', '--branch', WHISPER_CPP_TAG, '--depth', '1', REPOSITORY_URL, paths.source]);
  }
  const commit = await run('git', ['-C', paths.source, 'rev-parse', 'HEAD'], { capture: true });
  if (commit !== WHISPER_CPP_COMMIT) throw new Error(`whisper.cpp identity mismatch: expected ${WHISPER_CPP_COMMIT}, received ${commit}.`);
}

async function provisionModel(paths, modelId) {
  const entry = MODELS[modelId];
  const modelPath = join(paths.models, entry.file);
  if (await exists(modelPath)) {
    if ((await hashFile(modelPath)).toLowerCase() === entry.sha256) return;
    throw new Error('Existing model does not match the pinned SHA-256; remove it manually before retrying.');
  }
  const temporary = `${modelPath}.download`;
  await mkdir(dirname(modelPath), { recursive: true });
  const response = await fetch(entry.url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Model download failed with HTTP ${response.status}.`);
  const hash = createHash('sha256');
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } }), createWriteStream(temporary, { flags: 'wx' }));
    const actual = hash.digest('hex');
    if (actual !== entry.sha256) throw new Error(`Model SHA-256 mismatch: expected ${entry.sha256}, received ${actual}.`);
    await rename(temporary, modelPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function parseModelArg(argv) {
  const index = argv.indexOf('--model');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || !MODELS[value]) {
    throw new Error(`--model requires one of: ${Object.keys(MODELS).join(', ')}.`);
  }
  return value;
}

export async function resolveModelId(explicitModelId, paths, catalog = MODELS) {
  if (explicitModelId) return explicitModelId;
  const config = await loadConfig(paths);
  return modelIdForConfig(config, catalog);
}

async function buildWorker(paths) {
  const cmake = await findCmake();
  await mkdir(paths.build, { recursive: true });
  await run(cmake, ['-S', join(projectRoot, 'native'), '-B', paths.build, `-DWHISPER_CPP_SOURCE_DIR=${paths.source}`, '-DCMAKE_BUILD_TYPE=Release']);
  await run(cmake, ['--build', paths.build, '--config', 'Release', '--target', 'whisper-worker']);
  const candidates = [
    join(paths.build, 'bin', 'Release', 'whisper-worker.exe'),
    join(paths.build, 'bin', 'whisper-worker.exe'),
    join(paths.build, 'Release', 'whisper-worker.exe'),
    join(paths.build, 'whisper-worker.exe')
  ];
  const built = (await Promise.all(candidates.map(async (candidate) => (await exists(candidate)) ? candidate : null))).find(Boolean);
  if (!built) throw new Error('The native build completed without producing whisper-worker.exe in a recognized output directory.');
  await mkdir(paths.runtime, { recursive: true });
  await copyFile(built, paths.worker);
}

export async function setup({ configOnly = false, skipModel = false, skipBuild = false, modelId } = {}) {
  const paths = await initializeUserFiles(servicePaths());
  console.log('User configuration and credentials are ready.');
  if (configOnly) return paths;
  await provisionSource(paths);
  console.log(`whisper.cpp ${WHISPER_CPP_TAG} identity verified.`);
  if (!skipModel) {
    const resolvedModelId = await resolveModelId(modelId, paths);
    await provisionModel(paths, resolvedModelId);
    console.log(`${MODELS[resolvedModelId].file} identity verified.`);
  }
  if (!skipBuild) {
    await buildWorker(paths);
    console.log('whisper-worker.exe built and installed.');
  }
  return paths;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  Promise.resolve()
    .then(() => parseModelArg(argv))
    .then((modelId) => {
      const args = new Set(argv);
      return setup({ configOnly: args.has('--config-only'), skipModel: args.has('--skip-model'), skipBuild: args.has('--skip-build'), modelId });
    })
    .catch((error) => {
      console.error(`Setup failed: ${error.message}`);
      process.exitCode = 1;
    });
}
