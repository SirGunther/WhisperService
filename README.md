# WhisperService

WhisperService is a private, manually started Windows transcription server for SaySlate and other local applications. A Node 22 gateway owns authentication, exact-origin CORS, WebSockets, audio/VAD state, and scheduling. A dedicated native worker owns one CPU-only English Whisper model — `base.en` by default, or `small.en` (see [Change the model](#change-the-model)) — for the life of the server.

The model is loaded once per server process—not once per dictation. Every inference creates and destroys a fresh native `whisper_state`, uses `no_context`, supplies no prompt, and receives isolated audio. Closing a session deletes its buffered audio, transcript state, revisions, and temporary WAV files while leaving only the model weights resident.

## Requirements

- Windows 10/11
- Node.js 22 or newer
- Git
- CMake 3.20 or newer
- Visual Studio 2022 Build Tools with Desktop development with C++

No Argus installation or files are used.

## Setup

From PowerShell:

```powershell
npm ci
npm run setup
```

Setup is idempotent. It creates `%LOCALAPPDATA%\WhisperService`, generates a 256-bit token, restricts the credentials file to the current Windows user, checks out whisper.cpp `v1.9.1` at commit `f049fff95a089aa9969deb009cdd4892b3e74916`, downloads and verifies by SHA-256 whichever model is selected (`ggml-base.en.bin` by default), and builds `whisper-worker.exe`.

Pass `--model <id>` (`base.en` or `small.en`) to install a specific catalog model regardless of the current selection. For configuration-only development setup, use `node scripts/setup.mjs --config-only`. `--skip-model` and `--skip-build` are also available for CI/toolchain work.

### Change the model

Install the other model, switch to it, then restart:

```powershell
npm run setup -- --model small.en --skip-build
npm run configure -- model small.en
```

Go back the same way:

```powershell
npm run configure -- model base.en
```

Restart WhisperService after either switch to load the newly selected model. To keep only one model installed, delete the other file from `%LOCALAPPDATA%\WhisperService\models`.

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

## Manual operation

```powershell
npm start
```

The gateway listens only on `127.0.0.1:8178`. Windows Firewall should not need an inbound rule for loopback traffic; do not create a public rule. Press `Ctrl+C` for graceful shutdown. If the worker exits or model loading, asset verification, configuration validation, or port binding fails, the gateway closes its sessions and exits with an explicit error. Restart remains manual.

The default preview interval is 2,000 ms. Override it globally or per session within 1,500–3,000 ms:

```powershell
node src/cli.mjs configure preview 2500
```

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
```

Normal tests use a deterministic fake worker. Windows CI runs those tests and compiles the native worker without downloading the model. The real smoke test creates a known English WAV with Windows speech synthesis if necessary, starts the actual service, transcribes it in two isolated sessions, and confirms the model emitted exactly one readiness initialization.

## Data and logs

At most four sessions can exist. Utterances roll over at ten seconds. Defaults are 160 ms minimum speech, 1,200 ms finalizing silence, 0.0125 speech RMS, and 0.008 silence RMS. All native inference is globally serialized.

Logs contain lifecycle IDs, durations, byte counts, queue timing, and error codes only. They never contain bearer tokens, audio bytes, transcript text, temporary paths, or earlier-session content.

## Deliberate v1 exclusions

There is no Windows service, startup task, tray application, UI, GPU tuning, language other than English, public bind, SaySlate code, or LM Studio integration in this repository.
