<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>A universal LLM router that runs on your machine.<br>One local endpoint, every provider — Anthropic, OpenAI, Groq, OpenRouter, Ollama, any OpenAI-compat URL. Point your tools at localhost and stop caring which vendor is upstream.</strong></p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/v/@askalf/dario?color=blue" alt="npm version"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/ci.yml"><img src="https://github.com/askalf/dario/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/codeql.yml"><img src="https://github.com/askalf/dario/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://github.com/askalf/dario/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/dario" alt="License"></a>
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/dm/@askalf/dario" alt="Downloads"></a>
</p>

```bash
npm install -g @askalf/dario && dario proxy
```

One command, one local URL, every provider behind it. Point `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, or anything that speaks either protocol at `http://localhost:3456` and the **model name** decides where the request goes:

- `claude-opus-4-7`, `claude-sonnet-4-6`, `opus`, `sonnet`, `haiku` → **Anthropic** (via your Claude Max/Pro subscription, or a direct API key, your choice)
- `gpt-4o`, `o3-mini`, `chatgpt-4o-latest` → **OpenAI**
- `llama-3.3-70b`, `deepseek-v3`, anything else → **Groq**, **OpenRouter**, **local LiteLLM**, **vLLM**, **Ollama**, whichever OpenAI-compat backend you wired up
- Force a backend explicitly with a prefix: `openai:gpt-4o`, `groq:llama-3.3-70b`, `local:qwen-coder`, `claude:opus`

Switching providers is a **model-name change** in your tool. Not a reconfigure. Not new base URLs. Not new API keys. Not a new SDK import. **Zero runtime dependencies. ~10,750 lines of TypeScript across ~24 files. ~1,185 assertions across 32 test suites. [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) on every release. Nothing phones home, ever.**

---

## What it actually does

You point every tool at one URL. Dario reads each request, decides which backend owns it, and forwards the request in that backend's native protocol.

| Client speaks | Model in request | dario routes to | What happens |
|---|---|---|---|
| Anthropic Messages API | `claude-*` / `opus` / `sonnet` / `haiku` | Claude backend | OAuth swap + (optional) CC template replay → `api.anthropic.com` |
| Anthropic Messages API | `gpt-*`, `llama-*`, etc. | OpenAI-compat backend | Anthropic → OpenAI translation, forwarded to configured backend |
| OpenAI Chat Completions | `gpt-*` / `o1-*` / `o3-*` | OpenAI-compat backend | Passthrough: auth swap, body forwarded byte-for-byte |
| OpenAI Chat Completions | `claude-*` | Claude backend | OpenAI → Anthropic translation, then the Claude backend path |
| Either protocol | `<provider>:<model>` | Forced by prefix | Explicit override for ambiguous names |

The tool doesn't know. The backend doesn't know. Dario is the seam.

Beyond routing, the Claude backend is a **full wire-level Claude Code replay** — every observable axis (bytes, headers, body key order, TLS stack, inter-request timing, session-id lifecycle, stream-consumption shape) is captured from your installed CC binary and replayed on outbound requests so Anthropic's classifier sees a CC session. See [Claude subscription backend](#2-claude-subscription-backend) and [Fingerprint axes](#fingerprint-axes).

---

## Quick start

```bash
# Install
npm install -g @askalf/dario

# Any combination of backends:

# 1. Claude via your Claude Max / Pro subscription (uses your Claude Code
#    OAuth if CC is installed; runs its own OAuth flow otherwise)
dario login
#    or, for SSH / container setups with no browser:
dario login --manual

# 2. OpenAI or any OpenAI-compat endpoint
dario backend add openai     --key=sk-proj-...
dario backend add groq       --key=gsk_...    --base-url=https://api.groq.com/openai/v1
dario backend add openrouter --key=sk-or-...  --base-url=https://openrouter.ai/api/v1
dario backend add local      --key=anything   --base-url=http://127.0.0.1:11434/v1

# Start the proxy
dario proxy

# Point every tool at one local URL
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

That's it. Every tool that honors these standard env vars now reaches every backend you configured. No per-tool reconfiguration. No SDK changes. One URL, one fake key, every real provider behind it.

Something broken? `dario doctor` prints a single aggregated health report — dario version, Node, platform, runtime/TLS classification, CC binary compat, template source + age + drift, OAuth status, pool state, configured backends, sub-agent install state. Paste that instead of screenshots when you file an issue.

---

## Why you'll install this

**You want one URL for every provider.** Cursor, Aider, Continue, Zed, OpenHands, Claude Code, your own scripts — every tool you own has its own per-provider config. Dario collapses that into a single `localhost:3456` that speaks both Anthropic and OpenAI protocols and routes by model name.

**You pay for Claude Max but only use it in Claude Code.** Cursor, Aider, Zed, Continue — they all want API keys and bill per-token while your $200/mo subscription sits idle. Dario's Claude backend routes requests from all of them through your plan by replaying the exact Claude Code wire shape (template, tools, headers, body key order, billing tag) that Anthropic's classifier expects for subscription billing. See [Claude subscription backend](#2-claude-subscription-backend).

**You hit rate limits on long agent runs.** Add a second / third Claude subscription with `dario accounts add work` and pool mode routes each request to whichever account has the most headroom. **Session stickiness** pins a multi-turn conversation to one account so the Anthropic prompt cache survives the run. **In-flight 429 failover** retries the same request against a different account before your client sees an error. See [Multi-account pool mode](#multi-account-pool-mode).

**You run a coding agent that isn't Claude Code.** Cline, Roo Code, Cursor, Windsurf, Continue.dev, GitHub Copilot, OpenHands, OpenClaw, Hermes — they each ship their own tool schemas and their own validators. Dario's universal `TOOL_MAP` (**~66 schema-verified entries**) pre-maps every major coding agent's tool names to Claude Code's native set on the outbound path and rebuilds to your agent's exact expected shape on the inbound path. No `--preserve-tools`, no fingerprint loss, no validator errors. See [Agent compatibility](#agent-compatibility).

**You want the proxy layer off the wire entirely.** **Shim mode** is an in-process `globalThis.fetch` patch injected via `NODE_OPTIONS=--require`. No HTTP hop, no port to bind, no `BASE_URL` to set. `dario shim -- claude --print "hi"` and CC thinks it's talking directly to `api.anthropic.com`. See [Shim mode](#shim-mode).

**You want dario itself addressable from inside Claude Code or any MCP client.** `dario subagent install` registers a first-party sub-agent under `~/.claude/agents/dario.md` so CC can delegate diagnostics and template-refresh in-session ([Claude Code sub-agent hook](#claude-code-sub-agent-hook-v326)). `dario mcp` turns dario itself into a read-only MCP server — Claude Desktop, Cursor, Zed, any MCP-aware editor can introspect dario's state (auth, pool, backends, template, fingerprint, runtime) without leaving the editor ([dario as MCP server](#dario-as-mcp-server-v327)).

**You want certainty that the proxy isn't trivially fingerprintable.** The "get ahead of Anthropic" release track (v3.22 – v3.28) closed six observable divergence axes between dario and real Claude Code: body field order (v3.22), TLS ClientHello (v3.23), inter-request timing (v3.24), stream-consumption shape (v3.25), sub-agent/MCP reach (v3.26/v3.27), and session-id lifecycle (v3.28). See [Fingerprint axes](#fingerprint-axes).

**You want to actually audit the thing.** ~10,750 lines of TypeScript across ~24 files. Zero runtime dependencies (`npm ls --production` confirms). Credentials at `~/.dario/` with `0600` permissions. `127.0.0.1`-only by default. Every release [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions. Nothing phones home. Small enough to read in a weekend.

---

## Who this is for

**Best fit:**

- **Developers using multiple LLMs across multiple tools** tired of juggling base URLs, keys, and per-tool provider configs.
- **Teams running local or hosted OpenAI-compat servers** (LiteLLM, vLLM, Ollama, Groq, OpenRouter, self-hosted) who want one stable local endpoint every tool can reuse.
- **Anyone building AI coding tools** who wants provider independence without writing an OpenAI ↔ Anthropic translator themselves.
- **Claude Max / Pro subscribers** who want their subscription usable from every tool on their machine, not just Claude Code.
- **[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) users** who want OAuth-subscription routing under the SDK. Point `baseURL: 'http://localhost:3456'` and dario translates API-key calls into your Claude Max auth — agent code stays identical.
- **Power users on multi-agent workloads** who want multi-account pooling, session stickiness, and in-flight 429 failover on their own machine, against their own subscriptions.
- **Operators who care about wire-level fidelity** — the fingerprint tightening in v3.22 – v3.28 means proxy mode's divergence from CC is observable (via `dario doctor`) and tunable (flags + env vars for each axis).

**Not a fit if:**

- You need vendor-managed production SLAs on every request. Use the provider APIs directly.
- You need a hosted multi-tenant routing platform with a dashboard. Try [askalf](https://askalf.org) — different product, same family.
- You want a chat UI. Use claude.ai or chatgpt.com.

---

## Backends

Dario's routing is organized around **backends**. Each is a swappable adapter — add one, your tools reach it through `localhost:3456` in whichever API shape they already speak. You can run zero, one, or all of them concurrently.

### 1. OpenAI-compat backend

Any provider that speaks the OpenAI Chat Completions API.

```bash
# OpenAI itself (default base URL)
dario backend add openai --key=sk-proj-...

# Groq
dario backend add groq --key=gsk_... --base-url=https://api.groq.com/openai/v1

# OpenRouter
dario backend add openrouter --key=sk-or-... --base-url=https://openrouter.ai/api/v1

# Local LiteLLM / vLLM / Ollama openai-compat mode
dario backend add local --key=anything --base-url=http://127.0.0.1:4000/v1
```

Credentials live at `~/.dario/backends/<name>.json` with mode `0600`.

**How it routes.** On `/v1/chat/completions` the request is inspected and forwarded:

| Request model | Route |
|---|---|
| `gpt-*`, `o1-*`, `o3-*`, `o4-*`, `chatgpt-*`, `text-davinci-*`, `text-embedding-*` | OpenAI-compat backend |
| `claude-*` (or `opus` / `sonnet` / `haiku`) | Claude subscription backend |
| Anything else | Claude backend with OpenAI-compat translation |

The request body goes upstream as-is; only the `Authorization` header is swapped and the URL is pointed at `baseUrl + /chat/completions`. Streaming is forwarded byte-for-byte.

Force a backend with a **provider prefix** on the model field (`openai:gpt-4o`, `groq:llama-3.3-70b`, `claude:opus`, `local:qwen-coder`) regardless of what the model name looks like — see [Provider prefix](#provider-prefix).

### 2. Claude subscription backend

OAuth-backed Claude Max / Pro, billed against your plan instead of the API. Activated by `dario login` (or `dario login --manual` for SSH / container setups without a browser, v3.20).

**What it does.** Every outbound Claude request is rebuilt to look exactly like a request Claude Code itself would make — system prompt, tool definitions, fingerprint headers, billing tag, beta flags, **header insertion order, static header values, `anthropic-beta` flag set, and top-level request-body key order** — using a live-extracted template from your actually-installed CC binary that self-heals on every Anthropic release. Anthropic's classifier sees a CC session because, from the wire up, it *is* one. That's what keeps your usage on subscription billing instead of API overage.

**Key mechanisms:**

- **Live fingerprint extraction.** Dario spawns your installed `claude` binary against a loopback MITM endpoint on startup, captures its outbound request, and extracts the live template — system prompt, tools, user-agent, beta flags, **header insertion order** (replayed by the shim since v3.13 and the proxy since v3.16), **static header values** and **`anthropic-beta` flag set** (v3.19), and **top-level request-body key order** (v3.22, schema v3). Eliminates the "Anthropic ships a new CC, dario is stale for 48 hours" window. Cached at `~/.dario/cc-template.live.json` with a 24h TTL. Falls back to the bundled snapshot if CC isn't installed; the bundled snapshot is scrubbed of host-identifying paths and `mcp__*` tool names at bake time (v3.21 — see `src/scrub-template.ts`).
- **Drift detection** (v3.17). On startup dario probes the installed `claude` binary and compares against the captured template. Mismatch triggers a forced refresh and prints a one-line warning. Users never silently sit on a stale template again.
- **Compat matrix** (v3.17, bumped in v3.19.5). `SUPPORTED_CC_RANGE` is encoded in code; installed CC outside the band prints a warn (untested above) or fail (below min) — zero-dep dotted-numeric comparator, no `semver` import per the dep policy.
- **Billing tag** reconstructed using CC's own algorithm: `x-anthropic-billing-header: cc_version=<version>.<build_tag>; cc_entrypoint=cli; cch=<5-char-hex>;` where `build_tag = SHA-256(seed + chars[4,7,20] of user message + version).slice(0,3)`.
- **OAuth config auto-detection** from the installed CC binary. When Anthropic rotates `client_id`, authorize URL, or scopes, dario picks up the new values on the next run without needing a release. Cache at `~/.dario/cc-oauth-cache-v4.json`, keyed by the CC binary fingerprint.
- **Multi-account pool mode** — see [Multi-account pool mode](#multi-account-pool-mode). Automatic when 2+ accounts are configured.
- **Framework scrubbing** — known fingerprint tokens (`OpenClaw`, `sessions_*` prefixes, orchestration tags) stripped from system prompt and message content before the request leaves your machine.
- **Atomic cache writes + cache corruption recovery** (v3.17). Template cache writes go through pid-qualified `.tmp` + `rename`, so an OS crash mid-write doesn't leave a half-written file. Unparseable cache files get quarantined to `cc-template.live.json.bad-<timestamp>` and dario self-heals on the next capture.
- **OAuth single-flight** (v3.17). Two concurrent refreshes for the same account alias now share one outbound `POST /oauth/token`, so the pool's background refresh timer and a user-triggered request at the same millisecond can't race and invalidate each other's refresh token.
- **Bun auto-relaunch.** When Bun is installed, dario relaunches under it so the TLS ClientHello matches CC's runtime (Bun uses BoringSSL; Node uses OpenSSL — distinct JA3/JA4 hashes). Without Bun, dario runs on Node.js — `dario doctor` surfaces the mismatch as of v3.23 and `--strict-tls` refuses to start proxy mode until it's resolved.

**Passthrough mode** (`dario proxy --passthrough`) does an OAuth swap and nothing else — no template, no identity, no scrubbing. Use it when the upstream tool already builds a Claude-Code-shaped request on its own.

**Detection scope.** The Claude backend is a per-request layer. Template replay and scrubbing are designed to be indistinguishable from CC at the request level. What they *cannot* defend against on their own is Anthropic's session-level behavioral classifier, which operates on cumulative per-OAuth aggregates. The v3.22 – v3.28 "get ahead of Anthropic" track closed six of those cumulative axes (body order, TLS, pacing, stream-drain, session-id lifecycle, MCP/sub-agent surface); for anything left, **pool mode** distributes load across multiple subscriptions so no single account accumulates enough signal to trip anything.

---

## Fingerprint axes

Between v3.22 and v3.28, dario's Claude backend closed six axes along which a proxy can look different from real Claude Code. Each is a separate knob, each ships with its own test suite, each is surfaced through `dario doctor` where the axis has something to report. Defaults are chosen so existing setups don't regress.

| Axis | Release | What it does | How to tune |
|---|---|---|---|
| **Request body key order** | v3.22 | Top-level JSON key order of the outbound `/v1/messages` body is captured from CC's wire serialization and replayed byte-for-byte. Schema bumped v2 → v3; stale caches quarantined. | Automatic once a live capture exists. The baked fallback carries a v2.1.112 snapshot. |
| **Runtime / TLS ClientHello** | v3.23 | Classifies the runtime as `bun-match` / `bun-bypassed` / `node-only` and surfaces the class + hint in `dario doctor`. Bun yields the BoringSSL ClientHello CC presents; Node yields OpenSSL's (distinct JA3). | `--strict-tls` (or `DARIO_STRICT_TLS=1`) refuses to start proxy mode unless `bun-match`. `DARIO_QUIET_TLS=1` silences the startup banner in known-fine environments. |
| **Inter-request timing** | v3.24 | Replaces the hardcoded 500 ms floor with a configurable floor + uniform jitter. A 500 ms minimum-inter-arrival edge is fingerprintable at scale; jitter dissolves the edge. | `--pace-min=MS`, `--pace-jitter=MS`, or `DARIO_PACE_MIN_MS` / `DARIO_PACE_JITTER_MS`. Legacy `DARIO_MIN_INTERVAL_MS` still honored. |
| **Stream-consumption shape** | v3.25 | When a downstream client disconnects mid-stream, CC keeps reading SSE to EOF. Dario now offers the same: drain upstream to completion even when the consumer has left. Default off — don't silently burn tokens. | `--drain-on-close` / `DARIO_DRAIN_ON_CLOSE=1`. Bounded by the existing 5-minute upstream timeout. |
| **Session-ID lifecycle** | v3.28 | Generalizes the v3.19 hardcoded 15-minute idle rotation into a tunable `SessionRegistry` with jitter, max-age, and per-client bucketing. Fixes a v3.27 body/header rotation race as a side effect. | `--session-idle-rotate=MS` (default 900000), `--session-rotate-jitter=MS`, `--session-max-age=MS`, `--session-per-client`. Env mirrors `DARIO_SESSION_*`. Defaults are bit-identical to v3.27. |
| **MCP / sub-agent reach** | v3.26 + v3.27 | Not a wire axis — a *surface* axis. CC-aware tools can now address dario directly (sub-agent from inside CC, MCP server for any MCP client), so operators don't have to switch terminals to introspect the proxy. Read-only by design. | `dario subagent install` / `dario mcp`. See dedicated sections below. |

The six-direction "get ahead of Anthropic" roadmap is complete. Subsequent releases return to responding to issues and upstream template drift.

---

## Multi-account pool mode

Pool mode activates automatically when `~/.dario/accounts/` contains 2+ accounts. Single-account dario is unchanged.

```bash
dario accounts add work
dario accounts add personal
dario accounts add side-project
dario accounts list
dario proxy
```

Each request picks the account with the highest headroom:

```
headroom = 1 - max(util_5h, util_7d)
```

The response's `anthropic-ratelimit-unified-*` headers are parsed back into the pool so the next selection sees fresh utilization. An account that returns a 429 is marked `rejected` and routed around until its window resets. When every account is exhausted, requests queue for up to 60 seconds waiting for headroom to reappear. Plans can mix freely — Max and Pro accounts sit in the same pool; dario doesn't care about tier, only headroom.

### Session stickiness

Multi-turn agent sessions pin to one account for the life of the conversation, so the Anthropic prompt cache isn't destroyed by account rotation between turns.

**The problem.** Claude prompt cache is scoped to `{account × cache_control key}`. When the pool rotates a long agent conversation across accounts on headroom alone, turn 1 builds a cache entry on account A, turn 2 lands on account B and reads nothing from A's cache — paying full cache-create cost again. For a long agent session that's a **5–10× token-cost multiplier** on every turn after the first.

**The fix.** Dario hashes a conversation's first user message into a 16-hex-char `stickyKey` (SHA-256 truncated, deterministic) and binds the key to whichever account `select()` would have picked on turn 1. Subsequent turns re-use that account as long as it's still healthy (not rejected, token not near expiry, headroom > 2%). On 429 failover, dario rebinds the key to the new account so the next turn doesn't re-select the exhausted one. 6h TTL, 2,000-entry cap, lazy cleanup. No client cooperation required.

### In-flight 429 failover

When a Claude request hits a 429 mid-flight, dario retries the *same request* against a different account before the client sees an error. The client sees one successful response; the pool sees the rejected account go cold until its window resets. Combined with session stickiness, long agent runs survive pool-level exhaustion without dropping user-facing turns.

### Inspection

```bash
curl http://localhost:3456/accounts     # per-account utilization, claim, sticky bindings, status
curl http://localhost:3456/analytics    # per-account / per-model stats, burn rate, exhaustion predictions
```

Every request carries a `billingBucket` field (`subscription` / `subscription_fallback` / `extra_usage` / `api` / `unknown`) so you can see which bucket each request billed against and a `subscriptionPercent` headline number tells you at a glance whether dario is actually routing through your subscription or silently falling to API overage.

---

## Shim mode

*Experimental, opt-in. The proxy is still the default — shim mode is a second transport, not a replacement.*

Shim mode runs a child process with an **in-process `globalThis.fetch` patch** that rewrites the child's outbound requests to `api.anthropic.com/v1/messages` exactly the way the proxy would, then sends them directly from the child to Anthropic. No localhost HTTP hop. No port to bind. No `ANTHROPIC_BASE_URL` to set.

```bash
dario shim -- claude --print "hello"
dario shim -v -- claude --print "hello"        # verbose
```

Under the hood: `dario shim` spawns the child with `NODE_OPTIONS=--require <dario-runtime.cjs>` and a unix socket / named pipe for telemetry. The runtime patches `globalThis.fetch` only for Anthropic messages requests, applies the same template replay the proxy does, and relays per-request events back to the parent so analytics still work. Every other fetch call is untouched and fails safe on any internal error.

**Why it matters.** Anthropic can fingerprint a proxy via TLS, headers, IP, or `BASE_URL` env. They literally cannot easily detect a `globalThis.fetch` monkey-patch from inside their own process without shipping signed-binary integrity checks against `globalThis` from inside the CC binary — and even then, the shim runs *before* CC's code loads, so it could patch the integrity check too. The longest-half-life transport against classifier evolution.

**Hardening (v3.13+)** added runtime detection (canary for the day Anthropic ships a Bun-compiled CC), template mtime-based auto-reload (long-running children pick up mid-session fingerprint refreshes without restart), strict defensive `rewriteBody` (requires exactly 3 text blocks, passes through on any mismatch instead of inventing structure), and header-order replay (honors captured CC header sequence so the shim matches CC wire-exact).

**When to use shim mode:**
- Running a single CC instance on a locked-down machine where binding a local port is inconvenient.
- Wrapping one-off scripts (`dario shim -- node my-agent.js`) without setting up environment variables.
- Debugging a specific child process in isolation — verbose logs are scoped to that child.
- You suspect Anthropic is fingerprinting your proxy traffic and you want to take the proxy off the wire.

**When to stay on the proxy** (default):
- Multi-client routing. The proxy serves every tool on the machine through one endpoint; shim wraps one child at a time.
- Multi-account pool mode. Pooling across subscriptions needs a shared OAuth pool the proxy owns — a shim patch inside one child can't see pool state across other processes.
- Anything that isn't a Node / Bun child. The shim relies on `NODE_OPTIONS`, so Python SDKs or Go CLIs still need the proxy.

---

## Agent compatibility

Dario's built-in `TOOL_MAP` carries **~66 schema-verified entries** covering the tool schemas of every major coding agent. On the Claude backend, tool calls translate to CC's native `Bash / Read / Write / Edit / Glob / Grep / WebSearch / WebFetch` on the outbound path (keeping the subscription fingerprint intact) and rebuild to your agent's exact expected shape on the inbound path (so your validator is happy). No flag required.

| Agent | Covered tool names (subset) |
|---|---|
| Claude Code / Claude Agent SDK | default — CC / SDK tools (same schema as of CC v2.1.114 / `@anthropic-ai/claude-agent-sdk@0.2.x`) |
| Cline / Roo Code / Kilo Code | `execute_command`, `write_to_file`, `replace_in_file`, `apply_diff`, `list_files`, `search_files`, `read_file` |
| Cursor | `run_terminal_cmd`, `edit_file`, `search_replace`, `codebase_search`, `grep_search`, `file_search`, `list_dir`, `read_file` (`target_file`) |
| Windsurf | `run_command`, `view_file`, `write_to_file`, `replace_file_content`, `find_by_name`, `grep_search`, `list_dir`, `search_web`, `read_url_content` |
| Continue.dev | `builtin_run_terminal_command`, `builtin_read_file`, `builtin_create_new_file`, `builtin_edit_existing_file`, `builtin_file_glob_search`, `builtin_grep_search`, `builtin_ls` |
| GitHub Copilot | `run_in_terminal`, `insert_edit_into_file`, `semantic_search`, `codebase_search`, `list_dir`, `fetch_webpage` |
| OpenHands | `execute_bash`, `str_replace_editor` |
| OpenClaw | `exec`, `process`, `web_search`, `web_fetch`, `browser`, `message` |
| Hermes | `terminal`, `patch`, `web_extract`, `clarify` |

Text-tool clients (Cline / Kilo Code / Roo Code and forks) are auto-detected via system-prompt fingerprint and automatically flipped into preserve-tools mode, because mixing CC's `tools` array with their XML protocol makes the model emit `<function_calls><invoke>` that their parsers can't read. If you run dario specifically for fingerprint fidelity and would rather pick `--preserve-tools` yourself, `--no-auto-detect` (v3.20.1, aka `--no-auto-preserve`) disables the heuristic — explicit operator choice then wins.

If your agent's tool names aren't pre-mapped and its tools carry fields CC's schema doesn't have, there are two escape hatches: **`--preserve-tools`** (forward your schema verbatim, lose the CC fingerprint) or **`--hybrid-tools`** (keep the fingerprint, fill request-context fields from headers). See [Custom tool schemas](#custom-tool-schemas).

The OpenAI-compat backend forwards tool definitions byte-for-byte and doesn't need any of this.

---

## dario as MCP server (v3.27)

`dario mcp` turns dario itself into a **stdio JSON-RPC 2.0 MCP server**. Claude Desktop, Cursor, Zed, any MCP-aware editor can introspect dario's state without leaving the editor.

```bash
dario mcp        # spawns the MCP server on stdin/stdout — wire it up to your MCP client
```

**Strictly read-only.** The exposed tool set is:

| Tool | What it reports |
|---|---|
| `doctor` | Full aggregated health report — same output as `dario doctor` |
| `status` | OAuth authentication state (authenticated / no-credentials / expired-but-refreshable) |
| `accounts_list` | Pool accounts + expiry times. Never touches API keys. |
| `backends_list` | Configured OpenAI-compat backends — keys redacted completely (not even a `sk-…` prefix) |
| `subagent_status` | CC sub-agent install and version-match state |
| `fingerprint_info` | Runtime / TLS classification, template source + schema version |

Mutations (`login`, `logout`, `accounts add/remove`, `backend add/remove`, `subagent install/remove`, `proxy` start/stop) are **not** exposed. An MCP client can observe dario; changing dario's state stays a CLI action the user types with intent. The test suite asserts the forbidden-tool set stays forbidden so a future accidental drift gets caught.

Zero runtime deps — the JSON-RPC dispatcher is hand-rolled over Node's `readline`. `src/mcp/protocol.ts` + `src/mcp/tools.ts` + `src/mcp/server.ts` are each pure over their inputs (streams are injectable, data sources are injectable) so the e2e test runs in-process against a `PassThrough` pair.

---

## Claude Code sub-agent hook (v3.26)

`dario subagent install` writes `~/.claude/agents/dario.md` so Claude Code has a named handle for running dario diagnostics and template-refresh inside an ongoing CC session. No more `Ctrl+Z → dario doctor → fg` when you hit a `[WARN]` row mid-conversation.

```bash
dario subagent install    # writes ~/.claude/agents/dario.md
dario subagent status     # {not-installed, installed+current, installed+stale} + hint
dario subagent remove     # idempotent
```

**Tool-scoped.** The sub-agent is restricted to `Bash, Read` and its prompt forbids destructive operations (credential mutation, account pool changes, backend config changes) without explicit user confirmation. `dario proxy` is also off-limits from inside the sub-agent — it would block the parent CC session. CC can ask dario to *report*, not to *change state*. (MCP server has the same read-only boundary for the same reason.)

A version marker (`<!-- dario-sub-agent-version: X -->`) embedded in the markdown lets `dario doctor` distinguish installed-and-current from installed-and-stale; the "Sub-agent" row appears between Backends and Home with an inline refresh command when stale.

---

## Commands

| Command | Description |
|---|---|
| `dario login [--manual]` | Log in to the Claude backend. Detects CC credentials or runs its own OAuth flow. `--manual` (v3.20) mirrors CC's code-paste flow for SSH / container setups without a browser. |
| `dario proxy` | Start the local API proxy on port 3456 |
| `dario doctor` | Aggregated health report — dario / Node / runtime-TLS / CC binary + compat / template + drift / OAuth / pool / backends / sub-agent |
| `dario status` | Show Claude backend OAuth token health and expiry |
| `dario refresh` | Force an immediate Claude token refresh |
| `dario logout` | Delete stored Claude credentials |
| `dario accounts list` / `add <alias>` / `remove <alias>` | Multi-account pool management |
| `dario backend list` / `add <name> --key=<key> [--base-url=<url>]` / `remove <name>` | OpenAI-compat backend management |
| `dario shim -- <cmd> [args...]` | Run a child process with the in-process fetch patch (see [Shim mode](#shim-mode)) |
| `dario subagent install` / `remove` / `status` | CC sub-agent lifecycle (v3.26 — see [sub-agent hook](#claude-code-sub-agent-hook-v326)) |
| `dario mcp` | Run dario as an MCP server over stdio (v3.27 — see [dario as MCP server](#dario-as-mcp-server-v327)) |
| `dario help` | Full command reference |

### Proxy options

| Flag / env | Description | Default |
|---|---|---|
| `--passthrough` / `--thin` | Thin proxy for the Claude backend — OAuth swap only, no template injection | off |
| `--preserve-tools` / `--keep-tools` | Keep client tool schemas instead of remapping to CC's. Required for clients whose tools have fields CC doesn't — see [Custom tool schemas](#custom-tool-schemas). Auto-enabled for Cline / Kilo Code / Roo Code and forks (detected via system-prompt fingerprint). | off (auto for text-tool clients) |
| `--no-auto-detect` / `--no-auto-preserve` | Disable the text-tool-client detector so the CC fingerprint stays intact on Cline/Kilo/Roo prompts (v3.20.1, dario#40). Explicit `--preserve-tools` still wins. | off |
| `--hybrid-tools` / `--context-inject` | Remap to CC tools **and** inject request-context values (`sessionId`, `requestId`, `channelId`, `userId`, `timestamp`) into client-declared fields CC's schema doesn't carry. See [Hybrid tool mode](#hybrid-tool-mode). | off |
| `--model=<name>` | Force a model. Shortcuts (`opus`, `sonnet`, `haiku`), full IDs (`claude-opus-4-7`), or a **provider prefix** (`openai:gpt-4o`, `groq:llama-3.3-70b`, `claude:opus`, `local:qwen-coder`) to force the backend server-wide. | passthrough |
| `--port=<n>` | Port to listen on | `3456` |
| `--host=<addr>` / `DARIO_HOST` | Bind address. Use `0.0.0.0` for LAN, or a specific IP (e.g. a Tailscale interface). When non-loopback, also set `DARIO_API_KEY`. | `127.0.0.1` |
| `--verbose` / `-v` | Log every request (one line per request — method + path + billing bucket) | off |
| `--verbose=2` / `-vv` / `DARIO_LOG_BODIES=1` | Also dump the outbound request body (redacted: bearer tokens, `sk-ant-*` keys, JWTs stripped; capped at 8KB). For wire-level client-compat debugging. | off |
| `--strict-tls` / `DARIO_STRICT_TLS=1` | Refuse to start proxy mode unless runtime classifies as `bun-match` — i.e. the TLS ClientHello matches CC's. See [Fingerprint axes](#fingerprint-axes). (v3.23) | off |
| `--pace-min=<ms>` / `DARIO_PACE_MIN_MS` | Minimum inter-request gap in ms. Replaces the legacy hardcoded 500 ms. (v3.24) | `500` |
| `--pace-jitter=<ms>` / `DARIO_PACE_JITTER_MS` | Uniform random jitter added to each gap. Dissolves the minimum-inter-arrival fingerprint edge. (v3.24) | `0` |
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

---

## Usage

### Python (Anthropic SDK)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3456",
    api_key="dario",
)

msg = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content[0].text)
```

### Python (OpenAI SDK — same proxy, different provider)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="dario",
)

# gpt-4o routes to the configured OpenAI backend
msg = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)

# claude-opus-4-7 routes to the Claude subscription backend — same SDK, same URL
claude_msg = client.chat.completions.create(
    model="claude-opus-4-7",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### TypeScript / Node.js

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:3456",
  apiKey: "dario",
});

const msg = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### OpenAI-compatible tools (Cursor, Continue, Aider, LiteLLM, …)

```bash
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Any tool that accepts an OpenAI base URL works. Use Claude model names (`claude-opus-4-7`, `opus`, `sonnet`, `haiku`) for the Claude backend, or GPT-family names for the configured OpenAI-compat backend.

### curl

```bash
# Claude backend via Anthropic format
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-7","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'

# OpenAI backend via OpenAI format
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dario" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

### Streaming, tool use, prompt caching, extended thinking

All supported. Claude backend: full Anthropic SSE format plus OpenAI-SSE translation for tool_use streaming. OpenAI-compat backend: streaming body forwarded byte-for-byte. See [Fingerprint axes](#fingerprint-axes) for the v3.25 `--drain-on-close` knob that matches CC's read-to-EOF stream-consumption pattern.

### Provider prefix

Any request's `model` field can be written as `<provider>:<name>` to force which backend handles it, regardless of what the model name looks like.

| Prefix | Backend |
|---|---|
| `openai:` | OpenAI-compat backend |
| `groq:` | OpenAI-compat backend |
| `openrouter:` | OpenAI-compat backend |
| `local:` | OpenAI-compat backend |
| `compat:` | OpenAI-compat backend |
| `claude:` | Claude subscription backend |
| `anthropic:` | Claude subscription backend |

The prefix gets stripped before the request goes upstream — the backend only sees the bare model name. Unrecognized prefixes are ignored, so Ollama-style `llama3:8b` passes through untouched. `dario proxy --model=openai:gpt-4o` applies the prefix to every request server-wide.

### Custom tool schemas

By default, on the Claude backend, dario replaces your client's tool definitions with the real Claude Code tools (`Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `WebSearch`, `WebFetch`) and translates parameters back and forth. That's how dario looks like CC on the wire, which is what lets your request bill against your Claude subscription instead of API pricing. For the agents listed in [Agent compatibility](#agent-compatibility), the translation is pre-mapped and runs automatically — nothing to configure.

The trade-off shows up when you're running something that *isn't* in the pre-mapped list and whose tools carry fields CC's schema doesn't have — a `sessionId`, a custom request id, a channel-bound context token, a `confidence` score the model is supposed to emit. Those fields don't survive the round trip.

Symptom: your tool calls come back looking stripped-down, or your runtime complains about a required field being absent *only when routed through dario's Claude backend*.

Fix: run dario with `--preserve-tools`. That skips the CC tool remap entirely, passes your client's tool definitions through to the model unchanged, and lets the model populate every field your schema expects.

```bash
dario proxy --preserve-tools
```

The cost: requests no longer look like CC on the wire, so the CC subscription fingerprint is gone. On a Max/Pro plan, that means the request may be counted against your API usage rather than your subscription quota. [Hybrid tool mode](#hybrid-tool-mode) below is the compromise that keeps both.

The OpenAI-compat backend is unaffected — it forwards tool definitions byte-for-byte and doesn't need this flag.

### Hybrid tool mode

For the very common case where the "missing" fields on your client's tool are **request context** — `sessionId`, `requestId`, `channelId`, `userId`, `timestamp` — dario can remap to CC tools *and* inject those values on the reverse path. The fingerprint stays intact, the model still sees only CC's tools (so subscription billing still routes), and your validator still sees the fields it requires because dario fills them from request headers on the way back.

```bash
dario proxy --hybrid-tools
```

**How it works.** On each request, dario builds a `RequestContext` from headers (`x-session-id`, `x-request-id`, `x-channel-id`, `x-user-id`) plus its own generated ids and the current timestamp. After `translateBack` produces the client-shaped tool call on the response path, any field declared on the client's tool schema whose name matches a known context field (`sessionId`/`session_id`, `requestId`/`request_id`, `channelId`/`channel_id`, `userId`/`user_id`, `timestamp`/`created_at`/`createdAt`) and isn't already populated gets filled from the context. Fields the model genuinely populated are never overwritten.

**When to use which flag:**

| Your situation | Flag | Why |
|---|---|---|
| Your agent is listed in [Agent compatibility](#agent-compatibility) | *(neither)* | Pre-mapped in `TOOL_MAP`; the default path already handles it. |
| Your custom fields are request context (session/request/channel/user ids, timestamps) | `--hybrid-tools` | Keeps the CC fingerprint *and* your validator is satisfied. |
| Your custom fields need the model's reasoning (e.g. `confidence`, `reasoning_trace`, `tool_selection_rationale`) | `--preserve-tools` | The model has to see the real schema to populate these. Accept the fingerprint loss. |
| Your client's tools are already a subset of CC's `Bash/Read/Write/Edit/Grep/Glob/WebSearch/WebFetch` | *(neither)* | Default mode works as-is. |
| You're on a text-tool client (Cline / Kilo Code / Roo Code) and want to override the auto-detect | `--no-auto-detect` (plus `--preserve-tools` or not, your call) | Operator choice outranks the heuristic. |

### Library mode

```typescript
import { startProxy, getAccessToken, getStatus, listBackends } from "@askalf/dario";

await startProxy({ port: 3456, verbose: true });
const token = await getAccessToken();
const status = await getStatus();
const backends = await listBackends();
```

### Health check

```bash
curl http://localhost:3456/health
```

---

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

---

## Trust and transparency

Dario handles your OAuth tokens and API keys locally. Here's why you can trust it:

| Signal | Status |
|---|---|
| **Source code** | ~10,750 lines of TypeScript across ~24 files — small enough to audit in a weekend |
| **Dependencies** | 0 runtime dependencies. Verify: `npm ls --production` |
| **npm provenance** | Every release is [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions with sigstore provenance attached to the transparency log |
| **Security scanning** | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) runs on every push and weekly |
| **Test footprint** | ~1,185 assertions across 32 test suites. Full `npm test` green on every release |
| **Credential handling** | Tokens and API keys never logged, redacted from errors, stored with `0600` permissions. MCP server (v3.27) redacts keys at the tool boundary too — not even a `sk-…` prefix leaks. |
| **OAuth flow** | PKCE (Proof Key for Code Exchange), no client secret. `--manual` flow for headless setups (v3.20). |
| **Network scope** | Binds to `127.0.0.1` by default. `--host` allows LAN/mesh with `DARIO_API_KEY` gating. Upstream traffic goes only to the configured backend target URLs over HTTPS |
| **SSRF protection** | `/v1/messages` hits `api.anthropic.com` only; `/v1/chat/completions` hits the configured backend `baseUrl` only — hardcoded allowlist |
| **Telemetry** | None. Zero analytics, tracking, or data collection. The MCP server (v3.27) and CC sub-agent (v3.26) are read-only by design — no tool can mutate dario's state from inside CC or an MCP client. |
| **Atomic cache writes + corruption recovery** | v3.17 — template cache writes are pid-qualified `.tmp` + `rename`, corrupt cache files are quarantined and regenerated instead of crashing startup |
| **Baked template scrub** | v3.21 — the bundled fallback template is stripped of host-identifying paths and `mcp__*` tool names at bake time; the nightly drift watcher guards against regression |
| **Audit trail** | [CHANGELOG.md](CHANGELOG.md) documents every release with file-level rationale |

Verify the npm tarball matches this repo:

```bash
npm audit signatures
npm view @askalf/dario dist.integrity
cd $(npm root -g)/@askalf/dario && npm ls --production
```

---

## FAQ

**Does this violate Anthropic's terms of service?**
Dario's Claude backend uses your existing Claude Code credentials with the same OAuth tokens CC uses. It authenticates you as you, with your subscription, through Anthropic's official API endpoints.

**What subscription plans work on the Claude backend?**
Claude Max and Claude Pro. Any plan that lets you use Claude Code.

**Does it work with Team / Enterprise?**
Should work if your plan includes Claude Code access. Not widely tested yet — open an issue with results.

**Do I need Claude Code installed?**
Recommended for the Claude backend, not strictly required. With CC installed, `dario login` picks up your credentials automatically, and the live fingerprint extractor reads your CC binary on every startup so the template stays current. Without CC, dario runs its own OAuth flow and falls back to the bundled template snapshot (scrubbed of host context at bake time as of v3.21). Drift detection warns you if your installed CC doesn't match the captured template, so upgrade windows don't silently ship stale templates.

**Do I need Bun?**
Optional, strongly recommended for Claude-backend requests. Dario auto-relaunches under Bun when available so the TLS ClientHello matches CC's runtime. Without Bun, dario runs on Node.js and works fine — the TLS fingerprint is the only difference. As of v3.23, `dario doctor` surfaces the mismatch explicitly and `--strict-tls` refuses to start proxy mode until it's resolved. The shim transport sidesteps this entirely (it runs inside CC's own process, so its TLS stack *is* CC's).

**Can I use dario without a Claude subscription?**
Yes. Skip `dario login`, just run `dario backend add openai --key=...` (or any OpenAI-compat URL) and `dario proxy`. Claude-backend requests will return an authentication error; OpenAI-compat requests will work normally. Dario becomes a local OpenAI-compat router with no Claude involvement.

**Can I route non-OpenAI providers through dario?**
Yes — anything that speaks the OpenAI Chat Completions API. Groq, OpenRouter, LiteLLM, vLLM, Ollama's openai-compat mode, your own vLLM server, any hosted inference endpoint that exposes `/v1/chat/completions`. Just `dario backend add <name> --key=... --base-url=...`.

**Something's wrong. Where do I start?**
`dario doctor`. One command, one aggregated report — dario version, Node, platform, runtime/TLS classification, CC binary compat, template source + age + drift, OAuth status, pool state, backends, sub-agent install state, home dir. Exit code 1 if any check fails. Paste the output when you file an issue. (If you're inside Claude Code, `dario subagent install` once and then ask CC to "use the dario sub-agent to run doctor" — same output, no context switch.)

**What happens when Anthropic rotates the OAuth config?**
Dario auto-detects OAuth config from the installed Claude Code binary. When CC ships a new version with rotated values, dario picks them up on the next run. Cache at `~/.dario/cc-oauth-cache-v4.json`, keyed by the CC binary fingerprint. (Path bumped from v3 → v4 in v3.19.4 to invalidate stale caches across the scope-list change that broke the authorize flow between CC v2.1.104 and v2.1.107.)

If Anthropic rotates the values before the detector is updated, you can temporarily override any field with env vars (`DARIO_OAUTH_CLIENT_ID`, `DARIO_OAUTH_AUTHORIZE_URL`, `DARIO_OAUTH_TOKEN_URL`, `DARIO_OAUTH_SCOPES`) or by writing `~/.dario/oauth-config.override.json`:

```json
{
  "clientId": "...",
  "authorizeUrl": "https://claude.com/cai/oauth/authorize",
  "tokenUrl": "https://platform.claude.com/v1/oauth/token",
  "scopes": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
}
```

Env vars win over the file. Set `DARIO_OAUTH_DISABLE_OVERRIDE=1` to force pure auto-detection.

**What happens when Anthropic changes the CC request template?**
Dario extracts the live request template from your installed Claude Code binary on startup — the system prompt, tool schemas, user-agent, beta flags, header insertion order, static header values, and top-level request-body key order — and uses those to replay requests instead of a version pinned into dario itself. When CC ships a new version with a tweaked template, the next `dario proxy` run picks it up automatically. Drift detection forces a refresh when the installed CC version changes under dario, and the nightly `cc-drift-watch` workflow catches upstream rotations (client_id, URLs, tool set, version) the day they ship on npm.

**First time setup on a fresh Claude account.**
If dario is the first thing you run against a brand-new Claude account, prime the account with a few real Claude Code commands first:
```bash
claude --print "hello"
claude --print "hello"
```
This establishes a session baseline. Without priming, brand-new accounts occasionally see billing classification issues on first use.

**I'm hitting rate limits on the Claude backend. What do I do?**
Claude subscriptions have rolling 5-hour and 7-day usage windows. Check utilization with Claude Code's `/usage` command or the [statusline](https://code.claude.com/docs/en/statusline). For multi-agent workloads, add more accounts and let pool mode distribute the load: `dario accounts add <alias>`. Session stickiness keeps long conversations pinned to one account so the prompt cache isn't destroyed by rotation.

**I'm seeing `representative-claim: seven_day` in my rate-limit headers instead of `five_hour`. Am I being downgraded to API billing?**

**No.** You're still on subscription billing. Both `five_hour` and `seven_day` are the same subscription billing mode — two different accounting buckets inside it.

| Claim | What it means |
|---|---|
| `five_hour` | You're well inside your 5-hour window; billing against the short-term bucket. |
| `seven_day` | You've exhausted (or come close to exhausting) the 5-hour window for this rolling cycle, so Anthropic is charging this request against the 7-day bucket. **Still subscription billing. Still your plan.** Not API pricing, not overage. |
| `overage` | Both subscription windows are effectively exhausted. *This* is where per-token Extra Usage charges kick in — if you've enabled Extra Usage on the account. If not, you get 429'd instead. |

Seeing `seven_day` is a healthy state. Your Max/Pro plan is doing exactly what it's supposed to do: letting you keep working past short bursts of heavy use by absorbing them into the larger 7-day bucket. When your 5-hour window rolls forward enough, the claim on new requests will go back to `five_hour` on its own. If the 7-day bucket is painful, add more Claude subscriptions to the pool — each account has its own independent 5h/7d windows, and pool mode routes each request to the account with the most headroom.

Standalone writeup: [Discussion #32 — why you see `representative-claim: seven_day` and why it's not a downgrade](https://github.com/askalf/dario/discussions/32).

**My multi-agent workload is getting reclassified to overage even though dario template-replays per request. Why?**
Reclassification at high agent volume is not a per-request problem. Anthropic's classifier operates on cumulative per-OAuth-session aggregates — token throughput, conversation depth, streaming duration, inter-arrival timing, thinking-block volume. Dario's Claude backend can make each individual request indistinguishable from Claude Code and still hit this wall on a long-running agent session. Thorough diagnostic work was contributed by [@belangertrading](https://github.com/belangertrading) in [#23](https://github.com/askalf/dario/issues/23). The practical answer at the dario layer is **pool mode** — distribute load across multiple subscriptions so no single account accumulates enough signal to trip anything. See [Multi-account pool mode](#multi-account-pool-mode). The v3.22 – v3.28 fingerprint track (pacing, stream-drain, session-id lifecycle) also narrows the cumulative signal on a single account — see [Fingerprint axes](#fingerprint-axes).

**My proxy is on Node, not Bun. What's the actual risk?**
Node uses OpenSSL, Bun uses BoringSSL — the TLS ClientHello differs enough to yield a distinct JA3/JA4 hash. Anthropic can see the hash. Whether they classify on it today is unknown; making the axis visible is the v3.23 contribution. If certainty matters to you, install Bun (dario auto-relaunches under it) or run `dario proxy --strict-tls` to fail loud. If it doesn't, the warning is ignorable — dario still works, the TLS fingerprint is just the one observable axis left.

**Why "dario"?**
It's a name, not an acronym. Don't overthink it.

---

## Technical deep dives

Longer-form writing on how dario works and why it works that way:

- [v3.0 Template Replay — why we stopped matching signals](https://github.com/askalf/dario/discussions/14)
- [Claude Code defaults are detection signals, not optimizations](https://github.com/askalf/dario/discussions/13)
- [Why Opus feels worse through other proxies and how to fix it](https://github.com/askalf/dario/discussions/9)
- [Billing tag algorithm and fingerprint analysis](https://github.com/askalf/dario/discussions/8)
- [Rate limit header analysis](https://github.com/askalf/dario/discussions/1)

The CHANGELOG documents every v3.22 – v3.28 "get ahead of Anthropic" release with file-level rationale; each one is worth reading as a standalone post on the axis it closes.

---

## Contributing

PRs welcome. The codebase is small TypeScript — ~10,750 lines across ~24 files:

| File | Purpose |
|---|---|
| `src/proxy.ts` | HTTP proxy server, request handler, rate governor, Claude backend dispatch, OpenAI-compat routing, pool failover, session registry wiring, stream-drain gating |
| `src/cc-template.ts` | CC request template engine, universal `TOOL_MAP` (~66 schema-verified entries), orchestration and framework scrubbing, header-order + body-field-order replay |
| `src/cc-template-data.json` | Bundled fallback CC request template (used when live-fingerprint extraction isn't possible). Scrubbed of host-identifying paths and `mcp__*` tools at bake time (v3.21). |
| `src/scrub-template.ts` | Host-context scrubber for the baked fallback — strips per-session sections, replaces user-dir paths with a placeholder, drops `mcp__*` tools |
| `src/cc-oauth-detect.ts` | OAuth config auto-detection from the installed CC binary |
| `src/live-fingerprint.ts` | Live extraction of the CC request template (system prompt, tools, user-agent, beta flags, header order, static header values, body field order) from the installed Claude Code binary, drift detection, compat matrix, atomic cache writes, corruption recovery |
| `src/runtime-fingerprint.ts` | Runtime / TLS classifier (`bun-match` / `bun-bypassed` / `node-only`) surfaced through `dario doctor` and `--strict-tls` (v3.23) |
| `src/pacing.ts` | Pure inter-request delay calculator with configurable floor + uniform jitter (v3.24) |
| `src/stream-drain.ts` | Pure decision function for client-disconnect handling — `abort` / `drain` / `noop` (v3.25) |
| `src/session-rotation.ts` | `SessionRegistry` with LRU eviction + pure `decideSessionRotation` — idle, jitter, max-age, per-client bucketing (v3.28) |
| `src/subagent.ts` | CC sub-agent install / remove / status lifecycle; `buildSubagentFile(version)` is pure and pinned (v3.26) |
| `src/mcp/protocol.ts` | Hand-rolled JSON-RPC 2.0 + MCP method dispatcher — zero deps, pure over inputs, tested without streams (v3.27) |
| `src/mcp/tools.ts` | Six read-only MCP tools — `doctor`, `status`, `accounts_list`, `backends_list`, `subagent_status`, `fingerprint_info`. Redacts credentials at the tool boundary (v3.27) |
| `src/mcp/server.ts` | Stdio event loop — ordered serial dispatch, back-pressure-aware writes, injectable streams for testing (v3.27) |
| `src/doctor.ts` | `dario doctor` health report aggregator — dario / Node / runtime-TLS / CC / template / drift / OAuth / pool / backends / sub-agent |
| `src/oauth.ts` | Single-account token storage, PKCE flow, auto-refresh, manual/headless flow (v3.20) |
| `src/accounts.ts` | Multi-account credential storage, independent OAuth lifecycle, refresh single-flight |
| `src/pool.ts` | Account pool, headroom-aware routing, session stickiness, failover target selection |
| `src/analytics.ts` | Rolling request history, per-account / per-model stats, burn-rate, billing bucket classification |
| `src/openai-backend.ts` | OpenAI-compat backend credential storage and request forwarder |
| `src/shim/runtime.cjs` | Hand-written CJS payload loaded into child processes via `NODE_OPTIONS=--require`; patches `globalThis.fetch` for Anthropic messages requests only |
| `src/shim/host.ts` | Parent-side orchestrator for `dario shim` — spawns the child, owns the telemetry socket / named pipe, feeds analytics |
| `src/cli.ts` | CLI entry point, command routing, Bun auto-relaunch, proxy flag parsing |
| `src/index.ts` | Library exports |

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx, no build step
npm test      # ~1,185 assertions across 32 suites
npm run e2e   # live proxy + OAuth (requires a working Claude backend)
```

---

## Contributors

| Who | Contributions |
|---|---|
| [@GodsBoy](https://github.com/GodsBoy) | Proxy authentication, token redaction, error sanitization ([#2](https://github.com/askalf/dario/pull/2)) |
| [@belangertrading](https://github.com/belangertrading) | Billing classification investigation ([#4](https://github.com/askalf/dario/issues/4)), cache_control fingerprinting ([#6](https://github.com/askalf/dario/issues/6)), billing reclassification root cause ([#7](https://github.com/askalf/dario/issues/7)), OAuth client_id discovery ([#12](https://github.com/askalf/dario/issues/12)), multi-agent session-level billing analysis ([#23](https://github.com/askalf/dario/issues/23)) |
| [@nathan-widjaja](https://github.com/nathan-widjaja) | README positioning rewrite structure ([#21](https://github.com/askalf/dario/issues/21)) |
| [@iNicholasBE](https://github.com/iNicholasBE) | macOS keychain credential detection ([#30](https://github.com/askalf/dario/pull/30)) |
| [@boeingchoco](https://github.com/boeingchoco) | Reverse-direction tool parameter translation ([#29](https://github.com/askalf/dario/issues/29)), SSE event-group framing regression catch (v3.7.1), provider-comparison diagnostic that surfaced the `--preserve-tools` discoverability gap (v3.8.1), motivating case for hybrid tool mode ([#33](https://github.com/askalf/dario/issues/33), v3.9.0), OpenClaw tool-mapping root cause that drove the universal `TOOL_MAP` work ([#36](https://github.com/askalf/dario/issues/36)) |
| [@tetsuco](https://github.com/tetsuco) | Framework-name path corruption in scrubber ([#35](https://github.com/askalf/dario/issues/35)), OpenClaw Bash/Glob reverse-mapping collisions ([#37](https://github.com/askalf/dario/issues/37)), 20x-tier invalid-x-api-key capture artifact + OAuth-scope rejection report that drove v3.19.2 / v3.19.4 / v3.19.5 ([#42](https://github.com/askalf/dario/issues/42)) |
| [@mikelovatt](https://github.com/mikelovatt) | Silent subscription-percent drain surfaced via friendly billing buckets ([#34](https://github.com/askalf/dario/issues/34)) |
| [@ringge](https://github.com/ringge) | Fingerprint-fidelity concern motivating the `--no-auto-detect` opt-out for text-tool-client auto-preserve ([#40](https://github.com/askalf/dario/issues/40), v3.20.1) |

---

## License

MIT
