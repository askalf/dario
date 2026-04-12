<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>Use your Claude subscription as an API. The only proxy that bills correctly.</strong></p>
  <p align="center">
    No API key needed. Your Claude Max/Pro subscription becomes a local API endpoint<br/>that any tool, SDK, or framework can use. Template replay makes every request<br/>indistinguishable from real Claude Code — so your Max plan limits actually work.
  </p>
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
  <a href="#openai-compatibility">OpenAI Compat</a> &bull;
  <a href="#cli-backend">CLI Backend</a> &bull;
  <a href="#usage-examples">Examples</a> &bull;
  <a href="#trust--transparency">Trust</a> &bull;
  <a href="#faq">FAQ</a>
</p>

---

```bash
npx @askalf/dario login   # detects Claude Code credentials, starts proxy

# now use it from anywhere — Anthropic or OpenAI SDK
export ANTHROPIC_BASE_URL=http://localhost:3456   # or OPENAI_BASE_URL=http://localhost:3456/v1
export ANTHROPIC_API_KEY=dario                    # or OPENAI_API_KEY=dario
```

Opus, Sonnet, Haiku — all models, streaming, tool use. **Zero dependencies.** ~2,100 lines of TypeScript. Works with Cursor, Continue, Aider, LiteLLM, Hermes, OpenClaw, or any tool that speaks the Anthropic or OpenAI API. When rate limited, `--cli` routes through Claude Code for uninterrupted Opus access. Auto-launches under [Bun](https://bun.sh) when available for TLS fingerprint fidelity.

<table>
<tr>
<td colspan="3" align="center"><br/><strong>Independently reviewed by 3 competing AI companies</strong><br/><br/></td>
</tr>
<tr>
<td width="33%" valign="top">

**Grok** (xAI)

*"Dario works great and is safe. Fully functional with OpenClaw / Hermes. Gives you Opus 4.6, Sonnet & Haiku using your existing Claude Max/Pro sub. No extra API key or billing needed. Streaming + tools work perfectly. 100% open-source, runs locally only, proper OAuth (PKCE), no telemetry. Highly recommended if you want a clean local proxy."*

</td>
<td width="33%" valign="top">

**Copilot** (Microsoft)

*"Verdict: Safe for local use — well-implemented with strong security practices. Minimal attack surface: zero runtime dependencies, PKCE OAuth, localhost-only binding, timing-safe auth, zero telemetry. The main risk vector is operator error rather than code defects."*

</td>
<td width="33%" valign="top">

**Gemini** (Google)

*"Highly recommended for personal, local development. Solves a massive pain point for developers by bridging Claude Max/Pro subscriptions with developer IDEs, saving substantial API costs. Modular & lean, modern PKCE auth, SSRF protection, mature CI/CD pipeline with CodeQL and npm provenance attestations."*

</td>
</tr>
<tr>
<td colspan="3" align="center"><br/><strong>In production</strong><br/><br/></td>
</tr>
<tr>
<td colspan="3" valign="top">

*"The 429s were driving us crazy running a multi-agent stack on Claude Max. You found the billing tag, fixed the checksum, reverse-engineered the per-request hash from the binary — running clean, zero reclassification."* — [@belangertrading](https://github.com/belangertrading), multi-agent stack on Claude Max

</td>
</tr>
</table>

---

## Why dario

Most Claude subscription proxies have a critical billing problem: **Anthropic classifies their requests as third-party and routes all usage to Extra Usage billing** — even when you have Max plan limits available. You're paying for your subscription twice.

dario is the only proxy that solves this. Instead of transforming your requests signal by signal, dario uses **template replay** — it replaces the entire request with Claude Code's exact template, extracted via MITM capture from CC v2.1.104. 25 tool definitions, 25KB system prompt, exact field order, exact beta headers, exact metadata structure. Only your conversation content is preserved. When Bun is installed, dario auto-relaunches under Bun for TLS fingerprint fidelity matching CC's runtime. Anthropic's classifier sees a genuine Claude Code request because it IS one.

| | dario | Other proxies |
|---|---|---|
| **Approach** | Template replay — sends CC's actual request | Signal matching or none |
| **Tools** | CC's exact tool definitions sent upstream | Client tools (detected) |
| **Max plan limits** | Used correctly | Bypassed — billed separately |
| **Detection resistance** | Undetectable without flagging CC itself | Detected by tool names, field order, effort level, etc. |
| **Dependencies** | 0 | Many |

<details>
<summary><strong>vs competitors</strong></summary>

| Feature | dario | Meridian (710 stars) | CLIProxyAPI (24K stars) |
|---------|-------|---------|------------|
| Template replay (undetectable) | **Yes** | No | Inherited (CLI-only) |
| Direct OAuth (streaming, tools) | **Yes** | Yes (SDK-based) | No |
| CLI fallback (rate limit bypass) | **Yes** | No | Yes (only mode) |
| OpenAI API compat | **Yes** | Yes | Yes |
| Orchestration sanitization | **Yes** | Yes | No |
| Token anomaly detection | **Yes** | Yes | No |
| Codebase size | ~2,100 lines | ~9,000 lines | Platform |
| Dependencies | 0 | Many | Many |
| Setup | 2 commands | Config + build | Config + dashboard |

</details>

## The Problem

You pay $100-200/mo for Claude Max or Pro. But that subscription only works on claude.ai and Claude Code. If you want to use Claude with **any other tool** — Cursor, Continue, Aider, your own scripts — you need a separate API key with separate billing.

**Note:** Claude subscriptions have [usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work) that reset on rolling 5-hour and 7-day windows. When exceeded, Opus and Sonnet may return 429 errors while Haiku continues working. You can check your utilization via Claude Code's `/usage` command or [statusline](https://code.claude.com/docs/en/statusline). Use `--cli` mode to route through Claude Code's binary, which is not affected by these limits.

**dario fixes this.** It creates a local proxy that translates API key auth into your subscription's OAuth tokens — and with `--cli` mode, routes through the Claude Code binary for uninterrupted access.

## Quick Start

### Prerequisites

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) installed and logged in (recommended). Dario detects your existing Claude Code credentials automatically.

If Claude Code isn't installed, dario runs its own OAuth flow — opens your browser, you authorize, done.

### Install

```bash
npm install -g @askalf/dario
```

Or use npx (no install needed):

```bash
npx @askalf/dario login
```

### Login

```bash
dario login
```

- **With Claude Code installed:** Detects your credentials automatically and starts the proxy. No browser needed.
- **Without Claude Code:** Opens your browser to Claude's OAuth page. Authorize, and dario captures the token automatically via a local callback server. Then run `dario proxy` to start the server.

### Start the proxy

```bash
dario proxy
```

```
dario — http://localhost:3456

Your Claude subscription is now an API.

Usage:
  ANTHROPIC_BASE_URL=http://localhost:3456
  ANTHROPIC_API_KEY=dario

Auth: open (no DARIO_API_KEY set)
OAuth: healthy (expires in 11h 42m)
Model: passthrough (client decides)
```

### Use it

```bash
# Set these two env vars — every Anthropic SDK respects them
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario

# Now any tool just works
openclaw start
aider --model claude-opus-4-6
continue  # in VS Code, set base URL in config
python my_script.py
```

## CLI Backend

If you're getting rate limited on Opus or Sonnet, use `--cli` mode. This routes requests through the Claude Code binary instead of hitting the API directly. Claude Code has priority routing that continues working even when direct API calls return 429.

```bash
dario proxy --cli                    # Opus works even when rate limited
dario proxy --cli --model=opus       # Force Opus + CLI backend
```

```
dario — http://localhost:3456

Your Claude subscription is now an API.

Usage:
  ANTHROPIC_BASE_URL=http://localhost:3456
  ANTHROPIC_API_KEY=dario

Backend: Claude CLI (bypasses rate limits)
Model: claude-opus-4-6 (all requests)
```

**Trade-offs vs direct API mode:**

| | Direct API (default) | CLI Backend (`--cli`) | Passthrough (`--passthrough`) |
|---|---|---|---|
| Streaming | Native SSE | SSE (converted from JSON) | Native SSE |
| Tool use | Yes | No | Yes |
| Thinking/billing injection | Yes (Claude-optimized) | N/A | No (OAuth swap only) |
| Latency | Low | Higher (process spawn) | Low |
| Rate limits | Priority routing | Not affected | Standard (no priority) |
| Opus when throttled | Auto CLI fallback | **Always works** | May return 429 |

## Passthrough Mode

For tools that need exact Anthropic protocol fidelity with zero modification, use `--passthrough`. This does OAuth swap only — no billing tag, no thinking injection, no device identity, no extra beta flags. Note: most tools (including Hermes and OpenClaw) work better through default mode, which handles billing classification and token optimization automatically.

```bash
dario proxy --passthrough               # Thin proxy, zero injection
dario proxy --passthrough --model=opus   # Thin proxy + model override
```

## Model Selection

Force a specific model for all requests — useful when your tool doesn't let you configure the model:

```bash
dario proxy --model=opus      # Force Opus 4.6
dario proxy --model=sonnet    # Force Sonnet 4.6
dario proxy --model=haiku     # Force Haiku 4.5
dario proxy                   # Passthrough (client decides)
```

Full model IDs also work: `--model=claude-opus-4-6`

Combine with `--cli` for rate-limit-proof Opus:

```bash
dario proxy --cli --model=opus
```

## OpenAI Compatibility

Dario implements `/v1/chat/completions` — any tool built for the OpenAI API works with your Claude subscription. No code changes needed.

```bash
dario proxy --model=opus

export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario

# Cursor, Continue, LiteLLM, any OpenAI SDK — all work
```

Use `--model=opus` to force the model regardless of what the client sends. Or pass `claude-opus-4-6` as the model name directly — Claude model names work as-is.

## Usage Examples

### curl

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Python

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3456",
    api_key="dario"
)

message = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)
```

### TypeScript / Node.js

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:3456",
  apiKey: "dario",
});

const message = await client.messages.create({
  model: "claude-opus-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Streaming

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Write a haiku about APIs"}]
  }'
```

### With Other Tools

```bash
# Cursor / Continue / any OpenAI-compatible tool
OPENAI_BASE_URL=http://localhost:3456/v1 OPENAI_API_KEY=dario cursor

# Aider
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario aider --model claude-opus-4-6

# Any tool that uses ANTHROPIC_BASE_URL
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario your-tool-here
```

### Hermes

Add to `~/.hermes/config.yaml`:

```yaml
model:
  base_url: "http://localhost:3456/v1"
  api_key: "dario"
  default: claude-opus-4-6
```

Then run `hermes` normally — it routes through dario using your Claude subscription.

### OpenClaw

Add to your `openclaw.json` models config:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "http://127.0.0.1:3456",
        "apiKey": "dario",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "claude-sonnet-4-6",
            "name": "claude-sonnet-4-6",
            "contextWindow": 1000000,
            "maxTokens": 64000,
            "input": ["text"],
            "reasoning": true
          },
          {
            "id": "claude-opus-4-6",
            "name": "claude-opus-4-6",
            "contextWindow": 1000000,
            "maxTokens": 64000,
            "input": ["text"],
            "reasoning": true
          }
        ]
      }
    }
  }
}
```

**Note:** Use `http://127.0.0.1:3456` without `/v1` — OpenClaw adds the path itself.

## How It Works

### Direct API Mode (default) — Template Replay

```
┌──────────┐     ┌─────────────────────┐     ┌──────────────────┐
│ Your App │ ──> │   dario (proxy)     │ ──> │ api.anthropic.com│
│          │     │   localhost:3456    │     │                  │
│ sends    │     │                     │     │  sees a genuine  │
│ its own  │     │  replaces request   │     │  Claude Code     │
│ tools &  │     │  with CC template   │     │  request         │
│ params   │     │  keeps only content │     │                  │
└──────────┘     └─────────────────────┘     └──────────────────┘
```

Your app sends whatever it wants — any tools, any parameters. dario replaces the entire request with Claude Code's template and injects only your conversation content. The upstream sees CC's exact tool definitions, field structure, and parameters.

### CLI Backend Mode (`--cli`)

```
┌──────────┐     ┌─────────────────┐     ┌──────────────────┐
│ Your App │ ──> │  dario (proxy)  │ ──> │  claude --print  │
│          │     │  localhost:3456  │     │  (Claude Code)   │
│ sends    │     │  extracts prompt│     │                  │
│ API      │     │  spawns CLI     │     │  has priority    │
│ request  │     │  wraps response │     │  routing         │
└──────────┘     └─────────────────┘     └──────────────────┘
```

### Passthrough Mode (`--passthrough`)

```
┌──────────┐     ┌─────────────────┐     ┌──────────────────┐
│ Your App │ ──> │  dario (proxy)  │ ──> │ api.anthropic.com│
│          │     │  localhost:3456  │     │                  │
│ sends    │     │  swaps API key  │     │  sees valid      │
│ API      │     │  for OAuth      │     │  OAuth bearer    │
│ request  │     │  nothing else   │     │  token           │
└──────────┘     └─────────────────┘     └──────────────────┘
```

1. **`dario login`** — Detects your existing Claude Code credentials (`~/.claude/.credentials.json`) and starts the proxy automatically. If Claude Code isn't installed, runs a PKCE OAuth flow with a local callback server to capture the token automatically.

2. **`dario proxy`** — Starts an HTTP server on localhost that implements the Anthropic Messages API. In direct mode, it swaps your API key for an OAuth bearer token. In CLI mode, it routes through the Claude Code binary.

3. **Auto-refresh** — OAuth tokens expire. Dario refreshes them automatically in the background every 15 minutes. Refresh tokens rotate on each use.

## Commands

| Command | Description |
|---------|-------------|
| `dario login` | Detect credentials and start proxy |
| `dario proxy` | Start the local API proxy |
| `dario status` | Check if your token is healthy |
| `dario refresh` | Force an immediate token refresh |
| `dario logout` | Delete stored credentials |
| `dario help` | Show usage information |

### Proxy Options

| Flag/Env | Description | Default |
|----------|-------------|---------|
| `--cli` | Use Claude CLI as backend (bypasses rate limits) | off |
| `--passthrough` | Thin proxy — OAuth swap only, no injection | off |
| `--model=MODEL` | Force a model (`opus`, `sonnet`, `haiku`, or full ID) | passthrough |
| `--port=PORT` | Port to listen on | `3456` |
| `--verbose` / `-v` | Log every request | off |
| `DARIO_API_KEY` | If set, all endpoints (except `/health`) require matching `x-api-key` header or `Authorization: Bearer` header | unset (open) |
| `DARIO_NO_BUN` | Disable automatic Bun relaunch (stay on Node.js) | unset |
| `DARIO_MIN_INTERVAL_MS` | Minimum ms between requests (rate governor) | `500` |

## Supported Features

### Direct API Mode
- All Claude models (Opus 4.6, Sonnet 4.6, Haiku 4.5) + 1M extended context aliases (`opus1m`, `sonnet1m`)
- **Template replay** (v3.0+) — replaces the entire request with Claude Code's exact template, extracted via MITM capture from CC v2.1.104. 25 tool definitions, 25KB system prompt, exact body key order, exact beta headers (model-conditional), exact metadata structure. Client tools are mapped to CC equivalents and reverse-mapped in responses. Template data stored as JSON for easy updates. See [Discussion 13](https://github.com/askalf/dario/discussions/13) and [Discussion 14](https://github.com/askalf/dario/discussions/14).
- **Bun auto-relaunch** (v3.2) — auto-detects Bun and relaunches under it for TLS fingerprint fidelity. CC runs on Bun; Node.js has a different TLS fingerprint visible at the network level.
- **Session ID rotation** (v3.2) — each request gets a fresh session ID, matching CC `--print` behavior.
- **Rate governor** (v3.2) — 500ms minimum interval between requests prevents inhuman cadence. Configurable via `DARIO_MIN_INTERVAL_MS`.
- **Enriched 429 errors** — rate limit errors include utilization %, limiting window, and reset time instead of Anthropic's default `"Error"` message
- **Auto CLI fallback** — if the API returns 429 and Claude Code is installed, transparently retries through `claude --print` with SSE conversion
- **OpenAI-compatible** (`/v1/chat/completions`) — works with any OpenAI SDK or tool
- Streaming and non-streaming (both Anthropic and OpenAI SSE formats, including tool_use streaming)
- Tool use / function calling
- System prompts and multi-turn conversations
- Prompt caching and extended thinking
- **Billable beta filtering** — strips `extended-cache-ttl` from client betas (the only prefix requiring Extra Usage)
- **Beta deduplication** — client-provided betas are deduplicated against the base set before appending
- **Orchestration tag sanitization** — strips agent-injected XML (`<system-reminder>`, `<env>`, `<task_metadata>`, etc.) before forwarding
- **Token anomaly detection** — warns on context spike (>60% input growth) or output explosion (>2x previous)
- Concurrency control (max 10 concurrent upstream requests)
- CORS enabled (works from browser apps on localhost)

### CLI Backend Mode
- All Claude models — including Opus when rate limited
- Streaming via SSE conversion (client sends `stream: true`, CLI JSON response is converted to Anthropic or OpenAI SSE events)
- OpenAI compatibility (translates OpenAI → Anthropic before CLI, Anthropic → OpenAI after)
- System prompts and multi-turn conversations (via context injection)
- Not affected by API rate limits

### Passthrough Mode
- All Claude models with native streaming and tool use
- OAuth token swap only — no billing tag, thinking, effort, or device identity injection
- Minimal beta flags (`oauth-2025-04-20` + client betas only)
- For tools that need exact Anthropic protocol fidelity with zero modification

## Endpoints

| Path | Description |
|------|-------------|
| `POST /v1/messages` | Anthropic Messages API |
| `POST /v1/chat/completions` | OpenAI-compatible Chat API |
| `GET /v1/models` | Model list (works with both SDKs) |
| `GET /health` | Proxy health + OAuth status + request count |
| `GET /status` | Detailed OAuth token status |

## Health Check

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

## Security

| Concern | How dario handles it |
|---------|---------------------|
| Credential storage | Reads from Claude Code (`~/.claude/.credentials.json`) or its own store (`~/.dario/credentials.json`) with `0600` permissions |
| OAuth flow | PKCE (Proof Key for Code Exchange) — no client secret needed |
| Token transmission | OAuth tokens never leave localhost. Only forwarded to `api.anthropic.com` over HTTPS |
| Network exposure | Proxy binds to `127.0.0.1` only — not accessible from other machines |
| SSRF protection | Hardcoded allowlist of API paths — only `/v1/messages`, `/v1/models`, `/v1/complete` are proxied |
| Token rotation | Refresh tokens rotate on every use (single-use) |
| Error sanitization | Token patterns redacted from all error messages |
| Data collection | Zero. No telemetry, no analytics, no phoning home |

## FAQ

**Does this violate Anthropic's terms of service?**
Dario uses your existing Claude Code credentials with the same OAuth tokens. It authenticates you as you, with your subscription, through Anthropic's official API. The `--cli` mode literally uses Claude Code itself as the backend.

**What subscription plans work?**
Claude Max and Claude Pro. Any plan that lets you use Claude Code.

**Does it work with Claude Team / Enterprise?**
Should work if your plan includes Claude Code access. Not tested yet — please open an issue with results.

**Do I need Claude Code installed?**
Recommended but not required. If Claude Code is installed and logged in, `dario login` picks up your credentials automatically. Without Claude Code, dario runs its own OAuth flow to authenticate directly. Note: `--cli` mode requires Claude Code (`npm install -g @anthropic-ai/claude-code`).

**First time setup — account priming**
If dario is the first thing you use with a new Claude account, run a few real Claude Code commands first to establish a session baseline:
```bash
claude --print "hello"
claude --print "hello"
claude --print "hello"
```
This primes the account with legitimate Claude Code sessions. Then start dario normally. Without priming, new accounts may see billing classification issues on first use.

**Do I need Bun installed?**
Optional but recommended. If [Bun](https://bun.sh) is installed, dario auto-relaunches under it for TLS fingerprint fidelity with Claude Code's runtime. Without Bun, dario runs on Node.js and works fine — the TLS fingerprint is the only difference. Install Bun: `curl -fsSL https://bun.sh/install | bash`

**What happens when my token expires?**
Dario auto-refreshes tokens 30 minutes before expiry. You should never see an auth error in normal use. If something goes wrong, `dario refresh` forces an immediate refresh.

**I'm getting rate limited on Opus. What do I do?**
Use `--cli` mode: `dario proxy --cli`. This routes through the Claude Code binary, which continues working when direct API calls are rate limited. In default mode, dario automatically falls back to CLI when it detects a 429 (if Claude Code is installed). Rate limit errors include utilization percentages and reset times so you can see exactly when capacity returns. You can also enable [extra usage](https://support.claude.com/en/articles/12429409-manage-extra-usage-for-paid-claude-plans) in your Anthropic account settings to extend your limits at API rates.

**What are the usage limits?**
Claude subscriptions have rolling 5-hour and 7-day usage windows shared across claude.ai and Claude Code. See [Anthropic's docs](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work) for details. In Claude Code, use `/usage` to check your current limits, or configure the [statusline](https://code.claude.com/docs/en/statusline) to show real-time 5h and 7d utilization percentages.

**Can I run this on a server?**
Dario binds to localhost by default. For server use, you'd need to handle the initial login on a machine with a browser, then copy `~/.claude/.credentials.json` (or `~/.dario/credentials.json`) to your server. Auto-refresh will keep it alive from there.

**Why "dario"?**
Named after [Dario Amodei](https://en.wikipedia.org/wiki/Dario_Amodei), CEO of Anthropic.

## Programmatic API

Use dario as a library in your own Node.js app:

```typescript
import { startProxy, getAccessToken, getStatus } from "@askalf/dario";

// Start the proxy programmatically
await startProxy({ port: 3456, verbose: true });

// CLI backend mode
await startProxy({ port: 3456, cliBackend: true, model: "opus" });

// Passthrough mode (OAuth swap only, no injection)
await startProxy({ port: 3456, passthrough: true });

// Or just get a raw access token
const token = await getAccessToken();

// Check token health
const status = await getStatus();
console.log(status.expiresIn); // "11h 42m"
```

## Trust & Transparency

Dario handles your OAuth tokens. Here's why you can trust it:

| Signal | Status |
|--------|--------|
| **Source code** | ~2,100 lines of TypeScript — small enough to audit in one sitting |
| **Dependencies** | 0 runtime dependencies. Verify: `npm ls --production` |
| **npm provenance** | Every release is [SLSA attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions |
| **Security scanning** | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) runs on every push and weekly |
| **Credential handling** | Tokens never logged, redacted from errors, stored with 0600 permissions |
| **Network scope** | Binds to 127.0.0.1 only. Upstream traffic goes exclusively to `api.anthropic.com` over HTTPS |
| **No telemetry** | Zero analytics, tracking, or data collection of any kind |
| **Audit trail** | [CHANGELOG.md](CHANGELOG.md) documents every release |
| **Branch protection** | CI must pass before merge. CODEOWNERS enforces review |

Verify the npm package matches this repo:

```bash
# Check provenance attestation
npm audit signatures 2>/dev/null; npm view @askalf/dario dist.integrity

# Check dependency tree (should be minimal)
cd $(npm root -g)/@askalf/dario && npm ls --production
```

## Technical Deep Dives

| Topic | Link |
|-------|------|
| v3.0 Template Replay — why we stopped matching signals | [Discussion 14](https://github.com/askalf/dario/discussions/14) |
| Claude Code defaults are detection signals, not optimizations | [Discussion 13](https://github.com/askalf/dario/discussions/13) |
| Why Opus 4.6 feels worse and how to fix it | [Discussion 9](https://github.com/askalf/dario/discussions/9) |
| Billing tag algorithm and fingerprint analysis | [Discussion 8](https://github.com/askalf/dario/discussions/8) |
| Rate limit header analysis | [Discussion 1](https://github.com/askalf/dario/discussions/1) |

## Contributing

PRs welcome. The codebase is ~2,100 lines of TypeScript across 5 files:

| File | Purpose |
|------|---------|
| `src/proxy.ts` | HTTP proxy server, CLI backend, rate governor |
| `src/cc-template.ts` | CC template engine + tool mapping |
| `src/cc-template-data.json` | MITM-extracted CC data (25 tools, 25KB system prompt) |
| `src/oauth.ts` | Token storage, refresh, credential detection |
| `src/cli.ts` | CLI entry point + Bun auto-relaunch |
| `src/index.ts` | Library exports |

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx (no build needed)
```

## Contributors

| Who | Contributions |
|-----|---------------|
| [@GodsBoy](https://github.com/GodsBoy) | Proxy authentication, token redaction, error sanitization ([#2](https://github.com/askalf/dario/pull/2)) |
| [@belangertrading](https://github.com/belangertrading) | Billing classification investigation ([#4](https://github.com/askalf/dario/issues/4)), Opus/Sonnet 429 diagnosis + CLI fallback workaround ([#6](https://github.com/askalf/dario/issues/6)), billing reclassification root cause ([#7](https://github.com/askalf/dario/issues/7)) |

## License

MIT
