# Wire-fidelity axes

Between v3.22 and v3.28, dario's Claude backend closed six axes along which a proxy can diverge from real Claude Code. Each is a separate knob, each ships with its own test suite, each is surfaced through `dario doctor` where the axis has something to report. Defaults are chosen so existing setups don't regress.

| Axis | Release | What it does | How to tune |
|---|---|---|---|
| **Request body key order** | v3.22 | Top-level JSON key order of the outbound `/v1/messages` body is captured from CC's wire serialization and replayed byte-for-byte. Schema bumped v2 → v3; stale caches quarantined. | Automatic once a live capture exists. The baked fallback carries a v2.1.112 snapshot. |
| **Runtime / TLS ClientHello** | v3.23 | Classifies the runtime as `bun-match` / `bun-bypassed` / `node-only` and surfaces the class + hint in `dario doctor`. Bun yields the BoringSSL ClientHello CC presents; Node yields OpenSSL's (distinct JA3). | `--strict-tls` (or `DARIO_STRICT_TLS=1`) refuses to start proxy mode unless `bun-match`. `DARIO_QUIET_TLS=1` silences the startup banner in known-fine environments. |
| **Inter-request timing** | v3.24 | Replaces the hardcoded 500 ms floor with a configurable floor + uniform jitter. A fixed 500 ms minimum-inter-arrival is an observable edge at scale; jitter dissolves the edge. | `--pace-min=MS`, `--pace-jitter=MS`, or `DARIO_PACE_MIN_MS` / `DARIO_PACE_JITTER_MS`. Legacy `DARIO_MIN_INTERVAL_MS` still honored. |
| **Stream-consumption shape** | v3.25 | When a downstream client disconnects mid-stream, CC keeps reading SSE to EOF. Dario now offers the same: drain upstream to completion even when the consumer has left. Default off — don't silently burn tokens. | `--drain-on-close` / `DARIO_DRAIN_ON_CLOSE=1`. Bounded by the existing 5-minute upstream timeout. |
| **Session-ID lifecycle** | v3.28 | Generalizes the v3.19 hardcoded 15-minute idle rotation into a tunable `SessionRegistry` with jitter, max-age, and per-client bucketing. Fixes a v3.27 body/header rotation race as a side effect. | `--session-idle-rotate=MS` (default 900000), `--session-rotate-jitter=MS`, `--session-max-age=MS`, `--session-per-client`. Env mirrors `DARIO_SESSION_*`. Defaults are bit-identical to v3.27. |
| **MCP / sub-agent reach** | v3.26 + v3.27 | Not a wire axis — a *surface* axis. CC-aware tools can now address dario directly (sub-agent from inside CC, MCP server for any MCP client), so operators don't have to switch terminals to introspect the proxy. Read-only by design. | `dario subagent install` / `dario mcp`. See [`mcp-server.md`](./mcp-server.md) and [`sub-agent.md`](./sub-agent.md). |

The six-direction wire-fidelity roadmap is complete. Subsequent releases return to responding to issues and upstream template drift.
