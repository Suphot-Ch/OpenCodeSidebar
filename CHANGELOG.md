# Changelog

## 0.3.1

- Keep an active local bridge alive during authentication refresh instead of waiting for its SSE connections to finish.
- Close HTTP streams and upgraded sockets when the bridge is actually stopped.
- Replace stale browser session cookies with the refreshed bridge cookie for HTTP and WebSocket requests.
- Bound shared-bridge probes, cookie synchronization, workspace registration, and connection stages with timeouts.
- Reload the web UI after successful auto-pairing even when its URL is unchanged.
- Rate-limit automatic unauthorized recovery to avoid endless pairing loops.

## 0.3.0

- Automatic pairing and authentication refresh, plus workspace registration.
