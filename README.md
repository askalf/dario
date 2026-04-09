<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>Use your Claude subscription as an API.</strong></p>
  <p align="center">
    No API key needed. Your Claude Max/Pro subscription becomes a local API endpoint<br/>that any tool, SDK, or framework can use.
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
  <a href="#security">Security</a> &bull;
  <a href="#usage-examples">Examples</a> &bull;
  <a href="#faq">FAQ</a>
</p>

---

```bash
npx @askalf/dario login   # detects Claude Code credentials, starts proxy

# now use it from anywhere
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
```

That's it. Any tool that speaks the Anthropic API now uses your subscription.

---

## The Problem

You pay $100-200/mo for Claude Max or Pro. But that subscription only works on claude.ai and Claude Code. If you want to use Claude with **any other tool** — OpenClaw, Cursor, Continue, Aider, your own scripts — you need a separate API key with separate billing.

**Note:** Claude subscriptions have [usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work) that reset on rolling 5-hour and 7-day windows. When exceeded, Opus and Sonnet may return 429 errors while Haiku continues working. You can check your utilization via Claude Code's `/usage` command or [statusline](https://code.claude.com/docs/en/statusline). You can also enable [extra usage](https://support.claude.com/en/articles/12429409-manage-extra-usage-for-paid-claude-plans) in your Anthropic account settings to extend your limits at API rates.

**dario fixes this.** It creates a local proxy that translates API key auth into your subscription's OAuth tokens — transparent to any tool that speaks the Anthropic API.

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

OAuth: healthy (expires in 11h 42m)
Model: passthrough (client decides)
Auth: open (no DARIO_API_KEY set)
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

## Model Selection

Force a specific model for all requests — useful when your tool doesn't let you configure the model:

```bash
dario proxy --model=opus      # Force Opus 4.6
dario proxy --model=sonnet    # Force Sonnet 4.6
dario proxy --model=haiku     # Force Haiku 4.5
dario proxy                   # Passthrough (client decides)
```

Full model IDs also work: `--model=claude-opus-4-6`

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
# OpenClaw
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario openclaw start

# Hermes
# In ~/.hermes/config.yaml, set base_url: http://localhost:3456 for the anthropic provider

# Aider
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario aider --model claude-opus-4-6

# Any tool that uses ANTHROPIC_BASE_URL
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario your-tool-here
```

## How It Works

```
┌──────────┐     ┌─────────────────┐     ┌──────────────────┐
│ Your App │ ──> │  dario (proxy)  │ ──> │ api.anthropic.com│
│          │     │  localhost:3456  │     │                  │
│ sends    │     │  swaps API key  │     │  sees valid      │
│ API key  │     │  for OAuth      │     │  OAuth bearer    │
│ "dario"  │     │  bearer token   │     │  token           │
└──────────┘     └─────────────────┘     └──────────────────┘
```

1. **`dario login`** — Detects your existing Claude Code credentials (`~/.claude/.credentials.json`) and starts the proxy automatically. If Claude Code isn't installed, runs a PKCE OAuth flow with a local callback server to capture the token automatically.

2. **`dario proxy`** — Starts an HTTP server on localhost that implements the Anthropic Messages API. It transparently swaps your API key for an OAuth bearer token on every upstream request.

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

| Flag | Description | Default |
|------|-------------|---------|
| `--model=MODEL` | Force a model (`opus`, `sonnet`, `haiku`, or full ID) | passthrough |
| `--port=PORT` | Port to listen on | `3456` |
| `--verbose` / `-v` | Log every request | off |

Set `DARIO_API_KEY` environment variable to require authentication on all API endpoints (see [Security](#security)).

## Supported Features

- All Claude models (Opus 4.6, Sonnet 4.6, Haiku 4.5)
- **OpenAI-compatible** (`/v1/chat/completions`) — works with any OpenAI SDK or tool
- Streaming and non-streaming (both Anthropic and OpenAI SSE formats)
- Tool use / function calling (full passthrough)
- System prompts and multi-turn conversations
- Extended thinking and prompt caching (pass `anthropic-beta` header to opt in)
- All `anthropic-beta` features (headers merge with required OAuth flag)
- Optional proxy authentication via `DARIO_API_KEY`
- CORS scoped to proxy port (works from browser apps on localhost)

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
| Proxy authentication | Optional `DARIO_API_KEY` env var — when set, all API endpoints require a matching `Authorization: Bearer` or `x-api-key` header. Uses timing-safe comparison. |
| Credential storage | Reads from Claude Code (`~/.claude/.credentials.json`) or its own store (`~/.dario/credentials.json`) with `0600` permissions |
| OAuth flow | PKCE (Proof Key for Code Exchange) — no client secret needed |
| Token transmission | OAuth tokens never leave localhost. Only forwarded to `api.anthropic.com` over HTTPS |
| Network exposure | Proxy binds to `127.0.0.1` only — not accessible from other machines |
| SSRF protection | Hardcoded allowlist of API paths — only `/v1/messages`, `/v1/models`, `/v1/complete` are proxied |
| Token rotation | Refresh tokens rotate on every use (single-use) |
| Error sanitization | API keys, JWTs, and Bearer tokens redacted from all error messages and upstream error responses |
| CORS | Scoped to the proxy's own port (not all of localhost) |
| Data collection | Zero. No telemetry, no analytics, no phoning home |

### Proxy Authentication

By default, any process on localhost can use the proxy. To restrict access:

```bash
export DARIO_API_KEY=your-secret-key
dario proxy
```

Then clients must include the key:

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=your-secret-key  # must match DARIO_API_KEY
```

The `/health` endpoint remains unauthenticated for monitoring. The `/status` endpoint requires authentication when `DARIO_API_KEY` is set.

## FAQ

**Does this violate Anthropic's terms of service?**
Dario uses your existing Claude Code credentials with the same OAuth tokens. It authenticates you as you, with your subscription, through Anthropic's official API. The `--cli` mode literally uses Claude Code itself as the backend.

**What subscription plans work?**
Claude Max and Claude Pro. Any plan that lets you use Claude Code.

**Does it work with Claude Team / Enterprise?**
Should work if your plan includes Claude Code access. Not tested yet — please open an issue with results.

**Do I need Claude Code installed?**
Recommended but not required. If Claude Code is installed and logged in, `dario login` picks up your credentials automatically. Without Claude Code, dario runs its own OAuth flow to authenticate directly.

**What happens when my token expires?**
Dario auto-refreshes tokens 30 minutes before expiry. You should never see an auth error in normal use. If something goes wrong, `dario refresh` forces an immediate refresh.

**I'm getting rate limited on Opus. What do I do?**
Enable [extra usage](https://support.claude.com/en/articles/12429409-manage-extra-usage-for-paid-claude-plans) in your Anthropic account settings to extend your limits at API rates. You can also fall back to `--model=sonnet` or `--model=haiku` which have higher quotas.

**What are the usage limits?**
Claude subscriptions have rolling 5-hour and 7-day usage windows shared across claude.ai and Claude Code. See [Anthropic's docs](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work) for details. In Claude Code, use `/usage` to check your current limits, or configure the [statusline](https://code.claude.com/docs/en/statusline) to show real-time 5h and 7d utilization percentages.

**Can I run this on a server?**
Dario binds to localhost by default. For server use, you'd need to handle the initial login on a machine with a browser, then copy `~/.claude/.credentials.json` (or `~/.dario/credentials.json`) to your server. Auto-refresh will keep it alive from there.

**Why "dario"?**
Named after [Dario Amodei](https://en.wikipedia.org/wiki/Dario_Amodei), CEO of Anthropic.

## Programmatic API

Use dario as a library in your own Node.js app:

```typescript
import { startProxy, getAccessToken, getStatus, sanitizeError } from "@askalf/dario";

// Start the proxy programmatically
await startProxy({ port: 3456, verbose: true });

// Force a specific model
await startProxy({ port: 3456, model: "opus" });

// Or just get a raw access token
const token = await getAccessToken();

// Check token health
const status = await getStatus();
console.log(status.expiresIn); // "11h 42m"

// Redact tokens from error messages
const safe = sanitizeError(someError); // strips API keys, JWTs, Bearer tokens
```

## Trust & Transparency

Dario handles your OAuth tokens. Here's why you can trust it:

| Signal | Status |
|--------|--------|
| **Source code** | ~1100 lines of TypeScript — small enough to read in one sitting |
| **Dependencies** | 1 production dep (`@anthropic-ai/sdk`). Verify: `npm ls --production` |
| **npm provenance** | Every release is [SLSA attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions |
| **Security scanning** | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) runs on every push and weekly |
| **Credential handling** | Tokens never logged, API keys/JWTs/Bearer tokens redacted from all errors, stored with 0600 permissions |
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

## Contributing

PRs welcome. The codebase is ~1,100 lines of TypeScript across 4 files:

| File | Purpose |
|------|---------|
| `src/proxy.ts` | HTTP proxy server, auth gate, error sanitization, streaming relay |
| `src/oauth.ts` | Token storage, refresh logic, Claude Code credential detection, auto OAuth flow |
| `src/cli.ts` | CLI entry point |
| `src/index.ts` | Library exports |

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx (no build needed)
```

## License

MIT
