# WhisperService

WhisperService is a private, manually started Windows transcription server for SaySlate and other local applications. A Node 22 gateway owns authentication, exact-origin CORS, WebSockets, audio/VAD state, and scheduling. A dedicated native worker owns one English Whisper model — `base.en` by default, or any other catalog model (see [Choose the model](#choose-the-model)) — for the life of the server. It runs on the GPU when there is one and on the CPU otherwise, with nothing to configure (see [GPU](#gpu)).

The model is loaded once per server process—not once per dictation. Every inference creates and destroys a fresh native `whisper_state`, uses `no_context`, supplies no prompt, and receives isolated audio. Closing a session deletes its buffered audio, transcript state, revisions, and temporary WAV files while leaving only the model weights resident.

## Requirements

- Windows 10/11
- Node.js 22 or newer
- Git
- CMake 3.20 or newer
- Visual Studio 2022 Build Tools with Desktop development with C++
- Optional, for GPU inference: the [Vulkan SDK](https://vulkan.lunarg.com/sdk/home) (`winget install --id KhronosGroup.VulkanSDK -e`) and a graphics driver with Vulkan 1.2 or newer

No Argus installation or files are used.

## Setup

From PowerShell:

```powershell
npm ci
npm run setup
```

Setup is idempotent. It creates `%LOCALAPPDATA%\WhisperService`, generates a 256-bit token, restricts the credentials file to the current Windows user, checks out whisper.cpp `v1.9.1` at commit `f049fff95a089aa9969deb009cdd4892b3e74916`, downloads and verifies by SHA-256 whichever model is selected (`ggml-base.en.bin` by default), and builds `whisper-worker.exe`. When `VULKAN_SDK` is set (the Vulkan SDK installer sets it; open a fresh terminal afterwards), the worker is built with ggml's Vulkan GPU backend; otherwise it is CPU-only. Setup prints which one it built.

Pass `--model <id>` to install a specific catalog model regardless of the current selection. For configuration-only development setup, use `node scripts/setup.mjs --config-only`. `--skip-model` and `--skip-build` are also available for CI/toolchain work, and `--cpu-only` builds a CPU-only worker even when the Vulkan SDK is installed.

Register each browser origin exactly. SaySlate will use its actual extension origin:

```powershell
node src/cli.mjs configure origin add chrome-extension://EXTENSION_ID
node src/cli.mjs configure origin list
```

HTTP development origins such as `http://localhost:3000` are supported. Paths, wildcards, and trailing slashes are rejected.

Show the token only when configuring a client, or rotate it explicitly:

```powershell
npm run token:show
npm run token:rotate
```

Normal startup never prints the token.

### Choose the model

Name the model when you start the service:

```powershell
npm start large-v3-turbo
```

If the model isn't installed yet, it is downloaded and verified by SHA-256 first. The choice is remembered, so a plain `npm start` keeps using it until you name another one. To go back, run `npm start base.en`. Stop the running service (`Ctrl+C`) before starting it with a different model.

| Model | Download |
| --- | --- |
| `tiny.en` | 78 MB |
| `base.en` (default) | 148 MB |
| `small.en` | 488 MB |
| `medium.en` | 1.5 GB |
| `large-v1`, `large-v2`, `large-v3` | 3.1 GB each |
| `large-v3-turbo` | 1.6 GB |

`base.en` keeps up on any recent CPU. A GPU lets the bigger models run, but a bigger model makes text arrive later. Measured on a GTX 1080 Ti with a 1,500 ms preview interval, from when you stop talking until the whole phrase is on screen, then until the final:

| Model | Phrase on screen | Final |
| --- | --- | --- |
| `base.en` on the CPU | 1.7 s | 2.4 s |
| `small.en` | 1.3 s | 1.8 s |
| `medium.en` | 2.0 s | 3.0 s |
| `large-v3-turbo` | 2.5 s | 4.0 s |

Run `npm run smoke:models` to measure your own machine. The `large-*` models are multilingual, but WhisperService still forces English. To free space, delete unused files from `%LOCALAPPDATA%\WhisperService\models`.

### GPU

There is nothing to set. If the [Vulkan SDK](https://vulkan.lunarg.com/sdk/home) is installed when you run `npm run setup`, the worker is built with GPU support. At startup it uses the GPU if it finds one, and the CPU if it doesn't. If the model fails to load on the GPU, it loads on the CPU instead. On a machine with no GPU, or without the SDK, everything runs on the CPU. The startup line says which one it's using:

```text
WhisperService is ready: large-v3-turbo on the GPU (Vulkan0 NVIDIA GeForce GTX 1080 Ti), at http://127.0.0.1:8178. Press Ctrl+C to stop.
```

To keep the GPU free for one run, start with `$env:GGML_DISABLE_VULKAN = 1; npm start`.

### Compare models

```powershell
npm run smoke:models
```

This runs each installed model through the native worker directly, so it works while the service is running. By default, it runs every installed model on the device the service would use. Add `--devices cpu,gpu` to run each model on both. Each model gets one warm-up job and then three timed runs of a 10-second synthetic English utterance (one full utterance, the longest a single inference sees). It prints a table with the device each row actually ran on, load time, first-job time (which includes the GPU's one-time shader compile), median time for the clip, state setup time, real-time factor, word error rate against the known text, and a verdict:

- **keeps up**: at most 2,000 ms, which is the default preview cadence and leaves room for two inferences inside SaySlate's 4-second Stop window;
- **tight**: at most 4,000 ms;
- **too slow**: longer than that;
- **failed**: with the reason, such as a model that is not installed. The run continues with the next row.

Options: `--models medium.en,large-v3`, `--devices cpu,gpu` (every chosen model on each device), `--runs 5`, `--worker <path-to-exe>`, `--json`, and a WAV path with `--expect "<what it says>"` to time your own 16 kHz mono PCM16 recording.

## Manual operation

```powershell
npm start
npm start <model>
```

The first form starts with the model used last; the second switches first (see [Choose the model](#choose-the-model)). The gateway listens only on `127.0.0.1:8178`. Windows Firewall should not need an inbound rule for loopback traffic; do not create a public rule. Press `Ctrl+C` for graceful shutdown. If the worker exits or model loading, asset verification, configuration validation, or port binding fails, the gateway closes its sessions and exits with an explicit error. Restart remains manual.

The default preview interval is 2,000 ms. Override it globally or per session within 1,500–3,000 ms:

```powershell
node src/cli.mjs configure preview 2500
```

A preview can't come back sooner than the model takes to run. Whisper always processes a fixed 30-second window, so a short preview costs about as much as a full 10-second utterance. On a GTX 1080 Ti, `large-v3-turbo` took 1,397 ms on a 3-second clip and 1,341 ms on a 10-second one. With the large models, a 1,500 ms interval is already about as fast as previews can arrive.

## API and clients

- `GET /v1/health`
- `POST /v1/sessions`
- `WS /v1/sessions/{id}/stream`
- `DELETE /v1/sessions/{id}`
- `POST /v1/audio/transcriptions`

Every HTTP request uses `Authorization: Bearer <token>`. See [protocol documentation](docs/protocol.md), [OpenAPI](contracts/openapi.yaml), and [JSON Schemas](contracts/schemas/).

Dependency-light clients are in [browser.mjs](clients/browser.mjs) and [node.mjs](clients/node.mjs):

```js
import { WhisperServiceClient } from './clients/node.mjs';

const client = new WhisperServiceClient({ token: process.env.WHISPER_SERVICE_TOKEN });
const health = await client.health();
const session = await client.createSession({
  previewMs: 2000,
  onEvent: (event) => console.log(event.type)
});
session.sendPcm16(pcmBuffer);
session.stop();
```

Client connection failures use the stable `OFFLINE` code. The service never silently falls back to another transcription provider.

## Verification

```powershell
npm test
npm audit --audit-level=high
npm run smoke
npm run smoke:models
```

Normal tests use a deterministic fake worker. Windows CI runs those tests and compiles the CPU-only native worker without downloading the model; the Vulkan build is verified locally. The real smoke test creates a known English WAV with Windows speech synthesis if necessary, starts the actual service, transcribes it in two isolated sessions, and confirms the model emitted exactly one readiness initialization.

## Data and logs

At most four sessions can exist. Utterances roll over at ten seconds. Defaults are 160 ms minimum speech, 1,200 ms finalizing silence, 0.0125 speech RMS, and 0.008 silence RMS. All native inference is globally serialized.

Logs contain lifecycle IDs, durations, byte counts, queue timing, and error codes only. They never contain bearer tokens, audio bytes, transcript text, temporary paths, or earlier-session content.

## Deliberate v1 exclusions

There is no Windows service, startup task, tray application, UI, GPU backend other than Vulkan, multi-GPU selection, language other than English, public bind, SaySlate code, or LM Studio integration in this repository.
