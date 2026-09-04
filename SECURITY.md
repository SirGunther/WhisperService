# Security model

WhisperService is a private loopback application, not an internet-facing server.

- It binds only to `127.0.0.1:8178`.
- Every HTTP API operation requires the generated bearer token. WebSocket upgrades require a 15-second, single-use ticket created by an authenticated request.
- Browser origins must match the configured allowlist exactly. Wildcards are rejected. Origin-less local tools still need the bearer token.
- Setup removes inherited ACLs from `credentials.json` and grants the current Windows user full access. The token is shown only by `npm run token:show` or immediately after explicit rotation.
- Logs omit tokens, audio, transcript text, and temporary paths.
- Audio and transcript state is scoped to one session/utterance and discarded after finalization, cancellation, disconnect, timeout, worker failure, or shutdown.

Do not add a Windows Firewall exception, port proxy, wildcard bind, reverse proxy, or browser origin you do not control. Rotate the token if it may have been exposed.
