# Commands and proxy options

## Commands

| Command | Description |
|---|---|
| `dario login [--manual]` | Log in to the Claude backend. Detects CC credentials or runs its own OAuth flow. `--manual` (v3.20) mirrors CC's code-paste flow for SSH / container setups without a browser. |
| `dario proxy` | Start the local API proxy on port 3456 |
| `dario doctor [--probe] [--auth-check] [--json] [--bun-bootstrap]` | Aggregated health report — dario / Node / runtime-TLS / CC binary + compat / template + drift / per-request overhead / OAuth / pool + pool routing (next account in rotation when 2+ loaded) / backends / sub-agent. `--probe` (v3.31.7) hits the live `claude.ai/oauth/authorize` endpoint and surfaces the verdict, so scope-policy drift is catchable from a user's machine (not just CI). `--auth-check` (v3.31.9) opens a one-shot `x-api-key` listener and classifies whatever a client actually sends (match / mismatch / no-auth / timeout), with only redacted previews in output. `--json` (v3.31.8) emits structured output for claude-bridge's `/status`, deepdive's health probes, and CI scrapers. `--bun-bootstrap` runs the canonical bun.sh installer when the runtime/TLS check is warning that Bun isn't on PATH. |
| `dario usage [--port=N] [--json]` | Burn-rate summary of the running proxy's traffic over the last 60 minutes: requests, input/output tokens, avg latency, error rate, subscription % vs. extra-usage, estimated API-equivalent cost, plus per-account breakdown when pool mode is active. Hits `/analytics` on the local proxy. When the proxy isn't reachable, prints a hint pointing at `dario doctor --usage` (the one-off rate-limit probe). `--json` emits the raw `/analytics` payload for status bars / CI dashboards. Also exposed as the `usage` tool in `dario mcp`. |
| `dario config [--json]` | Prints the effective dario configuration with credentials redacted. Complementary to `doctor` — doctor answers *is it working?*, config answers *what IS it?* (v3.31.10) |
| `dario upgrade` | Safe wrapper over `npm install -g @askalf/dario@latest` — probes npm for the `@latest` version first (3s timeout, 60s cache), refuses to run if already on latest, fails with a clear hint if npm is missing. (v3.31.10) |
| `dario status` | Show Claude backend OAuth token health and expiry |
| `dario refresh` | Force an immediate Claude token refresh |
| `dario logout` | Delete stored Claude credentials |
| `dario accounts list` / `add <alias>` / `remove <alias>` | Multi-account pool management. `add <alias>` on a fresh pool auto back-fills your existing `dario login` credentials as `login`, so your first `add` trips the 2+ pool threshold on its own — see [Multi-account pool mode](./multi-account-pool.md). |
| `dario backend list` / `add <name> --key=<key> [--base-url=<url>]` / `remove <name>` | OpenAI-compat backend management |
| `dario shim -- <cmd> [args...]` | Run a child process with the in-process fetch patch. See [Shim mode](./shim.md). |
| `dario subagent install` / `remove` / `status` | CC sub-agent lifecycle. See [sub-agent hook](./sub-agent.md). |
| `dario mcp` | Run dario as an MCP server over stdio. See [MCP server](./mcp-server.md). |
| `dario help` | Full command reference |

## Proxy options

| Flag / env | Description | Default |
|---|---|---|
| `--passthrough` / `--thin` | Thin proxy for the Claude backend — OAuth swap only, no template injection | off |
| `--preserve-tools` / `--keep-tools` | Keep client tool schemas instead of remapping to CC's. Required for clients whose tools have fields CC doesn't — see [Custom tool schemas](./agent-compat.md#custom-tool-schemas). Auto-enabled for Cline / Kilo Code / Roo Code and forks (detected via system-prompt identity markers). | off (auto for text-tool clients) |
| `--no-auto-detect` / `--no-auto-preserve` | Disable the text-tool-client detector so the CC wire shape stays intact on Cline/Kilo/Roo prompts (v3.20.1, dario#40). Explicit `--preserve-tools` still wins. | off |
| `--hybrid-tools` / `--context-inject` | Remap to CC tools **and** inject request-context values (`sessionId`, `requestId`, `channelId`, `userId`, `timestamp`) into client-declared fields CC's schema doesn't carry. See [Hybrid tool mode](./agent-compat.md#hybrid-tool-mode). | off |
| `--merge-tools` / `--append-tools` | **EXPERIMENTAL.** Send CC's canonical tools first, append the client's custom tools after (deduped by name, case-insensitive). Model can call either side; tool calls flow back unchanged. Mutually exclusive with `--preserve-tools` and `--hybrid-tools`. Anthropic's billing classifier may flip routing on the appended suffix — validate with `--verbose` and watch the `billing: <bucket>` line on the first 1-2 requests before relying on it. | off |
| `--model=<name>` | Force a model. Shortcuts (`opus`, `sonnet`, `haiku`), full IDs (`claude-opus-4-7`), or a **provider prefix** (`openai:gpt-4o`, `groq:llama-3.3-70b`, `claude:opus`, `local:qwen-coder`) to force the backend server-wide. | passthrough |
| `--port=<n>` | Port to listen on | `3456` |
| `--host=<addr>` / `DARIO_HOST` | Bind address. Use `0.0.0.0` for LAN, or a specific IP (e.g. a Tailscale interface). When non-loopback, also set `DARIO_API_KEY`. | `127.0.0.1` |
| `--verbose` / `-v` | Log every request (one line per request — method + path + billing bucket) | off |
| `--verbose=2` / `-vv` / `DARIO_LOG_BODIES=1` | Also dump the outbound request body (redacted: bearer tokens, `sk-ant-*` keys, JWTs stripped; capped at 8KB). For wire-level client-compat debugging. | off |
| `--log-file=<path>` / `DARIO_LOG_FILE` | Append one JSON-ND record per completed request to PATH. Useful for backgrounded proxies where stdout is unobserved (where `--verbose` can't help). Field set: `ts`, `req`, `method`, `path`, `model`, `status`, `latency_ms`, `in_tokens`, `out_tokens`, `cache_read`, `cache_create`, `claim`, `bucket`, `account`, `client`, `preserve_tools`, `stream`, plus `reject` / `error` on failure paths. Secrets scrubbed via the same redactor that `--verbose-bodies` uses; no request bodies. | off |
| `--passthrough-betas=<csv>` / `DARIO_PASSTHROUGH_BETAS` | Beta flags ALWAYS forwarded upstream regardless of CC's captured set or the client's `anthropic-beta` header. Bypasses the billable-beta filter (so `extended-cache-ttl-*` survives if you opt in). Per-account rejection cache still applies — a pinned flag the upstream 400's gets dropped on retry rather than re-sent forever. Use when you know a beta works on your account but isn't in the captured template, or when client traffic should be force-augmented. Empty flag value (`--passthrough-betas=`) clears the env-default. | off |
| `--strict-tls` / `DARIO_STRICT_TLS=1` | Refuse to start proxy mode unless runtime classifies as `bun-match` — i.e. the TLS ClientHello matches CC's. See [Wire-fidelity axes](./wire-fidelity.md). (v3.23) | off |
| `--pace-min=<ms>` / `DARIO_PACE_MIN_MS` | Minimum inter-request gap in ms. Replaces the legacy hardcoded 500 ms. (v3.24) | `500` |
| `--pace-jitter=<ms>` / `DARIO_PACE_JITTER_MS` | Uniform random jitter added to each gap. Dissolves the minimum-inter-arrival observable edge. (v3.24) | `0` |
| `--drain-on-close` / `DARIO_DRAIN_ON_CLOSE=1` | When a downstream client disconnects mid-stream, keep reading upstream SSE to completion (match CC's consumption shape). Bounded by the 5-min upstream timeout. (v3.25) | off |
| `--session-idle-rotate=<ms>` / `DARIO_SESSION_IDLE_ROTATE_MS` | Idle threshold before a session-id rotates. (v3.28) | `900000` (15 min) |
| `--session-rotate-jitter=<ms>` / `DARIO_SESSION_JITTER_MS` | Jitter sampled once per session at creation — hides the exact idle floor. (v3.28) | `0` |
| `--session-max-age=<ms>` / `DARIO_SESSION_MAX_AGE_MS` | Hard ceiling on a session-id's lifetime regardless of activity. (v3.28) | off |
| `--session-per-client` / `DARIO_SESSION_PER_CLIENT=1` | Split session-id registry by a per-client header so multi-UI fan-out doesn't collapse onto one id. (v3.28) | off |
| `DARIO_API_KEY` | If set, all endpoints (except `/health`) require a matching `x-api-key` or `Authorization: Bearer` header. Required when `--host` binds non-loopback. | unset (open) |
| `DARIO_CORS_ORIGIN` | Override browser CORS origin | `http://localhost:${port}` |
| `DARIO_QUIET_TLS` | Suppress the runtime/TLS mismatch startup banner | unset |
| `DARIO_NO_BUN` | Disable automatic Bun relaunch | unset |
| `DARIO_MIN_INTERVAL_MS` | Legacy name for `DARIO_PACE_MIN_MS`. Still honored; new name wins when both are set. | — |
| `DARIO_CC_PATH` | Override path to the Claude Code binary for OAuth detection | auto-detect |
| `DARIO_OAUTH_CLIENT_ID` | Override the detected Claude OAuth client id as an emergency escape hatch | unset |
| `DARIO_OAUTH_AUTHORIZE_URL` | Override the detected Claude OAuth authorize URL | unset |
| `DARIO_OAUTH_TOKEN_URL` | Override the detected Claude OAuth token URL | unset |
| `DARIO_OAUTH_SCOPES` | Override the detected Claude OAuth scopes | unset |
| `DARIO_OAUTH_OVERRIDE_PATH` | Override file path for JSON OAuth overrides | `~/.dario/oauth-config.override.json` |
| `DARIO_OAUTH_DISABLE_OVERRIDE=1` | Ignore env/file OAuth overrides entirely | unset |

## Endpoints

| Path | Description |
|---|---|
| `POST /v1/messages` | Anthropic Messages API (Claude backend) |
| `POST /v1/chat/completions` | OpenAI-compatible Chat API (routes by model name) |
| `GET /v1/models` | Model list (Claude models — OpenAI models come from the OpenAI backend directly) |
| `GET /health` | Proxy health + OAuth status + request count |
| `GET /status` | Detailed Claude OAuth token status |
| `GET /accounts` | Pool snapshot including sticky binding count (pool mode only) |
| `GET /analytics` | Per-account / per-model stats, burn rate, exhaustion predictions, `billingBucket` + `subscriptionPercent` per request |
