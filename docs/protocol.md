# Protocol 1.0.0

The authoritative HTTP description is [OpenAPI](../contracts/openapi.yaml), with request, response, event, error, and configuration definitions in [JSON Schemas](../contracts/schemas/).

Every HTTP API operation requires a bearer token. Browser CORS preflight (`OPTIONS`) is the sole transport-level exception because browsers cannot attach the operation's bearer header to a preflight request; it grants no API access and is returned only for an exact registered origin.

Streaming begins with authenticated `POST /v1/sessions`. The response contains a ticket that expires after 15 seconds and becomes invalid on its first WebSocket upgrade attempt. Connect to the returned `streamUrl` with `?ticket=...` and then send only binary PCM16 little-endian, 16 kHz, mono frames.

Client text controls are:

```json
{"version":"1.0.0","type":"flush"}
```

Replace `flush` with `stop` to finalize and close, or `cancel` to erase and close without emitting a transcript. Server messages use `session.ready`, `transcript.partial`, `transcript.final`, `transcript.empty`, `error`, and `session.closed`. A client replaces a partial only when its `utteranceId` matches and its `revision` is higher. A final replaces every partial for that utterance.

The worker is a separate private process using stdio. Its model is loaded exactly once at startup without a default inference state. Each job creates a fresh `whisper_state`, sets Whisper's `no_context` flag, supplies no prompt tokens, and destroys that state after producing the response. Persistent model weights therefore do not create persistent transcript context.

The gateway starts the worker as `whisper-worker.exe --model <path> --device <auto|cpu|gpu>`, taking the device from `runtime.device` (default `auto`):

| Device | Behavior |
| --- | --- |
| `auto` | Uses the first GPU the build can reach (Vulkan builds), otherwise the CPU. If the model fails to load on the GPU, the worker retries once on the CPU. |
| `cpu` | Always the CPU. |
| `gpu` | Requires a GPU. With none, the worker exits with code 4 before `READY` and the gateway refuses to start with an explicit error. |

Worker exit codes before `READY`: 2 for invalid arguments, 3 when the model cannot be loaded, 4 when `gpu` is required and no GPU device exists.

The worker's `READY` payload carries `device` (`gpu` or `cpu`, the device the model actually loaded on) and `deviceName` (for example `Vulkan0 NVIDIA GeForce GTX 1080 Ti`, or `CPU`); the gateway logs both on `worker.ready`. Each `RESULT` payload carries `timing: { stateMs, fullMs }`, the time spent creating the fresh `whisper_state` and running inference. The gateway keeps only `text` and `segments` from a result, so neither field reaches clients, and `GET /v1/health` is unchanged.
