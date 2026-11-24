#!/usr/bin/env node
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeUserFiles, loadConfig, modelIdForConfig, servicePaths } from '../src/config.mjs';
import { MODELS, WHISPER_CPP_TAG } from '../src/constants.mjs';
import { installModel, progressPrinter } from '../src/models.mjs';

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

// GGML_VULKAN is always passed explicitly so a reused build directory never keeps a stale backend choice.
export function cmakeConfigureArgs({ sourceDir, buildDir, nativeDir = join(projectRoot, 'native'), vulkanSdk, cpuOnly = false }) {
  const vulkan = Boolean(vulkanSdk) && !cpuOnly;
  return {
    vulkan,
    args: ['-S', nativeDir, '-B', buildDir, `-DWHISPER_CPP_SOURCE_DIR=${sourceDir}`, '-DCMAKE_BUILD_TYPE=Release', `-DGGML_VULKAN=${vulkan ? 'ON' : 'OFF'}`]
  };
}

async function buildWorker(paths, { cpuOnly = false } = {}) {
  const cmake = await findCmake();
  await mkdir(paths.build, { recursive: true });
  const configure = cmakeConfigureArgs({ sourceDir: paths.source, buildDir: paths.build, vulkanSdk: process.env.VULKAN_SDK, cpuOnly });
  console.log(configure.vulkan
    ? `Building whisper-worker.exe with the Vulkan GPU backend (VULKAN_SDK=${process.env.VULKAN_SDK}).`
    : `Building a CPU-only whisper-worker.exe (${cpuOnly ? '--cpu-only' : 'VULKAN_SDK is not set'}).`);
  await run(cmake, configure.args);
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

export async function setup({ configOnly = false, skipModel = false, skipBuild = false, cpuOnly = false, modelId } = {}) {
  const paths = await initializeUserFiles(servicePaths());
  console.log('User configuration and credentials are ready.');
  if (configOnly) return paths;
  await provisionSource(paths);
  console.log(`whisper.cpp ${WHISPER_CPP_TAG} identity verified.`);
  if (!skipModel) {
    const resolvedModelId = await resolveModelId(modelId, paths);
    if (await installModel(paths.models, resolvedModelId, { onProgress: progressPrinter() }) && process.stdout.isTTY) process.stdout.write('\n');
    console.log(`${MODELS[resolvedModelId].file} identity verified.`);
  }
  if (!skipBuild) {
    await buildWorker(paths, { cpuOnly });
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
      return setup({ configOnly: args.has('--config-only'), skipModel: args.has('--skip-model'), skipBuild: args.has('--skip-build'), cpuOnly: args.has('--cpu-only'), modelId });
    })
    .catch((error) => {
      console.error(`Setup failed: ${error.message}`);
      process.exitCode = 1;
    });
}
