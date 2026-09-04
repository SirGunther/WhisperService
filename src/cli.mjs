#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createLogger } from './logger.mjs';
import { loadConfig, loadToken, parseExactOrigin, rotateToken, saveConfig, servicePaths } from './config.mjs';
import { DEFAULTS } from './constants.mjs';
import { WorkerClient } from './worker-client.mjs';
import { WhisperService } from './service.mjs';

function usage() {
  console.log(`WhisperService 1.0.0

Commands:
  serve
  configure show
  configure origin add <exact-origin>
  configure origin remove <exact-origin>
  configure origin list
  configure preview <1500-3000>
  token show
  token rotate`);
}

async function configure(args, paths) {
  const config = await loadConfig(paths);
  const [section, action, value] = args;
  if (section === 'show') {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (section === 'origin' && action === 'list') {
    for (const origin of config.allowedOrigins) console.log(origin);
    return;
  }
  if (section === 'origin' && ['add', 'remove'].includes(action) && value) {
    const origin = parseExactOrigin(value);
    const origins = new Set(config.allowedOrigins);
    if (action === 'add') origins.add(origin); else origins.delete(origin);
    config.allowedOrigins = [...origins].sort();
    await saveConfig(config, paths);
    console.log(`Origin ${action === 'add' ? 'registered' : 'removed'}.`);
    return;
  }
  if (section === 'preview' && action) {
    const preview = Number(action);
    if (!Number.isInteger(preview) || preview < DEFAULTS.previewMinMs || preview > DEFAULTS.previewMaxMs) throw new Error('Preview cadence must be an integer from 1500 to 3000 milliseconds.');
    config.speech.previewMs = preview;
    await saveConfig(config, paths);
    console.log(`Default preview cadence set to ${preview} ms.`);
    return;
  }
  usage();
  process.exitCode = 2;
}

export async function main(argv = process.argv.slice(2)) {
  const paths = servicePaths();
  const [command, ...args] = argv;
  if (command === 'token' && args[0] === 'show') {
    console.log(await loadToken(paths));
    return;
  }
  if (command === 'token' && args[0] === 'rotate') {
    console.log(await rotateToken(paths));
    console.error('Token rotated. Update every client before restarting the service.');
    return;
  }
  if (command === 'configure') {
    await configure(args, paths);
    return;
  }
  if (command !== 'serve') {
    usage();
    process.exitCode = 2;
    return;
  }
  const config = await loadConfig(paths);
  const token = await loadToken(paths);
  const logger = createLogger();
  const worker = new WorkerClient({
    workerPath: config.runtime.workerPath,
    modelPath: config.runtime.modelPath,
    modelSha256: config.runtime.modelSha256,
    startupMs: DEFAULTS.workerStartupMs
  });
  const service = new WhisperService({ config, token, worker, tempDirectory: paths.temp, logger });
  let stopping = false;
  const stop = async (reason, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    try { await service.close(reason); } finally { process.exitCode = exitCode; }
  };
  process.once('SIGINT', () => void stop('ctrl_c'));
  process.once('SIGTERM', () => void stop('termination'));
  service.once('fatal', () => void stop('worker_failure', 1));
  await service.start();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`WhisperService startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
