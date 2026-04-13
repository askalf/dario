<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>Use your Claude subscription inside your local tools and scripts — without moving to API billing or rebuilding your workflow around a separate stack.</strong></p>
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
  <a href="#why-switch">Why switch</a> &bull;
  <a href="#how-it-works">How it works</a> &bull;
  <a href="#from-standalone-to-askalf">Standalone → askalf</a> &bull;
  <a href="#trust--transparency">Trust</a> &bull;
  <a href="#faq">FAQ</a>
</p>

---

## What it is

dario is a local process that turns your Claude Max or Pro subscription into an API endpoint that any tool on your machine can use. It talks to Anthropic the same way Claude Code does, so your subscription's rate limits are what you spend against — not a separate API billing tier.

Install it once, log in once (using your existing Claude Code credentials if you have them), and from that point on every tool that speaks the Anthropic API or the OpenAI chat completions API — Cursor, Continue, Aider, LiteLLM, your own scripts, whatever — can reach Claude through `http://localhost:3456`.

**Standalone is the default.** You don't need an account anywhere, you don't need to wait for anything, and nothing phones home. Install and run.

**Dario is also the local bridge for [askalf](https://askalf.org).** When your workload outgrows a single subscription — multi-account pooling, session shaping to stay under Anthropic's behavioral classifiers, 24/7 fleets, scheduled workflows — dario is the component that keeps running on your machine and connects to the askalf platform. Same install, same commands, extra capabilities unlocked when you link it. You don't have to use askalf to use dario today, and you won't have to change how you use dario when you join askalf later.

---

## Who this is for

**Best fit:**
- Power users already paying for Claude Max or Pro who want Claude available inside their local stack — editors, terminals, scripts, internal tools — without moving to API billing.
- Small teams that work in terminals and IDEs, not in hosted agent stacks, and want Claude as a drop-in provider for whatever tools they already use.
- Anyone who wants Claude Code's billing behavior on their own requests, from their own code.

**Not a fit:**
- You need vendor-managed production SLAs on every request. Use the Anthropic API directly.
- You need high-scale agent orchestration, multi-account pooling, or session-level classifier shaping. That's [askalf](https://askalf.org), which dario bridges into.
- You want a hosted chat UI. Use claude.ai.

---

## First use case

> Use Claude in your local automation and developer workflows the way you'd normally reach for an API — but backed by the subscription you already pay for.

You install dario, point your existing tool at `http://localhost:3456`, and that tool now sees Claude. The tool doesn't know it's going through a proxy; from its perspective dario *is* the Anthropic API. Your subscription handles the billing. Your Max plan limits are what count against usage.

Flow on a fresh machine:

1. `npm install -g @askalf/dario`
2. `dario login` — detects your installed Claude Code credentials, or runs its own OAuth flow if you don't have CC installed
3. `dario proxy` — starts the local server on port 3456
4. Set two environment variables in the tool you already use:
   ```bash
   ANTHROPIC_BASE_URL=http://localhost:3456
   ANTHROPIC_API_KEY=dario
   ```
5. That tool now uses your Claude subscription. Streaming works, tool use works, prompt caching works.

No separate API key. No Extra Usage charges. No rebuilding your workflow around a new provider.

---

## Why switch

**Use dario if** you already pay for Claude Max or Pro and you want Claude inside the tools you already use, without paying API rates for every request or routing your work through a second hosted stack.

**Use the Anthropic API directly if** you need platform-native primitives, vendor-managed production usage, high-scale control, or SLAs your subscription tier doesn't cover. Dario isn't trying to replace the API — it's trying to unlock the subscription you already bought.

**Use dario + askalf if** you're running multi-agent workloads, hitting session-level rate limits that a single account can't clear, or need a 24/7 fleet. Dario keeps running on your machine as the local bridge; askalf adds multi-account pooling, session shaping, and the platform pieces a single-subscription proxy can't deliver. See [below](#from-standalone-to-askalf).

**Don't use dario if** you want a subprocess bridge that shells out to `claude --print` under the hood. Those tools (openclaw-claude-bridge and similar) work well for single-team single-machine workloads that can accept a one-subscription rate ceiling and a one-machine deployment. Dario is the API-path alternative, which trades that simplicity for pooling-friendly behavior on the wire. Different tradeoffs, different tool.

---

## Quick Start

```bash
# Install
npm install -g @askalf/dario

# Log in (detects Claude Code credentials if installed)
dario login

# Start the proxy
dario proxy

# Anthropic SDK
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario

# or OpenAI-compatible tools
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Opus, Sonnet, Haiku — all models, streaming, tool use, prompt caching, extended thinking. **Zero runtime dependencies.** ~2,000 lines of TypeScript. Auto-launches under [Bun](https://bun.sh) when available for TLS fingerprint fidelity with Claude Code's runtime. **Auto-detects OAuth config from your installed CC binary** so dario stays in sync forever — Anthropic can rotate client IDs and dario picks them up on the next run.

---

## How It Works

Dario has two modes: **direct API mode** (the default) and **passthrough mode** (`--passthrough`).

### Direct API Mode — Template Replay

This is the mode you want for almost every case. Dario takes each request you send it and replaces it with a Claude Code request: same 25 tool definitions, same 25KB system prompt, same field order, same beta headers, same metadata structure, same device identity. Only your conversation content is preserved. Anthropic's classifier sees what looks like a Claude Code session because, from the wire up, it *is* one — and that's what keeps your usage on subscription billing instead of Extra Usage.

```
┌───────────┐     ┌─────────────────────┐     ┌──────────────────┐
│ Your App  │ ──> │   dario (proxy)     │ ──> │ api.anthropic.com│
│           │     │   localhost:3456    │     │                  │
│ sends     │     │                     │     │  sees a genuine  │
│ its own   │     │  replaces request   │     │  Claude Code     │
│ tools &   │     │  with CC template   │     │  request         │
│ params    │     │  keeps only content │     │                  │
└───────────┘     └─────────────────────┘     └──────────────────┘
```

The details that matter:

- **Billing tag** reconstructed using CC's own algorithm extracted from the binary: `x-anthropic-billing-header: cc_version=<version>.<build_tag>; cc_entrypoint=cli; cch=<5-char-hex>;` where `build_tag = SHA-256(seed + chars[4,7,20] of user message + version).slice(0,3)`.
- **Beta set** — CC's exact beta list in CC's order, minus any beta that would require Extra Usage to be enabled on your account.
- **OAuth config** auto-detected from the installed CC binary at startup. When Anthropic rotates `client_id`, authorize URL, or scopes, dario picks up the new values on the next run without needing a new release. Falls back to hardcoded CC 2.1.104 prod values if CC isn't installed. Cache at `~/.dario/cc-oauth-cache-v3.json`, keyed by binary fingerprint.
- **Session ID** rotates per request via `x-claude-code-session-id`, matching how `claude --print` behaves. A persistent session ID across rapid requests is a behavioral signal.
- **Framework scrub** — framework identifiers and known fingerprint tokens (`OpenClaw`, `sessions_*` tool prefixes, orchestration tags, etc.) are stripped from both the system prompt and message content before the request goes upstream.
- **Bun auto-relaunch** — when Bun is installed, dario relaunches under it so its TLS fingerprint matches CC's runtime. Without Bun, dario runs on Node.js and works fine; the TLS fingerprint is the only difference.

### Passthrough Mode — `--passthrough`

For tools that need exact Anthropic protocol fidelity with nothing injected. This mode does an OAuth token swap and nothing else: no billing tag, no template, no device identity.

```bash
dario proxy --passthrough
```

Use it when the upstream tool already builds a Claude-Code-shaped request on its own and you just need the token auth.

### Detection scope

Dario is a **per-request layer**. Every request it sends upstream is designed to be indistinguishable from a Claude Code request, and the per-request scrubbing hardened in v3.4.5 makes that meaningfully harder to fingerprint than it was when v3.0 first shipped. What dario cannot do at the per-request level is defend against Anthropic's session-level and account-level classifiers — those operate on cumulative per-OAuth behavioral aggregates (token throughput, conversation depth, streaming duration, inter-arrival timing) and no amount of per-request hardening reaches them. That's a different problem at a different layer, and it's [askalf](https://askalf.org)'s job rather than dario's. See the [FAQ entry](#faq) for the full explanation.

---

## From standalone to askalf

Dario is fully useful on its own. You don't need an account, you don't need to wait for anything, and the standalone mode is and will remain the default.

When your workload grows past what a single Claude subscription can hold, dario is also the local-edge component of the [askalf](https://askalf.org) platform. Same binary, same commands, same local proxy — linking to askalf adds what a per-request layer alone can't deliver:

| | dario standalone | dario + askalf |
|---|---|---|
| **Accounts** | 1 (yours) | Pool of 2–20+ |
| **Rate limits** | Your subscription's 5h / 7d windows | Distributed across the pool, near-zero 429s |
| **Session shaping** | Per-request scrub | Per-session cumulative tracking, rotation, classifier avoidance |
| **Browser / desktop control** | No | Yes — full computer use |
| **Scheduling** | No | Cron, webhooks, triggers |
| **Persistent memory** | No | Per-agent context and state |
| **Hosted dashboard** | No | Yes |
| **Local proxy component** | dario | dario |

When the askalf bridge endpoint is live, a single command (`dario link`) will pair this local instance with your askalf account and the extra capabilities unlock in place. Until then, standalone is the only mode that runs — nothing to wait for to use dario as it is today.

**[Join the askalf waitlist →](https://askalf.org)**

Dario will always be open-source and free. askalf is the hosted tier for teams who need the layer above.

---

## Commands

| Command | Description |
|---------|-------------|
| `dario login` | Log in (detects CC credentials or runs its own OAuth flow) |
| `dario proxy` | Start the local API proxy on port 3456 |
| `dario status` | Show OAuth token health and expiry |
| `dario refresh` | Force an immediate token refresh |
| `dario logout` | Delete stored credentials |
| `dario help` | Full command reference |

### Proxy options

| Flag / env | Description | Default |
|---|---|---|
| `--passthrough` / `--thin` | Thin proxy — OAuth swap only, no template injection | off |
| `--preserve-tools` / `--keep-tools` | Keep client tool schemas instead of remapping to CC tools | off |
| `--model=<name>` | Force a model (`opus`, `sonnet`, `haiku`, or full ID) | passthrough |
| `--port=<n>` | Port to listen on | `3456` |
| `--host=<addr>` / `DARIO_HOST` | Bind address. Use `0.0.0.0` for LAN, or a specific IP (e.g. a Tailscale interface). When non-loopback, also set `DARIO_API_KEY`. | `127.0.0.1` |
| `--verbose` / `-v` | Log every request | off |
| `DARIO_API_KEY` | If set, all endpoints (except `/health`) require a matching `x-api-key` or `Authorization: Bearer` header. Required when `--host` binds non-loopback. | unset (open) |
| `DARIO_CORS_ORIGIN` | Override the browser CORS `Access-Control-Allow-Origin`. Useful for browser clients reaching dario over a mesh network. | `http://localhost:${port}` |
| `DARIO_NO_BUN` | Disable automatic Bun relaunch | unset |
| `DARIO_MIN_INTERVAL_MS` | Minimum ms between requests (rate governor) | `500` |
| `DARIO_CC_PATH` | Override path to the Claude Code binary for OAuth detection | auto-detect |

---

## Usage

### Python

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

### OpenAI-compatible (Cursor, Continue, LiteLLM, Aider, …)

```bash
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Any tool that accepts an OpenAI base URL works as-is. Claude model names pass through directly; GPT-style names (`gpt-4`, `gpt-5.4`, etc.) map to their closest Claude equivalents so tools with hardcoded OpenAI model lists work without code changes.

### curl

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'
```

### Streaming, tool use, prompt caching, extended thinking

All supported in both Anthropic and OpenAI SSE formats. Tool-use streaming emits `input_json_delta` events. Prompt caching works as-is. Extended thinking is routed through `reasoning_effort` in OpenAI format or the native `thinking` field in Anthropic format.

### Library mode

Dario is also importable:

```typescript
import { startProxy, getAccessToken, getStatus } from "@askalf/dario";

await startProxy({ port: 3456, verbose: true });
const token = await getAccessToken();
const status = await getStatus();
```

### Health check

```bash
curl http://localhost:3456/health
```

```json
{
  "status": "ok",
  "oauth": "healthy",
  "expiresIn": "11h 42m",
  "requests": 47
}
```

---

## Endpoints

| Path | Description |
|------|-------------|
| `POST /v1/messages` | Anthropic Messages API |
| `POST /v1/chat/completions` | OpenAI-compatible Chat API |
| `GET /v1/models` | Model list (works with both SDKs) |
| `GET /health` | Proxy health + OAuth status + request count |
| `GET /status` | Detailed OAuth token status |

---

## Trust & Transparency

Dario handles your OAuth tokens. Here's why you can trust it:

| Signal | Status |
|---|---|
| **Source code** | ~2,000 lines of TypeScript across 7 files — small enough to audit in one sitting |
| **Dependencies** | 0 runtime dependencies. Verify: `npm ls --production` |
| **npm provenance** | Every release is [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions |
| **Security scanning** | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) runs on every push and weekly |
| **Credential handling** | Tokens never logged, redacted from errors, stored with `0600` permissions |
| **OAuth flow** | PKCE (Proof Key for Code Exchange) — no client secret |
| **Network scope** | Binds to `127.0.0.1` by default. `--host` allows LAN/mesh with `DARIO_API_KEY` gating. Upstream traffic goes only to `api.anthropic.com` over HTTPS |
| **SSRF protection** | Only `/v1/messages` and `/v1/complete` proxy upstream — hardcoded allowlist |
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
Dario uses your existing Claude Code credentials with the same OAuth tokens CC uses. It authenticates you as you, with your subscription, through Anthropic's official API endpoints.

**What subscription plans work?**
Claude Max and Claude Pro. Any plan that lets you use Claude Code.

**Does it work with Team / Enterprise?**
Should work if your plan includes Claude Code access. Not widely tested yet — open an issue with results.

**Do I need Claude Code installed?**
Recommended, not required. With CC installed, `dario login` picks up your credentials automatically. Without CC, dario runs its own OAuth flow against Anthropic's authorize endpoint.

**Do I need Bun?**
Optional, recommended. Dario auto-relaunches under Bun when it's available so the TLS fingerprint matches CC's runtime. Without Bun, dario runs on Node.js and works fine; the TLS fingerprint is the only difference. Install: `curl -fsSL https://bun.sh/install | bash`.

**First time setup on a fresh account.**
If dario is the first thing you run against a brand-new Claude account, prime the account with a few real Claude Code commands first:
```bash
claude --print "hello"
claude --print "hello"
```
This establishes a session baseline. Without priming, brand-new accounts occasionally see billing classification issues on first use.

**What happens when my token expires?**
Dario auto-refreshes tokens 30 minutes before expiry. `dario refresh` forces an immediate refresh if something goes wrong.

**What happens when Anthropic rotates the OAuth client_id or URL?**
Dario auto-detects OAuth config from your installed Claude Code binary. When CC ships a new version with rotated values, dario picks them up on the next run — no dario release needed. Cache at `~/.dario/cc-oauth-cache-v3.json`, keyed by the CC binary fingerprint. If CC isn't installed, dario falls back to hardcoded CC 2.1.104 prod values.

**I'm hitting rate limits. What do I do?**
Claude subscriptions have rolling 5-hour and 7-day usage windows. Check utilization with Claude Code's `/usage` command or the [statusline](https://code.claude.com/docs/en/statusline). Dario's rate-limit errors include utilization percentages and reset times so you can see exactly when capacity returns.

**My multi-agent workload is getting reclassified to overage even though dario template-replays per request. Why?**
Because reclassification at high agent volume is not a per-request problem. Anthropic's classifier operates on cumulative per-OAuth-session behavioral aggregates — token throughput, conversation depth, streaming duration, inter-arrival timing, thinking-block volume. Dario can make each individual request indistinguishable from Claude Code and still hit this wall on a long-running agent session, because the wall isn't at the request level. Thorough diagnostic work on this was contributed by [@belangertrading](https://github.com/belangertrading) in [#23](https://github.com/askalf/dario/issues/23), including the per-request v3.4.3 and v3.4.5 hardening that landed as a result. For the session-layer shaping itself — multi-account pooling, session rotation, workload distribution that keeps any single account from concentrating the behavioral signal — that's what [askalf](https://askalf.org) is built for. Different layer, different tool.

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

PRs welcome. The codebase is ~2,000 lines of TypeScript across 7 files:

| File | Purpose |
|---|---|
| `src/proxy.ts` | HTTP proxy server, rate governor, billing tag, response forwarding |
| `src/cc-template.ts` | Template engine, tool mapping, orchestration & framework scrubbing |
| `src/cc-template-data.json` | CC request template data (25 tools, 25KB system prompt) |
| `src/cc-oauth-detect.ts` | OAuth config auto-detection from the installed CC binary |
| `src/oauth.ts` | Token storage, PKCE flow, auto-refresh |
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
