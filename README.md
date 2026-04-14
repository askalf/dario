<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>A local LLM router. One endpoint on your machine, every provider behind it, your tools don't need to change.</strong></p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/v/@askalf/dario?color=blue" alt="npm version"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/ci.yml"><img src="https://github.com/askalf/dario/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/codeql.yml"><img src="https://github.com/askalf/dario/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://github.com/askalf/dario/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/dario" alt="License"></a>
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/dm/@askalf/dario" alt="Downloads"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#who-this-is-for">Who it's for</a> &bull;
  <a href="#backends">Backends</a> &bull;
  <a href="#why-switch">Why switch</a> &bull;
  <a href="#trust--transparency">Trust</a> &bull;
  <a href="#faq">FAQ</a>
</p>

---

## What it is

Dario runs on your machine and gives every tool you use one local URL that reaches **every LLM you use.** Point Cursor, Continue, Aider, LiteLLM, your own scripts — anything that speaks the Anthropic or OpenAI API — at `http://localhost:3456`, and dario routes each request to the right backend:

- **Claude Max / Pro subscriptions** — OAuth-backed, billed against your plan instead of API pricing. Multi-account pooling if you have more than one.
- **OpenAI** — your API key, routed to `api.openai.com` straight through.
- **Any OpenAI-compat endpoint** — OpenRouter, Groq, a local LiteLLM, Ollama's openai-compat mode, self-hosted vLLM. Set the backend's `baseUrl` once, done.

Your tool sees one base URL. `gpt-4` goes to OpenAI. `claude-opus-4-6` goes to your Claude subscription. `llama-3-70b` goes to Groq. None of your tools have to know about any of it.

**No account anywhere is required.** Single-backend Claude dario works with nothing but `dario login`. Multi-backend dario works with nothing but local config files. Nothing phones home. Zero runtime dependencies. ~2,000 lines of TypeScript.

---

## Who this is for

**Best fit:**

- **Developers using multiple LLMs across multiple tools** who are tired of juggling base URLs, API keys, and per-tool provider configs.
- **Claude Max or Pro subscribers** who want their subscription usable anywhere that speaks the Anthropic or OpenAI API — without paying API rates for every request.
- **Teams running local or hosted OpenAI-compat servers** (LiteLLM, vLLM, Ollama, Groq, OpenRouter) who want one stable local endpoint in front of them that every tool can reuse.
- **Power users running multi-agent workloads on Claude subscriptions** who want multi-account pooling with headroom-aware routing on their own machine, against their own subscriptions, without a hosted platform.

**Not a fit:**

- You need vendor-managed production SLAs on every request. Use the provider APIs directly.
- You need a hosted multi-tenant routing platform with a dashboard. Try [askalf](https://askalf.org), a separate product in the same family — different problem, different tool.
- You want a chat UI. Use claude.ai or chatgpt.com.

---

## First use case

> I install dario, point every tool I already use at `http://localhost:3456`, and every LLM I have access to works through that one URL.

Flow on a fresh machine:

```bash
# Install
npm install -g @askalf/dario

# Optional: log in to your Claude subscription (Max or Pro)
dario login

# Optional: add an OpenAI-compat backend
dario backend add openai --key=sk-proj-...

# Start the proxy
dario proxy

# Use it — set these once, every tool that honors them just works
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Now from the same Cursor/Continue/Aider instance:

- `gpt-4o` → OpenAI, your key, straight through
- `claude-opus-4-6` → Claude subscription, billed against your Max plan
- `opus` → shortcut, same as above
- `llama-3.1-70b` on OpenRouter → configure `dario backend add openrouter --key=sk-or-... --base-url=https://openrouter.ai/api/v1`, done

One URL. Your tool doesn't know or care which provider is answering.

---

## Why switch

**Use dario if** you use more than one LLM provider, or more than one tool, or both — and you're tired of configuring each tool with a different base URL and API key per provider.

**Use dario if** you pay for Claude Max or Pro and you want that subscription reachable from every tool on your machine, without paying API rates or opening a second billing surface.

**Use dario pool mode if** you're running multi-agent workloads on Claude subscriptions and hitting per-account rate limits. Add 2–N accounts with `dario accounts add` and dario routes across them by per-account headroom, all on your machine, against your own subscriptions. See [Multi-Account Pool Mode](#multi-account-pool-mode).

**Use a provider API directly if** you need vendor-managed production SLAs or high-scale orchestration primitives the providers ship themselves. Dario isn't trying to replace their APIs — it's trying to put one local shim in front of all of them so your tools don't care which is which.

**Don't use dario if** you want a subprocess bridge that shells out to `claude --print` under the hood (openclaw-claude-bridge and similar). That's a valid answer for single-team single-machine workloads that can accept a one-subscription rate ceiling and a one-machine deployment — different tradeoffs, different tool.

---

## Quick Start

```bash
# Install
npm install -g @askalf/dario

# Claude subscription path (detects Claude Code credentials if CC is installed,
# runs its own OAuth flow otherwise)
dario login

# OpenAI or any OpenAI-compat provider (optional, additive)
dario backend add openai --key=sk-proj-...

# Start the proxy
dario proxy

# Point anything that speaks the Anthropic or OpenAI API at localhost:3456
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Opus, Sonnet, Haiku, GPT-4o, o1, o3, o4, plus anything the configured OpenAI-compat backend serves. Streaming, tool use, prompt caching, extended thinking. **Zero runtime dependencies.** Auto-launches under [Bun](https://bun.sh) when available for TLS fingerprint fidelity with Claude Code's runtime on the Claude path.

---

## Backends

Dario's routing is organized around **backends**, each with its own auth and its own target. v3.6.0 ships two backends, with more coming.

### 1. Claude subscription backend (built in)

OAuth-backed Claude Max / Pro, billed against your plan instead of the API. Activated by `dario login`.

**What it does:**

- Every request is replaced with a Claude Code template before it goes upstream — 25 tool definitions, 25KB system prompt, exact CC field order, exact beta headers, exact metadata structure. Only the conversation content is preserved. Anthropic's classifier sees what looks like a Claude Code session because, from the wire up, it *is* one — and that's what keeps your usage on subscription billing instead of Extra Usage.
- **Billing tag** reconstructed using CC's own algorithm: `x-anthropic-billing-header: cc_version=<version>.<build_tag>; cc_entrypoint=cli; cch=<5-char-hex>;` where `build_tag = SHA-256(seed + chars[4,7,20] of user message + version).slice(0,3)`.
- **OAuth config** auto-detected from the installed CC binary at startup. When Anthropic rotates `client_id`, authorize URL, or scopes, dario picks up the new values on the next run without needing a release.
- **Multi-account pool mode** — see below. Automatic when 2+ accounts are configured.
- **Framework scrubbing** — known fingerprint tokens (`OpenClaw`, `sessions_*` prefixes, orchestration tags) stripped from system prompt and message content before the request leaves your machine.
- **Bun auto-relaunch** — when Bun is installed, dario relaunches under it so the TLS fingerprint matches CC's runtime. Without Bun, dario runs on Node.js.

**Passthrough mode** (`dario proxy --passthrough`) does an OAuth swap and nothing else — no template, no identity, no scrubbing. Use it when the upstream tool already builds a Claude-Code-shaped request on its own and you just need the token auth.

**Detection scope.** The Claude backend is a per-request layer. Template replay and scrubbing are designed to be indistinguishable from Claude Code at the request level. What they *cannot* defend against is Anthropic's session-level behavioral classifier, which operates on cumulative per-OAuth aggregates (token throughput, conversation depth, streaming duration, inter-arrival timing). The practical answer to that is **pool mode** — distributing load across multiple subscriptions so no one account accumulates enough signal to trip anything. See the [FAQ entry](#faq) for the full mechanism.

### 2. OpenAI-compat backend (v3.6.0+)

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

Dario's passthrough for the OpenAI-compat backend is literal: client request body goes upstream as-is, only the `Authorization` header is swapped for the configured API key and the URL is pointed at `baseUrl + /chat/completions`. Response body streams back unchanged.

### Coming in a follow-up

- **Anthropic → OpenAI request translation** for `/v1/messages` requests with GPT-family model names (tool_use format, streaming delta conversion).
- **Multiple simultaneous openai-compat backends** with per-model routing rules (`gpt-*` → OpenAI, `llama-*` → Groq, `mixtral-*` → OpenRouter).
- **Fallback rules.** "If Claude 429s, use Gemini." v3.6.0 ships the routing plumbing; fallback logic layers on top.

---

## Multi-Account Pool Mode

*New in v3.5.0, for the Claude subscription backend.* Dario can manage multiple Claude subscriptions and route each request to the account with the most headroom. Single-account Claude dario is unchanged — pool mode activates **only** when `~/.dario/accounts/` contains 2+ accounts.

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

The response's `anthropic-ratelimit-unified-*` headers are parsed back into the pool so the next selection sees fresh utilization. An account that returns a 429 is marked `rejected` and routed around until its window resets. When every account is exhausted, requests queue for up to 60 seconds waiting for headroom to reappear.

Accounts can mix plans — Max and Pro accounts can sit in the same pool; dario doesn't care about tier, only headroom.

**Pool inspection endpoints:**

```bash
curl http://localhost:3456/accounts     # per-account utilization, claim, status
curl http://localhost:3456/analytics    # per-account / per-model stats, burn rate, exhaustion predictions
```

**Scope.** v3.5.0 ships headroom-aware selection *across* requests — a 429 on one request marks the account rejected and the next request goes to a different one. Retrying a single in-flight request against a different account when that request 429s (inside-request failover) ships in v3.5.1 along with analytics recording wiring.

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
| `dario help` | Full command reference |

### Proxy options

| Flag / env | Description | Default |
|---|---|---|
| `--passthrough` / `--thin` | Thin proxy for the Claude backend — OAuth swap only, no template injection | off |
| `--preserve-tools` / `--keep-tools` | Keep client tool schemas instead of remapping to CC tools (Claude backend) | off |
| `--model=<name>` | Force a model (`opus`, `sonnet`, `haiku`, or full ID). Applies to the Claude backend. | passthrough |
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
| `GET /accounts` | Pool snapshot (pool mode only) |
| `GET /analytics` | Per-account / per-model stats, burn rate, exhaustion predictions (pool mode only) |

---

## Trust & Transparency

Dario handles your OAuth tokens and API keys locally. Here's why you can trust it:

| Signal | Status |
|---|---|
| **Source code** | ~2,500 lines of TypeScript across 10 files — small enough to audit in one sitting |
| **Dependencies** | 0 runtime dependencies. Verify: `npm ls --production` |
| **npm provenance** | Every release is [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions |
| **Security scanning** | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) runs on every push and weekly |
| **Credential handling** | Tokens and API keys never logged, redacted from errors, stored with `0600` permissions |
| **OAuth flow** | PKCE (Proof Key for Code Exchange), no client secret |
| **Network scope** | Binds to `127.0.0.1` by default. `--host` allows LAN/mesh with `DARIO_API_KEY` gating. Upstream traffic goes only to the configured backend target URLs over HTTPS |
| **SSRF protection** | `/v1/messages` hits `api.anthropic.com` only; `/v1/chat/completions` hits the configured backend `baseUrl` only — hardcoded allowlist |
| **Telemetry** | None. Zero analytics, tracking, or data collection |
| **Audit trail** | [CHANGELOG.md](CHANGELOG.md) documents every release |

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
Recommended for the Claude backend, not strictly required. With CC installed, `dario login` picks up your credentials automatically. Without CC, dario runs its own OAuth flow against Anthropic's authorize endpoint.

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
Dario auto-detects OAuth config from the installed Claude Code binary. When CC ships a new version with rotated values, dario picks them up on the next run. Cache at `~/.dario/cc-oauth-cache-v3.json`, keyed by the CC binary fingerprint. Falls back to hardcoded CC 2.1.104 prod values if CC isn't installed.

**I'm hitting rate limits on the Claude backend. What do I do?**
Claude subscriptions have rolling 5-hour and 7-day usage windows. Check utilization with Claude Code's `/usage` command or the [statusline](https://code.claude.com/docs/en/statusline). For multi-agent workloads, add more accounts and let pool mode distribute the load: `dario accounts add <alias>`.

**I'm seeing `representative-claim: seven_day` in my rate-limit headers instead of `five_hour`. Am I being downgraded to API billing?**

**No.** You're still on subscription billing. Both `five_hour` and `seven_day` are the same subscription billing mode — they're just two different accounting buckets inside it.

Here's the full picture. Every Claude Max and Pro subscription has **two rolling usage windows**:

- **5-hour window** — your short-term usage bucket. Refreshes on a rolling 5-hour schedule. It's the one you'll see most of the time if you use Claude casually.
- **7-day window** — your longer-term usage bucket. Refreshes on a rolling 7-day schedule. It's intentionally larger than the 5-hour one so you can keep working past brief bursts of heavy usage.

When Anthropic bills a request, it decides which bucket to charge it against based on your current utilization. That decision comes back to you in the `anthropic-ratelimit-unified-representative-claim` response header:

| Claim | What it means |
|---|---|
| `five_hour` | You're well inside your 5-hour window; billing against the short-term bucket. |
| `seven_day` | You've exhausted (or come close to exhausting) the 5-hour window for this rolling cycle, so Anthropic is now charging this request against the 7-day bucket. **Still subscription billing. Still your plan.** Not API pricing, not overage. |
| `overage` | Both subscription windows are effectively exhausted. *This* is where per-token Extra Usage charges kick in — if you've enabled Extra Usage on the account. If you haven't, you get 429'd instead. |

**Seeing `seven_day` is a healthy state.** It means your Max/Pro plan is doing exactly what it's supposed to do: letting you keep working past short bursts of heavy use by absorbing them into the larger 7-day bucket. Your subscription is not being "downgraded." You're not being charged API rates. Nothing has reclassified you to a worse billing tier. When your 5-hour window rolls forward enough, the claim on new requests will go back to `five_hour` on its own.

**What about `overage`?** That's the state to watch. It means both windows are saturated and Anthropic is either billing you per-token under Extra Usage (if enabled) or refusing the request (if disabled). If you see this on a Claude Max account under normal use, it usually means (a) you're running a multi-agent workload that's genuinely outgrowing one subscription, or (b) Anthropic's session-level classifier has reclassified your long-running OAuth session as agentic load — see the next FAQ entry for the mechanism.

**Checking where you stand.** You can inspect your current utilization three ways:
1. **Claude Code's built-in command** — run `/usage` inside a `claude` session. Shows both windows as percentages with reset times.
2. **The statusline** — see [Claude Code's statusline docs](https://code.claude.com/docs/en/statusline) for a per-prompt readout.
3. **Dario's pool endpoint** — `curl http://localhost:3456/accounts` when running pool mode. The returned snapshot includes `util5h`, `util7d`, and `claim` per account.

**Practical answer if `seven_day` is painful for your workload.** Add more Claude subscriptions to the pool. Each account has its own independent 5-hour and 7-day windows, and dario pool mode will route each request to the account with the most headroom (`1 - max(util5h, util7d)`). With 2-3 accounts, you almost never see the `seven_day` bucket get touched because the router steers traffic to whichever account still has `five_hour` headroom. `dario accounts add <alias>`.

**Dario's test suite asserts `five_hour` — what if I see failures saying `got: seven_day`?** Some of dario's stealth-test assertions use `representative-claim == "five_hour"` as a shorthand for "is subscription billing classification working?" That assertion is correct for a fresh account but noisy for an account that's been developed against heavily — exactly the situation our own CI hits after an afternoon of test runs. If you're running the stealth suite against an account that's been busy recently and you see failures of the form `Billing claim is five_hour` / `got: seven_day`, that's a test infrastructure limitation, not a dario bug. The request was still billed against your subscription, which is what matters. These assertions will be tightened in a follow-up so they accept both buckets.

Standalone writeup with more detail: [Discussion #32 — why you see `representative-claim: seven_day` and why it's not a downgrade](https://github.com/askalf/dario/discussions/32).

**My multi-agent workload is getting reclassified to overage even though dario template-replays per request. Why?**
Reclassification at high agent volume is not a per-request problem. Anthropic's classifier operates on cumulative per-OAuth-session aggregates — token throughput, conversation depth, streaming duration, inter-arrival timing, thinking-block volume. Dario's Claude backend can make each individual request indistinguishable from Claude Code and still hit this wall on a long-running agent session, because the wall isn't at the request level. Thorough diagnostic work on this was contributed by [@belangertrading](https://github.com/belangertrading) in [#23](https://github.com/askalf/dario/issues/23), including the v3.4.3/v3.4.5 hardening that landed as a result. The practical answer at the dario layer is **pool mode** — distribute load across multiple subscriptions so no single account accumulates enough signal to trip anything. See [Multi-Account Pool Mode](#multi-account-pool-mode).

**Can I route non-OpenAI providers through dario?**
Yes — anything that speaks the OpenAI Chat Completions API. `dario backend add groq --key=... --base-url=https://api.groq.com/openai/v1`, `dario backend add openrouter --key=... --base-url=https://openrouter.ai/api/v1`, or point at a local LiteLLM / vLLM / Ollama-openai-compat server with `--base-url=http://localhost:4000/v1`. v3.6.0 supports one active OpenAI-compat backend at a time; per-model routing to multiple OpenAI-compat backends ships in a follow-up.

**Does dario work with only the OpenAI backend, no Claude subscription?**
Yes. Don't run `dario login`, just run `dario backend add openai --key=...` and `dario proxy`. Claude-backend requests will return an authentication error; OpenAI-compat requests will work normally. Dario becomes a local OpenAI-compat shim with no Claude involvement.

**Why "dario"?**
It's a name, not an acronym. Don't overthink it.

---

## Technical Deep Dives

Longer-form writing on how dario works and why it works that way:

- [v3.0 Template Replay — why we stopped matching signals](https://github.com/askalf/dario/discussions/14)
- [Claude Code defaults are detection signals, not optimizations](https://github.com/askalf/dario/discussions/13)
- [Why Opus feels worse through other proxies and how to fix it](https://github.com/askalf/dario/discussions/9)
- [Billing tag algorithm and fingerprint analysis](https://github.com/askalf/dario/discussions/8)
- [Rate limit header analysis](https://github.com/askalf/dario/discussions/1)

---

## Contributing

PRs welcome. The codebase is ~2,500 lines of TypeScript across 10 files:

| File | Purpose |
|---|---|
| `src/proxy.ts` | HTTP proxy server, request handler, rate governor, Claude backend dispatch |
| `src/cc-template.ts` | CC request template engine, tool mapping, orchestration & framework scrubbing |
| `src/cc-template-data.json` | CC request template data (25 tools, 25KB system prompt) |
| `src/cc-oauth-detect.ts` | OAuth config auto-detection from the installed CC binary |
| `src/oauth.ts` | Single-account token storage, PKCE flow, auto-refresh |
| `src/accounts.ts` | Multi-account credential storage and independent OAuth lifecycle |
| `src/pool.ts` | Account pool, headroom-aware routing, failover target selection |
| `src/analytics.ts` | Rolling request history, per-account / per-model stats, burn-rate |
| `src/openai-backend.ts` | OpenAI-compat backend credential storage and request forwarder |
| `src/cli.ts` | CLI entry point, command routing, Bun auto-relaunch |
| `src/index.ts` | Library exports |

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx, no build step
```

---

## Contributors

| Who | Contributions |
|---|---|
| [@GodsBoy](https://github.com/GodsBoy) | Proxy authentication, token redaction, error sanitization ([#2](https://github.com/askalf/dario/pull/2)) |
| [@belangertrading](https://github.com/belangertrading) | Billing classification investigation ([#4](https://github.com/askalf/dario/issues/4)), cache_control fingerprinting ([#6](https://github.com/askalf/dario/issues/6)), billing reclassification root cause ([#7](https://github.com/askalf/dario/issues/7)), OAuth client_id discovery ([#12](https://github.com/askalf/dario/issues/12)), multi-agent session-level billing analysis ([#23](https://github.com/askalf/dario/issues/23)) |
| [@nathan-widjaja](https://github.com/nathan-widjaja) | README positioning rewrite structure ([#21](https://github.com/askalf/dario/issues/21)) |

---

## License

MIT
