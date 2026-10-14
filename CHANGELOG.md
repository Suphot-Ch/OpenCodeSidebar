# Changelog

## 0.3.2

- Fix authenticated browser POST requests failing with `Authentication required`: validate the browser Origin at the bridge, then rewrite Origin/Referer to the upstream server.
- Apply the same Origin validation to WebSocket upgrades and reject foreign hosts/origins before proxying or updating cookies.
- Remove wildcard credentialed CORS headers from the authenticated bridge.
- Identify compatible shared bridges by protocol version and upstream origin; do not reuse older bridges missing the fix.
- Verify authenticated bridge health before showing Connected.

## 0.3.1

- Keep an active local bridge alive during authentication refresh instead of waiting for its SSE connections to finish.
- Close HTTP streams and upgraded sockets when the bridge is actually stopped.
- Replace stale browser session cookies with the refreshed bridge cookie for HTTP and WebSocket requests.
- Bound shared-bridge probes, cookie synchronization, workspace registration, and connection stages with timeouts.
- Reload the web UI after successful auto-pairing even when its URL is unchanged.
- Rate-limit automatic unauthorized recovery to avoid endless pairing loops.

## 0.3.0

- Automatic pairing and authentication refresh, plus workspace registration.
