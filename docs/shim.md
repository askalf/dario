# Shim mode

*Experimental, opt-in. The proxy is still the default — shim mode is a second transport, not a replacement.*

Shim mode runs a child process with an **in-process `globalThis.fetch` patch** that rewrites the child's outbound requests to `api.anthropic.com/v1/messages` exactly the way the proxy would, then sends them directly from the child to Anthropic. No localhost HTTP hop. No port to bind. No `ANTHROPIC_BASE_URL` to set.

```bash
dario shim -- claude --print "hello"
dario shim -v -- claude --print "hello"        # verbose
```

Under the hood: `dario shim` spawns the child with `NODE_OPTIONS=--require <dario-runtime.cjs>` and a unix socket / named pipe for telemetry. The runtime patches `globalThis.fetch` only for Anthropic messages requests, applies the same template replay the proxy does, and relays per-request events back to the parent so analytics still work. Every other fetch call is untouched and fails safe on any internal error.

**Why it matters.** A proxy has observable surface — TLS, headers, IP, `BASE_URL` env. Shim mode has none of that: the request goes out through CC's own network stack, unchanged. It's the transport with the smallest observable footprint.

**Hardening (v3.13+)** added runtime detection (canary for upstream runtime changes), template mtime-based auto-reload (long-running children pick up mid-session template refreshes without restart), strict defensive `rewriteBody` (requires exactly 3 text blocks, passes through on any mismatch instead of inventing structure), and header-order replay (honors captured CC header sequence so the shim matches CC wire-exact).

## When to use shim mode

- Running a single CC instance on a locked-down machine where binding a local port is inconvenient.
- Wrapping one-off scripts (`dario shim -- node my-agent.js`) without setting up environment variables.
- Debugging a specific child process in isolation — verbose logs are scoped to that child.
- You want to take the proxy layer off the wire entirely — no local port, no `BASE_URL`, no extra network hop.

## When to stay on the proxy (default)

- Multi-client routing. The proxy serves every tool on the machine through one endpoint; shim wraps one child at a time.
- Multi-account pool mode. Pooling across subscriptions needs a shared OAuth pool the proxy owns — a shim patch inside one child can't see pool state across other processes.
- Anything that isn't a Node / Bun child. The shim relies on `NODE_OPTIONS`, so Python SDKs or Go CLIs still need the proxy.
