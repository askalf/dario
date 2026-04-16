<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>Your Claude Max subscription, in every tool you use.<br>Plus OpenAI, Groq, OpenRouter, Ollama — one local URL. Your tools don't change a line.</strong></p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/v/@askalf/dario?color=blue" alt="npm version"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/ci.yml"><img src="https://github.com/askalf/dario/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/codeql.yml"><img src="https://github.com/askalf/dario/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://github.com/askalf/dario/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/dario" alt="License"></a>
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/dm/@askalf/dario" alt="Downloads"></a>
</p>

```bash
npm install -g @askalf/dario && dario login && dario proxy
```

Three commands. Your Claude Max subscription is now the Claude backend for **Cursor, Continue, Aider, Zed, OpenCode, Claude Code itself, your own scripts** — anything that speaks the Anthropic or OpenAI API. Point them at `http://localhost:3456` and the model name decides where the request goes: `claude-opus-4-6` hits your Max plan, `gpt-4o` hits your OpenAI key, `llama-3.3-70b` hits your Groq / OpenRouter / local vLLM.

**Zero runtime dependencies. ~6,500 lines of TypeScript. 376 tests across 12 suites. [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) on every release. Nothing phones home, ever.**

---

## Before and after

Before dario, your $200/mo Claude Max is a Claude-Code-only thing. Every other tool you open bills per-token against the Anthropic API:

| Tool | Claude backend |
|---|---|
| Claude Code | subscription ✓ |
| Cursor | pay per token |
| Aider | pay per token |
| Continue | pay per token |
| Zed | pay per token |
| Your own scripts | pay per token |

After `dario proxy`, same list:

| Tool | Claude backend | OpenAI backend | Local / OpenRouter / Groq |
|---|---|---|---|
| Claude Code | subscription ✓ | gpt-4o passthrough | passthrough |
| Cursor | **subscription ✓** | gpt-4o passthrough | passthrough |
| Aider | **subscription ✓** | gpt-4o passthrough | passthrough |
| Continue | **subscription ✓** | gpt-4o passthrough | passthrough |
| Zed | **subscription ✓** | gpt-4o passthrough | passthrough |
| Your own scripts | **subscription ✓** | gpt-4o passthrough | passthrough |

The trick: every outbound request on the Claude path is rebuilt to look exactly like a request Claude Code itself would make — system prompt, tool definitions, fingerprint headers, billing tag, beta flags — using a **live-extracted template from your actually-installed CC binary** that self-heals on every Anthropic release. Anthropic's classifier sees a CC session because, from the wire up, it is one. That's what keeps your usage on subscription billing instead of API overage.

---

## Quick start

```bash
# Install
npm install -g @askalf/dario

# Claude subscription path — uses your Claude Code OAuth if CC is installed,
# runs its own OAuth flow otherwise
dario login

# OpenAI or any OpenAI-compat backend (optional, additive)
dario backend add openai     --key=sk-proj-...
dario backend add groq       --key=gsk_...       --base-url=https://api.groq.com/openai/v1
dario backend add openrouter --key=sk-or-...     --base-url=https://openrouter.ai/api/v1
dario backend add local      --key=anything      --base-url=http://127.0.0.1:11434/v1

# Start the proxy
dario proxy

# Point every tool at one local URL
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

That's it. Every tool that honors these standard env vars now reaches every backend you configured. Switching providers is a model-name change in your tool — not a reconfigure of every SDK you've got.

---

## Why you'll install this

**You pay for Claude Max but only use it in Claude Code.** Cursor, Aider, Zed, Continue — they all want API keys and bill per-token while your $200/mo subscription sits idle. Dario routes Claude requests from all of them against your plan instead. The live fingerprint extractor reads your installed CC binary on every startup, so when Anthropic rotates the template, dario picks up the new one automatically — no release needed, no user action.

**You hit 5-hour rate limits on long agent runs.** Add a second / third subscription with `dario accounts add work` and pool mode routes each request to whichever account has the most headroom. **v3.13.0 session stickiness** pins a conversation to one account for its lifetime so the Anthropic prompt cache isn't shredded across accounts mid-conversation — a 5–10× token cost saving on cache-reused turns of a long agent session. If a 429 lands mid-request, dario fails the *in-flight request* over to a different account without your client ever seeing the error.

**You want to share capacity with a trusted group without surveilling each other.** The **v3.13.0 sealed-sender overflow protocol** uses RSA blind signatures (Chaum 1983, implemented from scratch over Node's `crypto`) so members of a trust group can lend unused Claude capacity to each other with cryptographic unlinkability. A lender verifies "this is a valid group member" without learning *which* member. It's the privacy primitive that makes friends-pool possible — and as far as I know, no other Claude router ships this.

**You want the proxy layer off the wire entirely.** **Shim mode** (v3.12.0, hardened in v3.13.0) is an in-process `globalThis.fetch` patch injected via `NODE_OPTIONS=--require`. No HTTP hop, no port to bind, no `BASE_URL` to set. Anthropic literally cannot detect this from outside the CC process without shipping signed-binary integrity checks against `globalThis` from inside their own binary. `dario shim -- claude --print "hi"` and CC thinks it's talking directly to `api.anthropic.com`.

**You want provider independence.** Switching from Claude to GPT-4o to Llama-3.3-70b to a local Qwen-Coder is a **model-name change** in your tool. Not a reconfigure. Not new base URLs. Not new API keys. Not a new SDK import. One URL, one fake key, every real provider behind it.

**You want to actually audit the thing.** ~6,500 lines of TypeScript across ~15 files. Zero runtime dependencies (`npm ls --production` confirms). Credentials stored at `~/.dario/` with `0600` permissions. `127.0.0.1`-only by default. Every release [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions. Nothing phones home. It's small enough to read in a weekend.

---

## Who this is for

**Best fit:**

- **Developers using multiple LLMs across multiple tools** tired of juggling base URLs, keys, and per-tool provider configs.
- **Claude Max / Pro subscribers** who want their subscription usable from every tool on their machine, not just Claude Code.
- **Teams running local or hosted OpenAI-compat servers** (LiteLLM, vLLM, Ollama, Groq, OpenRouter) who want one stable local endpoint that every tool reuses.
- **Power users on multi-agent workloads** who want multi-account pooling, session stickiness, and in-flight 429 failover on their own machine, against their own subscriptions.
- **Anyone building AI coding tools** who wants provider independence without writing an OpenAI ↔ Anthropic translator themselves.

**Not a fit if:**

- You need vendor-managed production SLAs on every request. Use the provider APIs directly.
- You need a hosted multi-tenant routing platform with a dashboard. Try [askalf](https://askalf.org) — different product, same family.
- You want a chat UI. Use claude.ai or chatgpt.com.

---

## Backends

Dario's routing is organized around **backends**, each with its own auth and its own target. Backends are swappable adapters — add one, your tools reach it at `localhost:3456` with whatever API shape they already speak.

### 1. Claude subscription backend (built in)

OAuth-backed Claude Max / Pro, billed against your plan instead of the API. Activated by `dario login`.

**What it does:**

- Every request is replaced with a Claude Code template before it goes upstream — 25 tool definitions, ~25KB system prompt, exact CC field order, exact beta headers, exact metadata structure. Only the conversation content is preserved. Anthropic's classifier sees what looks like a Claude Code session because, from the wire up, it *is* one — and that's what keeps your usage on subscription billing instead of Extra Usage.
- **Live fingerprint extraction** (v3.11.0). Dario spawns your installed `claude` binary against a loopback MITM endpoint on startup, captures its outbound request, and extracts the live template (system prompt, tools, user-agent, beta flags, and as of v3.13.0 the exact header insertion order). Eliminates the "Anthropic ships a new CC, dario is stale for 48 hours" window. Cached at `~/.dario/cc-template.live.json` with a 24h TTL. Falls back to the bundled snapshot if CC isn't installed.
- **Billing tag** reconstructed using CC's own algorithm: `x-anthropic-billing-header: cc_version=<version>.<build_tag>; cc_entrypoint=cli; cch=<5-char-hex>;` where `build_tag = SHA-256(seed + chars[4,7,20] of user message + version).slice(0,3)`.
- **OAuth config auto-detection** from the installed CC binary. When Anthropic rotates `client_id`, authorize URL, or scopes, dario picks up the new values on the next run without needing a release.
- **Multi-account pool mode** — see below. Automatic when 2+ accounts are configured.
- **Framework scrubbing** — known fingerprint tokens (`OpenClaw`, `sessions_*` prefixes, orchestration tags) stripped from system prompt and message content before the request leaves your machine.
- **Bun auto-relaunch** — when Bun is installed, dario relaunches under it so the TLS fingerprint matches CC's runtime. Without Bun, dario runs on Node.js.

**Passthrough mode** (`dario proxy --passthrough`) does an OAuth swap and nothing else — no template, no identity, no scrubbing. Use it when the upstream tool already builds a Claude-Code-shaped request on its own and you just need the token auth.

**Detection scope.** The Claude backend is a per-request layer. Template replay and scrubbing are designed to be indistinguishable from Claude Code at the request level. What they *cannot* defend against is Anthropic's session-level behavioral classifier, which operates on cumulative per-OAuth aggregates (token throughput, conversation depth, streaming duration, inter-arrival timing). The practical answer to that is **pool mode** — distributing load across multiple subscriptions so no one account accumulates enough signal to trip anything. See the [FAQ entry](#faq) for the full mechanism.

### 2. OpenAI-compat backend

Any provider that speaks the OpenAI Chat Completions API. Activated by:

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

**How it routes.** When the OpenAI-compat backend is configured, each request at `/v1/chat/completions` is checked:

| Request model | Route |
|---|---|
| `gpt-*`, `o1-*`, `o3-*`, `o4-*`, `chatgpt-*`, `text-davinci-*`, `text-embedding-*` | OpenAI-compat backend |
| `claude-*` (or `opus` / `sonnet` / `haiku`) | Claude subscription backend |
| Anything else | Claude backend with OpenAI-compat translation |

Passthrough for the OpenAI-compat backend is literal: client request body goes upstream as-is, only the `Authorization` header is swapped and the URL is pointed at `baseUrl + /chat/completions`. Response body streams back unchanged.

You can also force the backend with a **provider prefix** on the model field (`openai:gpt-4o`, `groq:llama-3.3-70b`, `claude:opus`, `local:qwen-coder`) regardless of what the model name looks like. See [Provider prefix](#provider-prefix).

---

## Multi-account pool mode

Dario can manage multiple Claude subscriptions and route each request to the account with the most headroom. Single-account dario is unchanged — pool mode activates **only** when `~/.dario/accounts/` contains 2+ accounts.

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

The response's `anthropic-ratelimit-unified-*` headers are parsed back into the pool so the next selection sees fresh utilization. An account that returns a 429 is marked `rejected` and routed around until its window resets. When every account is exhausted, requests queue for up to 60 seconds waiting for headroom to reappear. Accounts can mix plans — Max and Pro accounts can sit in the same pool; dario doesn't care about tier, only headroom.

### Session stickiness (v3.13.0)

Multi-turn agent sessions now pin to one account for the life of the conversation, so the Anthropic prompt cache isn't destroyed by account rotation between turns.

**The problem.** Claude Max prompt cache is scoped to `{account × cache_control key}`. When the pool rotates a long agent conversation across accounts on headroom alone, turn 1 builds a cache entry on account A, turn 2 lands on account B and reads nothing from A's cache — paying full cache-create cost again. For a long agent session that's a 5–10× token cost multiplier on the cache-reused portion of every turn after the first.

**The fix.** Dario hashes a conversation's first user message into a 16-hex-char `stickyKey` (SHA-256 truncated, deterministic) and binds the key to whichever account `select()` would have picked on turn 1. Subsequent turns re-use that account as long as it's still healthy (not rejected, token not near expiry, headroom > 2%). On 429 failover, dario rebinds the key to the new account so the next turn doesn't re-select the exhausted one. 6h TTL, 2,000-entry cap, lazy cleanup. No client cooperation required — it works through the normal proxy path with nothing to configure.

### In-flight 429 failover (v3.8.0+)

When a Claude request hits a 429 mid-flight, dario retries the *same request* against a different account before the client ever sees an error. The client sees one successful response; the pool sees the rejected account go cold until its window resets. Combined with session stickiness, this means long agent runs survive pool-level exhaustion without dropping user-facing turns.

### Inspection

```bash
curl http://localhost:3456/accounts     # per-account utilization, claim, sticky bindings, status
curl http://localhost:3456/analytics    # per-account / per-model stats, burn rate, exhaustion predictions
```

---

## Sealed-sender overflow protocol (v3.13.0)

Trust-group members can lend each other Claude capacity with **cryptographic unlinkability**: a lender can verify the borrower is a valid group member without learning *which* member, so no one in the pool can surveil another through borrow telemetry.

**The primitive.** RSA blind signatures (Chaum 1983), implemented from scratch on top of Node's `crypto` module using `RSA_NO_PADDING` for raw `m^e mod n` / `c^d mod n` primitives. Full-Domain Hash via MGF1-SHA256 (with counter retry) prevents multiplicative forgery. The flow: the group admin signs *blinded* tokens in a batch without seeing their real values; the member unblinds locally to obtain valid RSA-FDH signatures on random tokens the admin has never seen and can never correlate back to the member. When a member spends a token with a lender, the lender verifies the signature with the group public key — it proves "some member got this signed" without identifying who.

**What this is, and what it isn't.** This is **privacy between group members**, not anonymity from Anthropic. When a lender accepts a borrow, the actual upstream request still lands under the lender's attributable Claude account identity — Anthropic sees the lender as the originator, exactly as they would for any other request on that account. The cryptographic unlinkability protects group members from each other: no member can correlate borrow telemetry back to another member's identity.

**What's in v3.13.0:**

- `src/sealed-pool.ts` — ~550 lines. `GroupAdmin` / `GroupMember` / `GroupLender` classes with quota/expiry enforcement, SHA-256-hashed double-spend set, JSON wire envelope (`{v:1, groupId, token, sig, request}`), and key export/import for distributing group credentials.
- `POST /v1/pool/borrow` endpoint on the proxy, gated on `~/.dario/group.json`. Positioned before `checkAuth` — the group signature *is* the authentication, so doubling it with a local API key would add nothing. Verified borrows delegate to `pool.select()` and forward upstream under the lender's account.
- 57 test assertions covering raw RSA roundtrip, unlinkability, wrong-key / tampered-sig / wrong-group / double-spend rejection, key export/import, admin membership / quota / expiry enforcement, concurrent-borrow double-spend prevention, and end-to-end two-member unlinkability.

Full feature-parity with `/v1/messages` (streaming, inside-request 429 failover, reverse tool mapping) for borrowed requests is intentionally a follow-up — v3.13.0 ships the cryptographic primitive and a working minimal endpoint; full integration layers on top.

---

## Shim mode

*Experimental, opt-in. The default path is still the HTTP proxy — shim mode is a second transport, not a replacement.*

Shim mode runs a child process with an **in-process `globalThis.fetch` patch** that rewrites the child's outbound requests to `api.anthropic.com/v1/messages` exactly the way the proxy would, then sends them directly from the child to Anthropic. No localhost HTTP hop. No port to bind. No `ANTHROPIC_BASE_URL` to set.

```bash
dario shim -- claude --print "hello"
dario shim -v -- claude --print "hello"        # verbose
```

Under the hood: `dario shim` spawns the child with `NODE_OPTIONS=--require <dario-runtime.cjs>` and a unix socket / named pipe for telemetry. The runtime patches `globalThis.fetch` only for Anthropic messages requests, applies the same template replay the proxy does, and relays per-request events back to the parent so analytics still work. Every other fetch call in the child is untouched and failsafe-passes through on any internal error.

**Why it matters.** Anthropic can fingerprint a proxy via TLS, headers, IP, or `BASE_URL` env. They literally cannot easily detect a `globalThis.fetch` monkey-patch from inside their own process without shipping signed-binary integrity checks against `globalThis` — and even then, the shim runs *before* CC's code loads, so it could patch the integrity check too. This is the transport that has the longest half-life against classifier evolution.

**v3.13.0 hardening.** The shim got a significant robustness pass:

- **Runtime detection** — `detectRuntime()` checks `globalThis.Bun` / `globalThis.Deno` / `process.versions.node` and logs a warning for non-Node runtimes. Canary for the day Anthropic ships a Bun-compiled CC.
- **Template mtime-based auto-reload** — long-running child processes pick up mid-session fingerprint refreshes from dario's live capture without restart.
- **Strict defensive `rewriteBody`** — the previous logic accepted `length >= 1` on the system array and invented `[1]`/`[2]` blocks out of thin air. Now requires exactly `length === 3` with all-text blocks; any mismatch passes through unchanged. Passthrough on an unknown shape is safer than blind replacement.
- **`rewriteHeaders` honors captured header order** — the live fingerprint capture now records the exact order CC emits headers on the wire, and the shim replays that order on every outbound request. Header sequence alone is a fingerprint vector; v3.13.0 removes it.
- **`checkVersionDrift`** — logs when the child's UA `cc_version` differs from the template's, so stale-cache windows during CC upgrades are visible in debug output.

**When to use shim mode:**
- Running a single CC instance on a locked-down machine where binding a local port is inconvenient or forbidden.
- Wrapping one-off scripts (`dario shim -- node my-agent.js`) without setting up environment variables.
- Debugging a specific child process in isolation — verbose logs are scoped to that process.
- You suspect Anthropic is fingerprinting your proxy traffic and you want to take the proxy off the wire.

**When to stay on the proxy** (which is still the default):
- Multi-client routing. The proxy serves every tool on the machine through one endpoint; the shim wraps one child at a time.
- Multi-account pool mode. Pooling across subscriptions needs a shared OAuth pool the proxy owns — a shim patch inside one child can't see pool state across other processes.
- Anything that isn't a Node / Bun child. The shim relies on `NODE_OPTIONS`, so non-JS runtimes (Python SDK, a Go CLI) still need the proxy.

See the [v3.12.0 release notes](https://github.com/askalf/dario/releases/tag/v3.12.0) for the original design writeup and [v3.13.0](https://github.com/askalf/dario/releases/tag/v3.13.0) for the hardening notes.

---

## Commands

| Command | Description |
|---|---|
| `dario login` | Log in to the Claude backend (detects CC credentials or runs its own OAuth flow) |
| `dario proxy` | Start the local API proxy on port 3456 |
| `dario status` | Show Claude backend OAuth token health and expiry |
| `dario refresh` | Force an immediate Claude token refresh |
| `dario logout` | Delete stored Claude credentials |
| `dario accounts list` | List accounts in the multi-account pool |
| `dario accounts add <alias>` | Add a Claude account to the pool (runs OAuth flow) |
| `dario accounts remove <alias>` | Remove an account from the pool |
| `dario backend list` | List configured OpenAI-compat backends |
| `dario backend add <name> --key=<key> [--base-url=<url>]` | Add an OpenAI-compat backend |
| `dario backend remove <name>` | Remove an OpenAI-compat backend |
| `dario shim -- <cmd> [args...]` | Run a child process with the in-process fetch patch (see [Shim mode](#shim-mode)) |
| `dario help` | Full command reference |

### Proxy options

| Flag / env | Description | Default |
|---|---|---|
| `--passthrough` / `--thin` | Thin proxy for the Claude backend — OAuth swap only, no template injection | off |
| `--preserve-tools` / `--keep-tools` | Keep client tool schemas instead of remapping to CC's `Bash/Read/Grep/Glob/WebSearch/WebFetch`. Required for clients whose tools have fields CC doesn't — see [Custom tool schemas](#custom-tool-schemas). | off |
| `--hybrid-tools` / `--context-inject` | Remap to CC tools **and** inject request-context values (`sessionId`, `requestId`, `channelId`, `userId`, `timestamp`) into client-declared fields CC's schema doesn't carry. See [Hybrid tool mode](#hybrid-tool-mode). | off |
| `--model=<name>` | Force a model. Shortcuts (`opus`, `sonnet`, `haiku`), full IDs (`claude-opus-4-6`), or a **provider prefix** (`openai:gpt-4o`, `groq:llama-3.3-70b`, `claude:opus`, `local:qwen-coder`) to force the backend server-wide. See [Provider prefix](#provider-prefix). | passthrough |
| `--port=<n>` | Port to listen on | `3456` |
| `--host=<addr>` / `DARIO_HOST` | Bind address. Use `0.0.0.0` for LAN, or a specific IP (e.g. a Tailscale interface). When non-loopback, also set `DARIO_API_KEY`. | `127.0.0.1` |
| `--verbose` / `-v` | Log every request | off |
| `DARIO_API_KEY` | If set, all endpoints (except `/health`) require a matching `x-api-key` or `Authorization: Bearer` header. Required when `--host` binds non-loopback. | unset (open) |
| `DARIO_CORS_ORIGIN` | Override browser CORS origin | `http://localhost:${port}` |
| `DARIO_NO_BUN` | Disable automatic Bun relaunch | unset |
| `DARIO_MIN_INTERVAL_MS` | Minimum ms between Claude-backend requests (rate governor) | `500` |
| `DARIO_CC_PATH` | Override path to the Claude Code binary for OAuth detection | auto-detect |

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
    model="claude-opus-4-6",
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

# claude-opus-4-6 routes to the Claude subscription backend — same SDK, same URL
claude_msg = client.chat.completions.create(
    model="claude-opus-4-6",
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
  model: "claude-opus-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### OpenAI-compatible tools (Cursor, Continue, Aider, LiteLLM, …)

```bash
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Any tool that accepts an OpenAI base URL works. Use Claude model names (`claude-opus-4-6`, `opus`, `sonnet`, `haiku`) for the Claude backend, or GPT-family names for the configured OpenAI-compat backend.

### curl

```bash
# Claude backend via Anthropic format
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'

# OpenAI backend via OpenAI format
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dario" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

### Streaming, tool use, prompt caching, extended thinking

All supported. Claude backend: full Anthropic SSE format plus OpenAI-SSE translation for tool_use streaming. OpenAI-compat backend: streaming body forwarded byte-for-byte.

### Provider prefix

Any request's `model` field can be written as `<provider>:<name>` to force which backend handles it, regardless of what the model name looks like. Useful when regex-based routing (`gpt-*` → OpenAI, `claude-*` → Claude) doesn't match — for example when routing a `llama-3.3-70b` request through an OpenAI-compat backend, or when you want the same model name to go to different providers on different requests.

Recognized prefixes:

| Prefix | Backend |
|---|---|
| `openai:` | OpenAI-compat backend (the configured one) |
| `groq:` | OpenAI-compat backend |
| `openrouter:` | OpenAI-compat backend |
| `local:` | OpenAI-compat backend |
| `compat:` | OpenAI-compat backend |
| `claude:` | Claude subscription backend |
| `anthropic:` | Claude subscription backend |

The prefix gets stripped before the request goes upstream — the backend only sees the bare model name. Unrecognized prefixes are ignored, so ollama-style `llama3:8b` passes through untouched. `dario proxy --model=openai:gpt-4o` applies the prefix to every request server-wide.

### Custom tool schemas

By default, on the Claude backend, dario replaces your client's tool definitions with the real Claude Code tools (`Bash`, `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`) and translates parameters back and forth. That's how dario looks like CC on the wire, which is what lets your request bill against your Claude subscription instead of API pricing.

The trade-off: if your client's tools carry fields CC's schema doesn't have — a `sessionId`, a custom request id, a channel-bound context token — those fields don't survive the round trip. The model only ever sees `Bash({command})`, responds with `Bash({command})`, and dario's reverse map rebuilds your tool call without the fields the model never saw. Your validator then rejects the call for a missing required field.

Symptom: your tool calls come back looking stripped-down, or your runtime complains about a required field being absent *only when routed through dario's Claude backend*, while the same tools work fine against a direct API key or the OpenAI-compat backend.

Fix: run dario with `--preserve-tools`. That skips the CC tool remap entirely, passes your client's tool definitions through to the model unchanged, and lets the model populate every field your schema expects.

```bash
dario proxy --preserve-tools
```

The cost: requests no longer look like CC on the wire, so the CC subscription fingerprint is gone. On a Max/Pro plan, that means the request may be counted against your API usage rather than your subscription quota. If you're on API-key billing already, `--preserve-tools` is free; if you're using dario specifically to route against a subscription, [hybrid tool mode](#hybrid-tool-mode) below is the compromise that keeps both.

The openai-compat backend (OpenRouter, OpenAI, Groq, local LiteLLM) is unaffected — it forwards tool definitions byte-for-byte and doesn't need this flag.

### Hybrid tool mode

For the very common case where the "missing" fields on your client's tool are **request context** — `sessionId`, `requestId`, `channelId`, `userId`, `timestamp` — dario can remap to CC tools *and* inject those values on the reverse path. The fingerprint stays intact, the model still sees only CC's tools (so subscription billing still routes), and your validator still sees the fields it requires because dario fills them from request headers on the way back.

```bash
dario proxy --hybrid-tools
```

**How it works.** On each request, dario builds a `RequestContext` from headers (`x-session-id`, `x-request-id`, `x-channel-id`, `x-user-id`) plus its own generated ids and the current timestamp. After `translateBack` produces the client-shaped tool call on the response path, any field declared on the client's tool schema whose name matches a known context field (`sessionId`/`session_id`, `requestId`/`request_id`, `channelId`/`channel_id`, `userId`/`user_id`, `timestamp`/`created_at`/`createdAt`) and isn't already populated gets filled from the context. Fields the model genuinely populated via `translateBack` are never overwritten.

**When to use which flag:**

| Your situation | Flag | Why |
|---|---|---|
| Your custom fields are request context (session/request/channel/user ids, timestamps) | `--hybrid-tools` | Keeps the CC fingerprint *and* your validator is satisfied. |
| Your custom fields need the model's reasoning (e.g. `confidence`, `reasoning_trace`, `tool_selection_rationale`) | `--preserve-tools` | The model has to see the real schema to populate these. Accept the fingerprint loss. |
| Your client's tools are already a subset of CC's `Bash/Read/Grep/Glob/WebSearch/WebFetch` | *(neither)* | Default mode works as-is. |

Hybrid mode was built to resolve [#29](https://github.com/askalf/dario/issues/29) cleanly for OpenClaw-style agents whose `process` tool declares `sessionId`, after the full provider-comparison diagnostic from [@boeingchoco](https://github.com/boeingchoco) made clear that the problem wasn't fixable in the translation layer alone.

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
| `POST /v1/pool/borrow` | Sealed-sender borrow endpoint (v3.13.0). Accepts group-signed tokens and forwards the request through the lender's pool. |
| `GET /v1/models` | Model list (Claude models — OpenAI models come from the OpenAI backend directly) |
| `GET /health` | Proxy health + OAuth status + request count |
| `GET /status` | Detailed Claude OAuth token status |
| `GET /accounts` | Pool snapshot including sticky binding count (pool mode only) |
| `GET /analytics` | Per-account / per-model stats, burn rate, exhaustion predictions. Every request carries a `billingBucket` field (`subscription` / `subscription_fallback` / `extra_usage` / `api` / `unknown`) so you can see which bucket each request billed against. |

---

## Trust and transparency

Dario handles your OAuth tokens and API keys locally. Here's why you can trust it:

| Signal | Status |
|---|---|
| **Source code** | ~6,500 lines of TypeScript across ~15 files — small enough to audit in a weekend |
| **Dependencies** | 0 runtime dependencies. Verify: `npm ls --production` |
| **npm provenance** | Every release is [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions with sigstore provenance attached to the transparency log |
| **Security scanning** | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) runs on every push and weekly |
| **Test footprint** | 376 assertions across 12 files. Full `npm test` green on every release |
| **Credential handling** | Tokens and API keys never logged, redacted from errors, stored with `0600` permissions |
| **OAuth flow** | PKCE (Proof Key for Code Exchange), no client secret |
| **Network scope** | Binds to `127.0.0.1` by default. `--host` allows LAN/mesh with `DARIO_API_KEY` gating. Upstream traffic goes only to the configured backend target URLs over HTTPS |
| **SSRF protection** | `/v1/messages` hits `api.anthropic.com` only; `/v1/chat/completions` hits the configured backend `baseUrl` only — hardcoded allowlist |
| **Telemetry** | None. Zero analytics, tracking, or data collection |
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
Recommended for the Claude backend, not strictly required. With CC installed, `dario login` picks up your credentials automatically, and the live fingerprint extractor reads your CC binary on every startup so the template stays current. Without CC, dario runs its own OAuth flow and falls back to the bundled template snapshot.

**Do I need Bun?**
Optional, recommended for Claude-backend requests. Dario auto-relaunches under Bun when available so the TLS fingerprint matches CC's runtime. Without Bun, dario runs on Node.js and works fine; the TLS fingerprint is the only difference.

**First time setup on a fresh Claude account.**
If dario is the first thing you run against a brand-new Claude account, prime the account with a few real Claude Code commands first:
```bash
claude --print "hello"
claude --print "hello"
```
This establishes a session baseline. Without priming, brand-new accounts occasionally see billing classification issues on first use.

**What happens when Anthropic rotates the OAuth config?**
Dario auto-detects OAuth config from the installed Claude Code binary. When CC ships a new version with rotated values, dario picks them up on the next run. Cache at `~/.dario/cc-oauth-cache-v3.json`, keyed by the CC binary fingerprint.

**What happens when Anthropic changes the CC request template?**
Dario extracts the live request template from your installed Claude Code binary on startup — the system prompt, tool schemas, user-agent, beta flags, and as of v3.13.0 the exact header insertion order — and uses those to replay requests instead of a version pinned into dario itself. When CC ships a new version with a tweaked template, the next `dario proxy` run picks it up automatically. Fallback: the hand-curated `src/cc-template-data.json` bundled with the release.

**I'm hitting rate limits on the Claude backend. What do I do?**
Claude subscriptions have rolling 5-hour and 7-day usage windows. Check utilization with Claude Code's `/usage` command or the [statusline](https://code.claude.com/docs/en/statusline). For multi-agent workloads, add more accounts and let pool mode distribute the load: `dario accounts add <alias>`. As of v3.13.0, pool mode also keeps long conversations pinned to one account so the Anthropic prompt cache isn't destroyed by rotation.

**I'm seeing `representative-claim: seven_day` in my rate-limit headers instead of `five_hour`. Am I being downgraded to API billing?**

**No.** You're still on subscription billing. Both `five_hour` and `seven_day` are the same subscription billing mode — they're just two different accounting buckets inside it.

Here's the full picture. Every Claude Max and Pro subscription has **two rolling usage windows**:

- **5-hour window** — your short-term usage bucket. Refreshes on a rolling 5-hour schedule.
- **7-day window** — your longer-term usage bucket. Refreshes on a rolling 7-day schedule. Intentionally larger than the 5-hour one so you can keep working past brief bursts of heavy usage.

When Anthropic bills a request, it decides which bucket to charge it against based on your current utilization. That decision comes back in the `anthropic-ratelimit-unified-representative-claim` response header:

| Claim | What it means |
|---|---|
| `five_hour` | You're well inside your 5-hour window; billing against the short-term bucket. |
| `seven_day` | You've exhausted (or come close to exhausting) the 5-hour window for this rolling cycle, so Anthropic is now charging this request against the 7-day bucket. **Still subscription billing. Still your plan.** Not API pricing, not overage. |
| `overage` | Both subscription windows are effectively exhausted. *This* is where per-token Extra Usage charges kick in — if you've enabled Extra Usage on the account. If you haven't, you get 429'd instead. |

**Seeing `seven_day` is a healthy state.** Your Max/Pro plan is doing exactly what it's supposed to do: letting you keep working past short bursts of heavy use by absorbing them into the larger 7-day bucket. Your subscription is not being "downgraded." When your 5-hour window rolls forward enough, the claim on new requests will go back to `five_hour` on its own.

**Practical answer if `seven_day` is painful for your workload.** Add more Claude subscriptions to the pool. Each account has its own independent 5-hour and 7-day windows, and pool mode routes each request to the account with the most headroom. With 2-3 accounts, you almost never see the `seven_day` bucket get touched. `dario accounts add <alias>`.

Standalone writeup: [Discussion #32 — why you see `representative-claim: seven_day` and why it's not a downgrade](https://github.com/askalf/dario/discussions/32).

**My multi-agent workload is getting reclassified to overage even though dario template-replays per request. Why?**
Reclassification at high agent volume is not a per-request problem. Anthropic's classifier operates on cumulative per-OAuth-session aggregates — token throughput, conversation depth, streaming duration, inter-arrival timing, thinking-block volume. Dario's Claude backend can make each individual request indistinguishable from Claude Code and still hit this wall on a long-running agent session, because the wall isn't at the request level. Thorough diagnostic work on this was contributed by [@belangertrading](https://github.com/belangertrading) in [#23](https://github.com/askalf/dario/issues/23). The practical answer at the dario layer is **pool mode** — distribute load across multiple subscriptions so no single account accumulates enough signal to trip anything. See [Multi-account pool mode](#multi-account-pool-mode).

**Can I route non-OpenAI providers through dario?**
Yes — anything that speaks the OpenAI Chat Completions API. Groq, OpenRouter, LiteLLM, vLLM, Ollama's openai-compat mode. Just `dario backend add <name> --key=... --base-url=...`.

**Does dario work with only the OpenAI backend, no Claude subscription?**
Yes. Skip `dario login`, just run `dario backend add openai --key=...` and `dario proxy`. Claude-backend requests will return an authentication error; OpenAI-compat requests will work normally. Dario becomes a local OpenAI-compat shim with no Claude involvement.

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

---

## Contributing

PRs welcome. The codebase is small TypeScript — around ~6,500 lines across ~15 files:

| File | Purpose |
|---|---|
| `src/proxy.ts` | HTTP proxy server, request handler, rate governor, Claude backend dispatch |
| `src/cc-template.ts` | CC request template engine, tool mapping, orchestration and framework scrubbing |
| `src/cc-template-data.json` | Bundled fallback CC request template (used when live-fingerprint extraction isn't possible) |
| `src/cc-oauth-detect.ts` | OAuth config auto-detection from the installed CC binary |
| `src/live-fingerprint.ts` | Live extraction of the CC request template (system prompt, tools, user-agent, beta flags, header order) from the installed Claude Code binary |
| `src/oauth.ts` | Single-account token storage, PKCE flow, auto-refresh |
| `src/accounts.ts` | Multi-account credential storage and independent OAuth lifecycle |
| `src/pool.ts` | Account pool, headroom-aware routing, session stickiness, failover target selection |
| `src/sealed-pool.ts` | **v3.13.0.** Sealed-sender overflow protocol — RSA blind signatures for unlinkable group pooling |
| `src/analytics.ts` | Rolling request history, per-account / per-model stats, burn-rate, billing bucket classification |
| `src/openai-backend.ts` | OpenAI-compat backend credential storage and request forwarder |
| `src/shim/runtime.cjs` | Hand-written CJS payload loaded into child processes via `NODE_OPTIONS=--require`; patches `globalThis.fetch` for Anthropic messages requests only |
| `src/shim/host.ts` | Parent-side orchestrator for `dario shim` — spawns the child, owns the telemetry socket / named pipe, feeds analytics |
| `src/cli.ts` | CLI entry point, command routing, Bun auto-relaunch |
| `src/index.ts` | Library exports |

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx, no build step
npm test      # 376 assertions across 12 suites
```

---

## Contributors

| Who | Contributions |
|---|---|
| [@GodsBoy](https://github.com/GodsBoy) | Proxy authentication, token redaction, error sanitization ([#2](https://github.com/askalf/dario/pull/2)) |
| [@belangertrading](https://github.com/belangertrading) | Billing classification investigation ([#4](https://github.com/askalf/dario/issues/4)), cache_control fingerprinting ([#6](https://github.com/askalf/dario/issues/6)), billing reclassification root cause ([#7](https://github.com/askalf/dario/issues/7)), OAuth client_id discovery ([#12](https://github.com/askalf/dario/issues/12)), multi-agent session-level billing analysis ([#23](https://github.com/askalf/dario/issues/23)) |
| [@nathan-widjaja](https://github.com/nathan-widjaja) | README positioning rewrite structure ([#21](https://github.com/askalf/dario/issues/21)) |
| [@iNicholasBE](https://github.com/iNicholasBE) | macOS keychain credential detection ([#30](https://github.com/askalf/dario/pull/30)) |
| [@boeingchoco](https://github.com/boeingchoco) | Reverse-direction tool parameter translation ([#29](https://github.com/askalf/dario/issues/29)), SSE event-group framing regression catch (v3.7.1), provider-comparison diagnostic that surfaced the `--preserve-tools` discoverability gap (v3.8.1), motivating case for hybrid tool mode ([#33](https://github.com/askalf/dario/issues/33), v3.9.0) |

---

## License

MIT
