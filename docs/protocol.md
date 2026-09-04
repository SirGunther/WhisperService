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
